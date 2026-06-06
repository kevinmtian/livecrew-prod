from __future__ import annotations

import os
import re
from typing import Literal

from pydantic import BaseModel, Field

from backend.models import (
    CommerceState,
    MonitorHook,
    MonitorResponse,
    MonitorScenario,
    MonitorSignalRequest,
    SKU,
)
from backend.openai_client import get_openai_client
from backend.tools.sku_resolver import get_sku_by_id, normalize_text, resolve_sku_from_text


class MonitorOpenAIAnalysis(BaseModel):
    scenario_id: Literal["hesitation", "spike_push", "warm_retention", "cold_warning", "steady"]
    scenario_label: str
    scenario_reason: str
    urgency: Literal["low", "medium", "high"]
    hook_id: Literal["suspense", "order_push", "benefit", "interaction"]
    hook_label: str
    host_cue: str = Field(min_length=1)
    script: str = Field(min_length=1)


def _percent(value: float) -> str:
    return f"{value:.1f}%"


def _currency(cents: int) -> str:
    return f"${cents / 100:.0f}"


def _format_signals(signal: MonitorSignalRequest) -> dict[str, str]:
    top_intent = "none"
    top_intents = "none"
    if signal.intent_distribution:
        sorted_intents = sorted(
            signal.intent_distribution.items(),
            key=lambda item: item[1],
            reverse=True,
        )
        top_intent = sorted_intents[0][0]
        top_intents = ", ".join(
            f"Top{index + 1} {intent.replace('_', ' ')}"
            for index, (intent, count) in enumerate(sorted_intents[:3])
            if count > 0
        ) or "none"
    return {
        "online_viewers": f"{signal.online_viewers:,} ({_percent(signal.online_viewers_delta)})",
        "gpm": f"{_currency(signal.gpm_cents)} ({_percent(signal.gpm_delta)})",
        "conversion_rate": f"{_percent(signal.conversion_rate)} ({_percent(signal.conversion_rate_delta)})",
        "top_chat_intent": top_intent.replace("_", " "),
        "top_chat_intents": top_intents,
        "high_intent_density": f"{signal.high_intent_density:.0f}/min",
        "question_backlog": (
            f"{signal.top_question_count}x {signal.top_question}"
            if signal.top_question and signal.top_question_count > 0
            else "none"
        ),
        "interaction_rate": _percent(signal.interaction_rate),
    }


def _catalogue_prompt(state: CommerceState | None, question: str | None) -> str:
    if state is None:
        return "Catalogue unavailable."

    active_sku = get_sku_by_id(state.active_sku_id, state.skus)
    matched_sku = resolve_sku_from_text(question or "", state.skus)
    related_skus = _related_skus_from_question(question, state.skus, matched_sku)
    sku_lines = [_sku_prompt_line(sku) for sku in state.skus]
    related_lines = [_sku_prompt_line(sku) for sku in related_skus]

    return (
        f"Active SKU: {_sku_prompt_line(active_sku) if active_sku else 'none'}\n"
        f"Exact matched SKU from top question: {_sku_prompt_line(matched_sku) if matched_sku else 'none'}\n"
        "Related alternative candidates from fuzzy catalogue search:\n"
        + ("\n".join(related_lines) if related_lines else "none")
        + "\n"
        "Catalogue:\n"
        + "\n".join(sku_lines)
    )


def _sku_prompt_line(sku: SKU) -> str:
    aliases = ", ".join(sku.aliases)
    facts = " | ".join(sku.facts)
    return (
        f"id={sku.id}; name={sku.name}; aliases={aliases}; "
        f"price=${sku.price_cents / 100:.2f}; stock={sku.stock}; facts={facts}"
    )


def _related_skus_from_question(
    question: str | None,
    skus: list[SKU],
    matched_sku: SKU | None,
) -> list[SKU]:
    if not question:
        return []

    query_tokens = _meaningful_tokens(question)
    if not query_tokens:
        return []

    related: list[tuple[int, SKU]] = []
    for sku in skus:
        if matched_sku and sku.id == matched_sku.id:
            continue

        sku_text = " ".join([sku.name, *sku.aliases, *sku.facts])
        sku_tokens = _meaningful_tokens(sku_text)
        overlap = len(query_tokens & sku_tokens)
        if overlap > 0:
            related.append((overlap, sku))

    related.sort(key=lambda item: (item[0], item[1].stock), reverse=True)
    return [sku for _score, sku in related[:3]]


def _meaningful_tokens(text: str) -> set[str]:
    stopwords = {
        "a",
        "an",
        "and",
        "any",
        "are",
        "available",
        "carry",
        "do",
        "for",
        "have",
        "is",
        "of",
        "the",
        "there",
        "u",
        "we",
        "you",
    }
    normalized = normalize_text(text)
    tokens = set(re.findall(r"[a-z0-9]+", normalized))
    expanded_tokens = set(tokens)
    if "vd" in tokens:
        expanded_tokens.add("vitamin")
    if "vc" in tokens:
        expanded_tokens.add("vitamin")
    return {
        token
        for token in expanded_tokens
        if len(token) >= 2 and token not in stopwords
    }


def _analyze_with_rules(signal: MonitorSignalRequest) -> tuple[MonitorScenario, MonitorHook]:
    if signal.online_viewers_delta >= 12 and signal.conversion_rate < 1:
        scenario = MonitorScenario(
            id="hesitation",
            label="Hesitation spike",
            reason="Viewer count is rising while conversion remains low; create a clear next-step buying cue.",
            urgency="high",
        )
        hook = MonitorHook(
            id="suspense",
            label="Suspense hook",
            script="If you are hesitating, add it to cart first. I will explain the one reason this deal is worth catching before we move on.",
        )
    elif signal.gpm_delta >= 15:
        scenario = MonitorScenario(
            id="spike_push",
            label="Spike push",
            reason="GPM is climbing quickly; use urgency and inventory framing to convert momentum.",
            urgency="high",
        )
        hook = MonitorHook(
            id="order_push",
            label="Order push",
            script="This is the moment to check out if you want it. I am watching the inventory now, and once this round ends we move to the next offer.",
        )
    elif signal.online_viewers_delta < -8:
        scenario = MonitorScenario(
            id="warm_retention",
            label="Retention save",
            reason="Viewer count is dropping; ask a simple question and preview the next benefit.",
            urgency="medium",
        )
        hook = MonitorHook(
            id="benefit",
            label="Benefit hook",
            script="Stay for the next minute. I will show the exact benefit, then you can decide whether this is worth adding to cart.",
        )
    elif signal.high_intent_density >= 3 or signal.top_question_count >= 3:
        scenario = MonitorScenario(
            id="cold_warning",
            label="Unanswered demand",
            reason="High-intent chat or repeated questions are piling up; answer the buying path before continuing.",
            urgency="high",
        )
        hook = MonitorHook(
            id="interaction",
            label="Intent hook",
            script="I see many of you asking how to buy. I will pause here: use the product card below, add it to cart first, and I will answer the top question now.",
        )
    elif signal.interaction_rate < 1:
        scenario = MonitorScenario(
            id="cold_warning",
            label="Cold-room warning",
            reason="Interaction is low; ask viewers to choose the next detail so the room re-engages.",
            urgency="medium",
        )
        hook = MonitorHook(
            id="interaction",
            label="Interaction hook",
            script="Chat is quiet, so help me choose: type 1 for the final price, or 2 if you want to see the product details again.",
        )
    else:
        scenario = MonitorScenario(
            id="steady",
            label="Steady watch",
            reason="No urgent anomaly is visible; keep monitoring conversion and chat intent.",
            urgency="low",
        )
        hook = MonitorHook(
            id="benefit",
            label="Benefit recap",
            script="For anyone just joining, I will quickly recap the offer, the product card, and what to check before you buy.",
        )

    return scenario, hook


def _analyze_with_openai(
    signal: MonitorSignalRequest,
    state: CommerceState | None,
) -> tuple[MonitorScenario, MonitorHook] | None:
    client = get_openai_client()
    if client is None:
        return None

    model = os.getenv("OPENAI_MONITOR_MODEL", "gpt-4o-mini")
    system_prompt = (
        "You are LiveCrew's MonitorAgent for livestream commerce operations. "
        "Use real-time livestream metrics to select the best scene judgment "
        "and generate two concise English outputs for a live host. "
        "host_cue is internal guidance for the host and may mention the audience issue, "
        "risk, or operational next step. script is the suggested line the host can say "
        "directly to viewers. Keep both practical and short. Do not invent coupons, stock, "
        "medical claims, delivery promises, gifts, bundles, or external prices. "
        "Use only the provided catalogue for product names, availability, price, stock, and facts. "
        "If a requested product has a matched SKU, host_cue can tell the host to introduce that "
        "SKU using catalogue facts. If no SKU matches, do not claim the requested product exists; "
        "check the related alternative candidates. If related alternatives exist, host_cue should "
        "tell the host to acknowledge the missing requested item, recommend the best related "
        "catalogue SKU, give a buying reason based only on SKU facts, and create a follow/return "
        "reason for the requested item. If no related alternatives exist, host_cue should only "
        "retain the viewer with a follow/return prompt and must not push an unrelated product. "
        "The script should mirror that cue: with alternatives, recommend the related SKU and why "
        "it is worth considering; without alternatives, invite viewers to follow for future updates. "
        "Promotion status is unknown unless "
        "a promotion is explicitly provided in the catalogue context. Never say there is a promotion, "
        "there is no promotion, there is a discount, or there is no discount unless explicitly shown. "
        "Also never say 'I cannot confirm promotions', 'I can't confirm promotions', or similar "
        "phrases in the script. For discount questions with unknown promotion status, do not discuss "
        "promotion status; pivot to confirmed catalogue price, product facts, and how to buy. "
        "When promotion status is unknown, the script must not contain the words 'confirm', "
        "'promotion', 'promotions', 'discount', or 'discounts'. Use 'value', 'price', and "
        "'product details' instead. "
        "Do not invent coupons, stock, medical claims, delivery promises, gifts, bundles, or external prices. "
        "Common chat intents: ask_price means viewers ask about price, discounts, coupons, "
        "or value; ask_size means size, fit, shade, dimensions, or compatibility; ask_link "
        "means where to buy, cart, checkout, or product card; authenticity_doubt means fake, "
        "real, official, origin, or trust questions; purchase_intent means viewers are ready "
        "to buy or add to cart; ask_product means viewers ask whether a specific product, "
        "ingredient, variant, or category is available, such as 'do u have Vitamin D'. "
        "Prioritize negative/value-comparison signals first. If viewers compare discounts, "
        "value, or other live streams, host_cue must tell the host to address value without "
        "claiming whether promotions exist, and without inventing unconfirmed discounts, gifts, "
        "bundles, or price matches. If there is no "
        "negative/value issue, make the top chat intent drive host_cue. If the top question "
        "mentions a product, host_cue should use the exact catalogue match if available; otherwise "
        "use related alternative candidates if present; otherwise use follow/return guidance only. "
        "The scenario label, reason, and host_cue are internal operator diagnostics. "
        "The script must never reveal negative internal diagnostics such as a cold room, "
        "low excitement, low interaction, low conversion, falling viewer count, hesitation, "
        "or people leaving. Reframe those cases as positive audience prompts: ask a concrete "
        "question, answer the top repeated question, explain how to buy, recap the product card, "
        "or preview the next benefit. Never say phrases like 'the excitement has cooled down', "
        "'the room is cold', 'people are leaving', or 'conversion is low' in the script. "
        "The script should acknowledge the viewer need and give the host a natural line, but "
        "must not mention internal metric names or claim any unconfirmed promotion."
    )
    user_prompt = (
        "Allowed scenario ids: hesitation, spike_push, warm_retention, cold_warning, steady.\n"
        "Allowed hook ids: suspense, order_push, benefit, interaction.\n\n"
        "Chat intent ids may include ask_price, ask_size, ask_link, authenticity_doubt, "
        "purchase_intent, ask_product, and other.\n\n"
        f"Product catalogue context:\n{_catalogue_prompt(state, signal.top_question)}\n\n"
        f"Metrics:\n"
        f"- online_viewers={signal.online_viewers}, delta={signal.online_viewers_delta}%\n"
        f"- gpm_cents={signal.gpm_cents}, gpm_delta={signal.gpm_delta}%\n"
        f"- conversion_rate={signal.conversion_rate}%, conversion_rate_delta={signal.conversion_rate_delta}%\n"
        f"- chat_intent_distribution={signal.intent_distribution}\n"
        f"- high_intent_density={signal.high_intent_density} messages per minute\n"
        f"- repeated_question_backlog={signal.top_question_count} repeats of {signal.top_question or 'none'}\n"
        f"- interaction_rate={signal.interaction_rate}%"
    )

    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            temperature=0.4,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format=MonitorOpenAIAnalysis,
        )
    except Exception:
        return None

    parsed = completion.choices[0].message.parsed
    if parsed is None:
        return None

    return (
        MonitorScenario(
            id=parsed.scenario_id,
            label=parsed.scenario_label,
            reason=parsed.scenario_reason,
            urgency=parsed.urgency,
        ),
        MonitorHook(
            id=parsed.hook_id,
            label=parsed.hook_label,
            host_cue=parsed.host_cue,
            script=parsed.script,
        ),
    )


def analyze_monitor_signals(
    signal: MonitorSignalRequest,
    state: CommerceState | None = None,
) -> MonitorResponse:
    openai_result = _analyze_with_openai(signal, state)
    rule_scenario, rule_hook = _analyze_with_rules(signal)
    scenario, hook = openai_result if openai_result else (rule_scenario, rule_hook)
    signals = _format_signals(signal)
    signals["analysis_source"] = "openai" if openai_result else "rules"

    return MonitorResponse(
        scenario=scenario,
        hook=hook,
        signals=signals,
    )
