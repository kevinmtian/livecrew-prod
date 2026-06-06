from __future__ import annotations

import os
import re
from collections import Counter
from datetime import timedelta

from pydantic import BaseModel, Field, ValidationError

from backend.models import (
    CommerceState,
    ViewerComment,
    ViewerInsightMetric,
    ViewerInsightSnapshot,
    WordCloudTerm,
    utc_now,
)
from backend.openai_client import get_openai_client
from backend.tools.sku_resolver import get_sku_by_id


class ExtractedViewerInsights(BaseModel):
    terms: list[WordCloudTerm] = Field(default_factory=list)
    summary: str
    suggested_replies: list[str] = Field(default_factory=list)


STOPWORDS = {
    "about",
    "after",
    "again",
    "also",
    "and",
    "any",
    "are",
    "can",
    "could",
    "does",
    "for",
    "from",
    "get",
    "has",
    "have",
    "how",
    "into",
    "is",
    "it",
    "its",
    "just",
    "like",
    "me",
    "more",
    "much",
    "need",
    "of",
    "on",
    "one",
    "or",
    "please",
    "price",
    "show",
    "that",
    "the",
    "this",
    "to",
    "want",
    "what",
    "when",
    "with",
    "you",
}
INTENT_TERMS = {
    "discount": 3,
    "coupon": 3,
    "promo": 3,
    "deal": 3,
    "stock": 2,
    "buy": 2,
    "order": 2,
    "size": 2,
    "spf": 2,
    "shipping": 2,
    "delivery": 2,
    "safe": 2,
    "allergy": 2,
}
INTENT_LABELS = {
    "create_order": "Orders",
    "suggest_reply": "Product questions",
    "product_facts": "Product facts",
    "promo_request": "Promo requests",
    "order": "Orders",
    "skin_safety": "Safety questions",
    "comparison": "Comparisons",
    "product_clarification": "Clarifications",
    "ambiguous": "Needs context",
    "malicious": "Risk checks",
    "off_topic": "Off topic",
    "blocked": "Blocked risks",
    "needs_host": "Needs host",
    "none": "General chat",
}
NON_VIEWER_SENDER_NAMES = {
    "agent",
    "ai",
    "co-host",
    "cohost",
    "concierge",
    "host",
    "livecrew",
    "livecrew agent",
    "system",
}


def _format_price(price_cents: int) -> str:
    return f"${price_cents / 100:.2f}"


def _is_viewer_authored_comment(comment: ViewerComment) -> bool:
    return comment.viewer.strip().casefold() not in NON_VIEWER_SENDER_NAMES


def _recent_comments(
    state: CommerceState,
    window_seconds: int,
) -> tuple[list[ViewerComment], object, object]:
    ended_at = utc_now()
    started_at = ended_at - timedelta(seconds=window_seconds)
    comments = [
        comment
        for comment in state.viewer_comments
        if comment.created_at >= started_at and comment.created_at <= ended_at
        and _is_viewer_authored_comment(comment)
    ]
    comments.sort(key=lambda comment: comment.created_at)
    return comments, started_at, ended_at


def _tokenize(text: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[a-z0-9][a-z0-9+%.-]{1,}", text.lower())
        if token not in STOPWORDS and len(token) > 2
    ]


def _deterministic_terms(
    comments: list[ViewerComment],
    state: CommerceState,
) -> list[WordCloudTerm]:
    counter: Counter[str] = Counter()
    aliases: dict[str, str] = {}
    for sku in state.skus:
        aliases[sku.name.lower()] = sku.name
        for alias in sku.aliases:
            aliases[alias.lower()] = sku.name

    for comment in comments:
        normalized = comment.text.lower()
        for alias, display_name in aliases.items():
            if alias in normalized:
                counter[display_name] += 3
        for token in _tokenize(comment.text):
            counter[token] += INTENT_TERMS.get(token, 1)
        if comment.intent:
            counter[comment.intent.replace("_", " ")] += 2

    if not counter:
        return []

    max_count = max(counter.values())
    terms = []
    for text, count in counter.most_common(18):
        weight = max(1, min(10, round((count / max_count) * 10)))
        terms.append(WordCloudTerm(text=text, count=count, weight=weight))
    return terms


def _comment_intent_label(comment: ViewerComment) -> str:
    if comment.reply_status == "blocked":
        return INTENT_LABELS["blocked"]
    if comment.reply_status == "needs_host":
        return INTENT_LABELS["needs_host"]
    if comment.intent:
        return INTENT_LABELS.get(comment.intent, comment.intent.replace("_", " ").title())
    return INTENT_LABELS["none"]


def _intent_breakdown(comments: list[ViewerComment]) -> list[ViewerInsightMetric]:
    counter = Counter(_comment_intent_label(comment) for comment in comments)
    if not counter:
        return []

    max_count = max(counter.values())
    return [
        ViewerInsightMetric(
            label=label,
            count=count,
            weight=max(1, min(10, round((count / max_count) * 10))),
        )
        for label, count in counter.most_common(8)
    ]


def _deterministic_summary(
    comments: list[ViewerComment],
    state: CommerceState,
    terms: list[WordCloudTerm],
) -> tuple[str, list[str]]:
    active_sku = get_sku_by_id(state.active_sku_id, state.skus)
    if not comments:
        sku_text = active_sku.name if active_sku else "the active product"
        return (
            f"No viewer comments in the last three minutes for {sku_text}.",
            [],
        )

    top_terms = ", ".join(term.text for term in terms[:4]) or "general product questions"
    sku_text = active_sku.name if active_sku else "the active product"
    summary = (
        f"{len(comments)} recent comment(s) are clustering around {top_terms} "
        f"while {sku_text} is on shelf."
    )
    suggestions = []
    if active_sku:
        sale = state.flash_sale
        sale_text = ""
        if sale and sale.sku_id == active_sku.id:
            sale_text = f" Flash sale is {_format_price(sale.sale_price_cents)} while stock lasts."
        suggestions.append(
            f"Recap {active_sku.name}: {_format_price(active_sku.price_cents)}, "
            f"{active_sku.stock} in stock. {'; '.join(active_sku.facts[:2])}.{sale_text}"
        )
    if any(term.text in {"discount", "coupon", "promo", "deal"} for term in terms):
        suggestions.append(
            "Clarify that only confirmed live prices or flash sales are available; do not promise extra discounts."
        )
    if any(term.text in {"shipping", "delivery", "safe", "allergy"} for term in terms):
        suggestions.append(
            "Route delivery, authenticity, allergy, or medical questions to host confirmation."
        )
    return summary, suggestions[:3]


def _openai_insights(
    comments: list[ViewerComment],
    state: CommerceState,
) -> ExtractedViewerInsights | None:
    client = get_openai_client()
    if client is None or not comments:
        return None

    model = os.getenv("OPENAI_VIEWER_INSIGHTS_MODEL", "gpt-4o-mini")
    active_sku = get_sku_by_id(state.active_sku_id, state.skus)
    comment_lines = "\n".join(
        f"- {comment.viewer}: {comment.text}" for comment in comments[-40:]
    )
    sku_context = "\n".join(
        f"- {sku.name}: {_format_price(sku.price_cents)}, {sku.stock} stock, facts: {'; '.join(sku.facts)}"
        for sku in state.skus
    )
    system_prompt = (
        "You summarize livestream commerce viewer comments for a host. Return a "
        "compact weighted word cloud and grounded host talking points. Terms must "
        "be short noun phrases from viewer demand, product names, or commerce "
        "intent. Suggested replies must use only provided SKU facts, price, stock, "
        "and flash-sale information. Do not invent discounts, shipping promises, "
        "authenticity claims, or medical guarantees."
    )
    user_prompt = (
        f"Active SKU: {active_sku.name if active_sku else 'none'}\n"
        f"Catalogue:\n{sku_context}\n\n"
        f"Recent viewer comments:\n{comment_lines}"
    )

    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format=ExtractedViewerInsights,
        )
    except Exception:
        return None

    parsed = completion.choices[0].message.parsed
    if not parsed or not parsed.terms:
        return None
    return parsed


def generate_viewer_word_cloud(
    state: CommerceState,
    window_seconds: int = 180,
) -> ViewerInsightSnapshot:
    comments, started_at, ended_at = _recent_comments(state, window_seconds)
    try:
        extracted = _openai_insights(comments, state)
    except (ValidationError, ValueError):
        extracted = None

    if extracted:
        terms = extracted.terms[:18]
        summary = extracted.summary
        suggested_replies = extracted.suggested_replies[:3]
    else:
        terms = _deterministic_terms(comments, state)
        summary, suggested_replies = _deterministic_summary(comments, state, terms)
    intent_breakdown = _intent_breakdown(comments)

    return ViewerInsightSnapshot(
        window_started_at=started_at,
        window_ended_at=ended_at,
        active_sku_id=state.active_sku_id,
        comment_count=len(comments),
        terms=terms,
        intent_breakdown=intent_breakdown,
        summary=summary,
        suggested_replies=suggested_replies,
        source_comment_ids=[comment.id for comment in comments],
    )
