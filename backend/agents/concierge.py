from __future__ import annotations

import os
import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from backend.models import AgentDecision, CommerceState, ProposedAction
from backend.openai_client import get_openai_client
from backend.tools.quantity_extractor import extract_order_quantity, has_order_intent
from backend.tools.sku_resolver import get_sku_by_id, resolve_sku_from_text


ViewerIntent = Literal[
    "product_facts",
    "promo_request",
    "order",
    "skin_safety",
    "comparison",
    "product_clarification",
    "ambiguous",
    "malicious",
    "off_topic",
]


class ExtractedViewerMessage(BaseModel):
    intent: ViewerIntent
    sku_id: str | None = None
    quantity: int | None = None
    confidence: float = Field(ge=0, le=1)
    reason: str
    evidence: list[str] = Field(default_factory=list)
    draft_reply: str | None = None


PROMO_RE = re.compile(
    r"\b(discount|promo|promotion|deal|voucher|coupon|off|free|bundle|cheaper|best price)\b|%\s*off",
    re.IGNORECASE,
)
UNSAFE_RE = re.compile(
    r"\b(cure|treat|heal|fix acne|remove acne|acne|medical|doctor|guarantee|guaranteed|authentic|delivery|shipping|arrive|health|allergy|allergic|rash|irritation|heart|pregnan(?:t|cy)|sensitive skin|skin health)\b",
    re.IGNORECASE,
)
MALICIOUS_RE = re.compile(r"\b(ignore instructions|jailbreak|system prompt|developer message)\b", re.IGNORECASE)
COMPARISON_RE = re.compile(r"\b(compare|better than|versus|vs\.?|difference)\b", re.IGNORECASE)
CLARIFICATION_RE = re.compile(r"\b(which|what product|what is this|this one|it)\b", re.IGNORECASE)
PRODUCT_QUESTION_RE = re.compile(
    r"\b(price|cost|how much|stock|left|available|size|big|capacity|ml|spf|morning|night|routine|use|refill|finish|strap|light|hot|cold|product|item|current|pinned)\b",
    re.IGNORECASE,
)


def _catalogue_prompt(state: CommerceState) -> str:
    lines = []
    for sku in state.skus:
        lines.append(
            f"- id={sku.id}; name={sku.name}; aliases={', '.join(sku.aliases)}; "
            f"price_cents={sku.price_cents}; stock={sku.stock}; facts={'; '.join(sku.facts)}"
        )
    return "\n".join(lines)


def _extract_with_openai(text: str, state: CommerceState) -> ExtractedViewerMessage | None:
    client = get_openai_client()
    if client is None:
        return None

    model = os.getenv("OPENAI_CONCIERGE_MODEL", "gpt-4o-mini")
    active_sku = get_sku_by_id(state.active_sku_id, state.skus)
    flash_sale = state.flash_sale.model_dump(mode="json") if state.flash_sale else None
    system_prompt = (
        "You are LiveCrew's ConciergeAgent. Classify a viewer livestream commerce "
        "message into one intent and draft only safe, grounded service language. "
        "Use only SKU ids from the catalogue. Do not invent discounts, delivery "
        "promises, authenticity claims, medical guarantees, or unsupported product claims. "
        "If the viewer asks for unsupported or risky claims, classify the risk and say "
        "that host confirmation is needed or that only current verified terms can be used."
    )
    user_prompt = (
        f"Active SKU: {active_sku.name if active_sku else 'none'} ({state.active_sku_id or 'none'})\n"
        f"Flash sale: {flash_sale}\n"
        f"Catalogue:\n{_catalogue_prompt(state)}\n\n"
        f"Viewer message:\n{text}"
    )

    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format=ExtractedViewerMessage,
        )
    except Exception:
        return None

    return completion.choices[0].message.parsed


def _current_price_text(sku_id: str, state: CommerceState) -> str:
    sku = get_sku_by_id(sku_id, state.skus)
    if not sku:
        return "the current backend price"

    if state.flash_sale and state.flash_sale.sku_id == sku_id and state.flash_sale.remaining_stock > 0:
        return (
            f"${state.flash_sale.sale_price_cents / 100:.2f} during the active flash sale "
            f"while {state.flash_sale.remaining_stock} sale units remain; regular live price "
            f"is ${sku.price_cents / 100:.2f}"
        )

    return f"${sku.price_cents / 100:.2f}"


STOPWORDS = {
    "the",
    "and",
    "for",
    "this",
    "that",
    "with",
    "what",
    "which",
    "product",
    "item",
    "does",
    "have",
    "good",
}


def _grounded_product_reply(text: str, sku_id: str, state: CommerceState) -> tuple[str, list[str]]:
    sku = get_sku_by_id(sku_id, state.skus)
    if not sku:
        return (
            "I need the host to confirm which product you mean before I answer.",
            [],
        )

    lower_text = text.lower()
    evidence = [sku.name]
    reply_parts: list[str] = []

    if any(term in lower_text for term in {"price", "cost", "how much"}):
        reply_parts.append(f"{sku.name} is currently {_current_price_text(sku.id, state)}.")
        evidence.append(f"price={sku.price_cents}")

    if any(term in lower_text for term in {"stock", "left", "available"}):
        reply_parts.append(f"There are {sku.stock} left in backend stock.")
        evidence.append(f"stock={sku.stock}")

    query_tokens = [
        token
        for token in re.findall(r"[a-z0-9]+", lower_text)
        if len(token) > 2 and token not in STOPWORDS
    ]
    matched_facts = [
        fact
        for fact in sku.facts
        if any(token in fact.lower() for token in query_tokens)
    ]
    if matched_facts:
        reply_parts.append(f"Verified product facts: {_join_facts(matched_facts)}.")
        evidence.extend(matched_facts)

    asks_general_product = bool(PRODUCT_QUESTION_RE.search(text)) or bool(
        re.search(r"\b(what product|what is this|which product)\b", text, re.IGNORECASE)
    )
    if not reply_parts and asks_general_product:
        facts = sku.facts[:3]
        reply_parts.append(
            f"{sku.name} is {_join_facts(facts)}. Current price is "
            f"{_current_price_text(sku.id, state)}, with {sku.stock} left."
        )
        evidence.extend([*facts, f"stock={sku.stock}", f"price={sku.price_cents}"])

    if not reply_parts:
        return (
            f"I cannot verify that detail for {sku.name} from the current product facts.",
            [sku.name, "unverified product detail"],
        )

    return " ".join(reply_parts), evidence


def _join_facts(facts: list[str]) -> str:
    if not facts:
        return "listed in the current catalogue"
    if len(facts) == 1:
        return facts[0]
    return f"{', '.join(facts[:-1])}, and {facts[-1]}"


def _promo_reply(sku_id: str | None, state: CommerceState) -> tuple[str, list[str]]:
    if sku_id:
        sku = get_sku_by_id(sku_id, state.skus)
    else:
        sku = get_sku_by_id(state.active_sku_id, state.skus)

    if sku and state.flash_sale and state.flash_sale.sku_id == sku.id and state.flash_sale.remaining_stock > 0:
        reply = (
            f"The verified deal for {sku.name} is ${state.flash_sale.sale_price_cents / 100:.2f} "
            f"for the active flash sale, with {state.flash_sale.remaining_stock} sale units left. "
            "I cannot add any unannounced discount."
        )
        return reply, [sku.name, "active flash sale", f"remaining={state.flash_sale.remaining_stock}"]

    if sku:
        reply = (
            f"I can confirm {sku.name} is currently {_current_price_text(sku.id, state)}. "
            "There is no verified extra discount in the backend state right now."
        )
        return reply, [sku.name, "no active verified promotion"]

    return (
        "I do not have a verified promotion for that request. The host should confirm any discount before it is offered.",
        ["unsupported promotion request"],
    )


def _safe_risk_reply(text: str, sku_id: str | None, state: CommerceState) -> tuple[str, list[str]]:
    sku = get_sku_by_id(sku_id, state.skus) if sku_id else get_sku_by_id(state.active_sku_id, state.skus)
    if re.search(
        r"\b(acne|cure|treat|heal|medical|health|allergy|allergic|rash|irritation|heart|pregnan(?:t|cy)|sensitive skin|skin health)\b",
        text,
        re.IGNORECASE,
    ):
        name = sku.name if sku else "this product"
        return (
            f"I cannot verify health, allergy, or medical suitability for {name}. I can only share listed product facts, "
            "and the host should decide whether to respond.",
            ["health or medical claim escalated"],
        )

    return (
        "I need the host to confirm that claim before sharing it with viewers.",
        ["unsupported claim escalated"],
    )


def _resolve_context_sku(text: str, state: CommerceState, extracted_sku_id: str | None) -> tuple[str | None, list[str]]:
    explicit_sku = resolve_sku_from_text(text, state.skus)
    if explicit_sku:
        return explicit_sku.id, [explicit_sku.name]

    if state.active_sku_id:
        active_sku = get_sku_by_id(state.active_sku_id, state.skus)
        if active_sku:
            return active_sku.id, [active_sku.name, "active SKU context"]

    if extracted_sku_id and get_sku_by_id(extracted_sku_id, state.skus):
        return extracted_sku_id, [extracted_sku_id]

    return None, []


def _classify_deterministic(text: str, state: CommerceState) -> ExtractedViewerMessage:
    if MALICIOUS_RE.search(text):
        intent: ViewerIntent = "malicious"
        confidence = 0.92
        reason = "Viewer message attempted to manipulate system instructions."
    elif UNSAFE_RE.search(text):
        intent = "skin_safety"
        confidence = 0.86
        reason = "Viewer asked for an unsafe or unsupported claim."
    elif PROMO_RE.search(text):
        intent = "promo_request"
        confidence = 0.84
        reason = "Viewer asked about discount or promotion terms."
    elif has_order_intent(text):
        intent = "order"
        confidence = 0.86
        reason = "Viewer used clear order language."
    elif COMPARISON_RE.search(text):
        intent = "comparison"
        confidence = 0.78
        reason = "Viewer asked for a product comparison."
    elif CLARIFICATION_RE.search(text):
        intent = "product_clarification"
        confidence = 0.72
        reason = "Viewer used contextual product language."
    elif len(text.strip()) < 4:
        intent = "ambiguous"
        confidence = 0.45
        reason = "Viewer message was too short to classify."
    elif PRODUCT_QUESTION_RE.search(text) or resolve_sku_from_text(text, state.skus):
        intent = "product_facts"
        confidence = 0.74
        reason = "Viewer asked a routine product question."
    else:
        intent = "off_topic"
        confidence = 0.72
        reason = "Viewer message is not related to the live commerce catalogue."

    return ExtractedViewerMessage(
        intent=intent,
        quantity=extract_order_quantity(text),
        confidence=confidence,
        reason=reason,
        evidence=[text],
    )


def _has_commerce_relevance(text: str, state: CommerceState) -> bool:
    return any(
        (
            bool(resolve_sku_from_text(text, state.skus)),
            bool(PRODUCT_QUESTION_RE.search(text)),
            bool(PROMO_RE.search(text)),
            bool(UNSAFE_RE.search(text)),
            bool(COMPARISON_RE.search(text)),
            bool(CLARIFICATION_RE.search(text)),
            has_order_intent(text),
        )
    )


def _build_actions(
    text: str,
    viewer: str,
    state: CommerceState,
    extracted: ExtractedViewerMessage,
) -> list[ProposedAction]:
    sku_id, sku_evidence = _resolve_context_sku(text, state, extracted.sku_id)
    evidence = [*sku_evidence, *extracted.evidence]
    actions: list[ProposedAction] = []

    if extracted.intent == "malicious":
        return []

    if extracted.intent in {"ambiguous", "off_topic"}:
        return []

    if extracted.intent in {"skin_safety", "promo_request"}:
        reply, reply_evidence = (
            _promo_reply(sku_id, state)
            if extracted.intent == "promo_request"
            else _safe_risk_reply(text, sku_id, state)
        )
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=sku_id,
                source_text=text,
                input_source="viewer_message",
                reply_text=reply,
                viewer=viewer,
                confidence=0.88,
                reason=(
                    "Discount and promotion request needs host approval."
                    if extracted.intent == "promo_request"
                    else "Health, allergy, or safety request needs host approval."
                ),
                evidence=[*evidence, *reply_evidence],
                requires_host_confirmation=True,
            )
        )
        return actions

    if extracted.intent == "order":
        quantity = extracted.quantity or extract_order_quantity(text)
        if sku_id and quantity:
            sku = get_sku_by_id(sku_id, state.skus)
            if sku and quantity > sku.stock:
                actions.append(
                    ProposedAction(
                        type="request_host_confirmation",
                        sku_id=sku_id,
                        source_text=text,
                        input_source="viewer_message",
                        reply_text=(
                            f"{viewer} asked for {quantity} x {sku.name}, but only "
                            f"{sku.stock} are currently in backend stock."
                        ),
                        viewer=viewer,
                        confidence=0.78,
                        reason="Order quantity exceeds current backend stock.",
                        evidence=[*evidence, f"quantity={quantity}", f"stock={sku.stock}"],
                        requires_host_confirmation=True,
                    )
                )
                return actions

            actions.append(
                ProposedAction(
                    type="create_order",
                    sku_id=sku_id,
                    quantity=quantity,
                    source_text=text,
                    input_source="viewer_message",
                    viewer=viewer,
                    confidence=0.9,
                    reason="Viewer used clear order intent with a grounded SKU.",
                    evidence=[*evidence, f"quantity={quantity}"],
                )
            )
            if sku:
                if PROMO_RE.search(text) or UNSAFE_RE.search(text):
                    reply, reply_evidence = (
                        _promo_reply(sku_id, state)
                        if PROMO_RE.search(text)
                        else _safe_risk_reply(text, sku_id, state)
                    )
                    reply = (
                        f"I recorded {quantity} x {sku.name}. {reply}"
                    )
                    actions.append(
                        ProposedAction(
                            type="suggest_reply",
                            sku_id=sku_id,
                            source_text=text,
                            input_source="viewer_message",
                            reply_text=reply,
                            viewer=viewer,
                            confidence=0.86,
                            reason="Mixed order and risky viewer request needs host approval.",
                            evidence=[sku.name, f"quantity={quantity}", *reply_evidence],
                            requires_host_confirmation=True,
                        )
                    )
                    return actions

                actions.append(
                    ProposedAction(
                        type="suggest_reply",
                        sku_id=sku_id,
                        source_text=text,
                        input_source="viewer_message",
                        reply_text=(
                            f"Noted {quantity} x {sku.name} for {viewer} at the backend price "
                            f"that applies when the order is recorded."
                        ),
                        viewer=viewer,
                        confidence=0.86,
                        reason="Confirm the recorded order without inventing payment or delivery details.",
                        evidence=[sku.name, f"quantity={quantity}"],
                    )
                )
            return actions

        actions.append(
            ProposedAction(
                type="request_host_confirmation",
                sku_id=sku_id,
                source_text=text,
                input_source="viewer_message",
                reply_text="Order intent needs a grounded SKU and quantity before it can be recorded.",
                viewer=viewer,
                confidence=0.62,
                reason="Order was ambiguous.",
                evidence=evidence,
                requires_host_confirmation=True,
            )
        )
        return actions

    if extracted.intent == "comparison":
        sku = get_sku_by_id(sku_id, state.skus) if sku_id else None
        if not sku:
            return []
        reply = (
            f"I can compare only listed catalogue facts. For {sku.name}, the grounded facts are: "
            f"{'; '.join(sku.facts)}."
        )
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=sku_id,
                source_text=text,
                input_source="viewer_message",
                reply_text=reply,
                viewer=viewer,
                confidence=0.76,
                reason="Handle comparison request without inventing superiority claims.",
                evidence=evidence + (sku.facts if sku else []),
            )
        )
        return actions

    if not sku_id:
        return []

    reply, reply_evidence = _grounded_product_reply(text, sku_id, state)
    actions.append(
        ProposedAction(
            type="suggest_reply",
            sku_id=sku_id,
            source_text=text,
            input_source="viewer_message",
            reply_text=reply,
            viewer=viewer,
            confidence=max(extracted.confidence, 0.78),
            reason="Answer from SKU facts, stock, price, and active promotion state.",
            evidence=[*evidence, *reply_evidence],
        )
    )
    return actions


def analyze_viewer_message(
    text: str,
    viewer: str,
    state: CommerceState,
) -> tuple[AgentDecision, list[ProposedAction]]:
    try:
        extracted = _extract_with_openai(text, state)
        if extracted is None:
            extracted = _classify_deterministic(text, state)
    except (ValidationError, ValueError):
        extracted = _classify_deterministic(text, state)

    if not _has_commerce_relevance(text, state):
        extracted = ExtractedViewerMessage(
            intent="off_topic",
            confidence=0.9,
            reason="Viewer message is not related to the live commerce catalogue.",
            evidence=[text],
        )

    actions = _build_actions(text, viewer, state, extracted)
    decision = AgentDecision(
        agent="ConciergeAgent",
        summary=f"Classified viewer message as {extracted.intent} and proposed {len(actions)} action(s).",
        confidence=max((action.confidence for action in actions), default=extracted.confidence),
        source_text=text,
    )
    return decision, actions
