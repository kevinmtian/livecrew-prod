from __future__ import annotations

import os
import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from backend.models import AgentDecision, CommerceState, ProposedAction
from backend.openai_client import get_openai_client
from backend.tools.sku_resolver import get_sku_by_id, resolve_sku_from_text


class ExtractedViewerReply(BaseModel):
    intent: Literal[
        "product_fact",
        "price_stock",
        "promo_request",
        "order_interest",
        "safety_claim",
        "ambiguous",
        "off_topic",
    ]
    sku_id: str | None = None
    reply_text: str
    confidence: float = Field(ge=0, le=1)
    reason: str
    evidence: list[str] = Field(default_factory=list)
    requires_host_confirmation: bool = False


UNSAFE_TERMS = {
    "cure",
    "medical",
    "acne",
    "eczema",
    "allergy",
    "guarantee",
    "authentic",
    "delivery",
    "shipping",
}
PROMO_TERMS = {
    "discount",
    "coupon",
    "cheaper",
    "50%",
    "free",
    "deal",
    "promo",
    "voucher",
}
ORDER_TERMS = {"buy", "order", "take", "want", "cart", "checkout"}


def _format_price(price_cents: int) -> str:
    return f"${price_cents / 100:.2f}"


def _sku_context(state: CommerceState) -> str:
    lines = []
    for sku in state.skus:
        facts = " | ".join(sku.facts)
        lines.append(
            f"- id={sku.id}; name={sku.name}; price={_format_price(sku.price_cents)}; "
            f"stock={sku.stock}; facts={facts}; aliases={', '.join(sku.aliases)}"
        )
    return "\n".join(lines)


def _commerce_context(state: CommerceState, sku_id: str | None) -> str:
    sku = get_sku_by_id(sku_id, state.skus)
    if not sku:
        return "No grounded SKU is available."

    sale = state.flash_sale
    sale_text = "No active flash sale for this SKU."
    if sale and sale.sku_id == sku.id:
        sale_text = (
            f"Active flash sale: {_format_price(sale.sale_price_cents)}, "
            f"{sale.remaining_stock}/{sale.stock_limit} units remaining."
        )

    return (
        f"{sku.name}: {_format_price(sku.price_cents)}, {sku.stock} in stock. "
        f"Facts: {'; '.join(sku.facts)}. {sale_text}"
    )


def _extract_with_openai(
    text: str,
    viewer: str,
    state: CommerceState,
) -> ExtractedViewerReply | None:
    client = get_openai_client()
    if client is None:
        return None

    model = os.getenv("OPENAI_CONCIERGE_MODEL", "gpt-4o-mini")
    active_sku = get_sku_by_id(state.active_sku_id, state.skus)
    system_prompt = (
        "You are LiveCrew's ConciergeAgent for livestream commerce. Draft one "
        "short host-ready reply to a viewer message. Resolve explicit product "
        "mentions first, then use the active SKU for contextual phrasing like "
        "'this one'. Use only the provided catalogue facts, current price, stock, "
        "and flash-sale state. Do not invent discounts, delivery promises, "
        "authenticity claims, medical guarantees, or unsupported product claims. "
        "For unsupported discount or safety claims, politely say what is confirmed "
        "and that the host can confirm anything beyond that."
    )
    user_prompt = (
        f"Viewer: {viewer}\n"
        f"Active SKU: {active_sku.name if active_sku else 'none'} "
        f"({state.active_sku_id or 'none'})\n"
        f"Catalogue and commerce state:\n{_sku_context(state)}\n\n"
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
            response_format=ExtractedViewerReply,
        )
    except Exception:
        return None

    return completion.choices[0].message.parsed


def _safe_discount_reply(state: CommerceState, sku_id: str | None) -> str:
    sku = get_sku_by_id(sku_id, state.skus)
    if not sku:
        return "I can check with the host on promotions; I do not want to promise an unconfirmed discount."

    sale = state.flash_sale
    if sale and sale.sku_id == sku.id:
        return (
            f"The confirmed flash sale for {sku.name} is {_format_price(sale.sale_price_cents)} "
            f"while the sale stock lasts. I cannot promise any extra unconfirmed discount."
        )

    return (
        f"{sku.name} is currently {_format_price(sku.price_cents)} with {sku.stock} in stock. "
        "I cannot promise an unconfirmed discount, but the host can confirm any live promo."
    )


def _deterministic_reply(
    text: str,
    state: CommerceState,
) -> ExtractedViewerReply:
    normalized = text.lower()
    mentioned_sku = resolve_sku_from_text(text, state.skus)
    sku = mentioned_sku or get_sku_by_id(state.active_sku_id, state.skus)
    sku_id = sku.id if sku else None

    has_promo_request = any(term in normalized for term in PROMO_TERMS)
    has_unsafe_request = any(term in normalized for term in UNSAFE_TERMS)
    has_order_interest = any(
        re.search(rf"\b{re.escape(term)}\b", normalized) for term in ORDER_TERMS
    )

    if has_promo_request:
        return ExtractedViewerReply(
            intent="promo_request",
            sku_id=sku_id,
            reply_text=_safe_discount_reply(state, sku_id),
            confidence=0.86,
            reason="Viewer asked about a promotion or discount.",
            evidence=["current price", "confirmed promotion state"],
        )

    if has_unsafe_request:
        reply = (
            "I can share the listed product facts, but I cannot make medical, "
            "delivery, or authenticity guarantees in chat. The host can confirm "
            "anything beyond the product card."
        )
        if sku:
            reply = (
                f"For {sku.name}, the confirmed facts are: {'; '.join(sku.facts[:2])}. "
                "I cannot make medical, delivery, or authenticity guarantees in chat."
            )
        return ExtractedViewerReply(
            intent="safety_claim",
            sku_id=sku_id,
            reply_text=reply,
            confidence=0.8,
            reason="Viewer asked for a claim that needs safe wording.",
            evidence=sku.facts[:2] if sku else [],
            requires_host_confirmation=False,
        )

    if has_order_interest:
        reply = (
            f"Got it. {sku.name} is {_format_price(sku.price_cents)} and {sku.stock} are in stock. "
            "The host can confirm the order details live."
            if sku
            else "Got it. The host can confirm which product and quantity you want."
        )
        return ExtractedViewerReply(
            intent="order_interest",
            sku_id=sku_id,
            reply_text=reply,
            confidence=0.78,
            reason="Viewer appears interested in ordering.",
            evidence=[sku.name] if sku else [],
            requires_host_confirmation=True,
        )

    if sku:
        return ExtractedViewerReply(
            intent="product_fact",
            sku_id=sku.id,
            reply_text=(
                f"{sku.name} is {_format_price(sku.price_cents)} with {sku.stock} in stock. "
                f"Confirmed facts: {'; '.join(sku.facts[:2])}."
            ),
            confidence=0.82,
            reason="Answered with active or explicitly mentioned SKU facts.",
            evidence=[sku.name, *sku.facts[:2]],
        )

    return ExtractedViewerReply(
        intent="ambiguous",
        sku_id=None,
        reply_text="Can you clarify which product you mean? The host can point you to the right item.",
        confidence=0.5,
        reason="No grounded SKU was available.",
        evidence=[],
        requires_host_confirmation=True,
    )


def _to_action(
    extracted: ExtractedViewerReply,
    text: str,
    state: CommerceState,
) -> ProposedAction:
    valid_sku_ids = {sku.id for sku in state.skus}
    sku_id = extracted.sku_id if extracted.sku_id in valid_sku_ids else None
    if not sku_id and extracted.sku_id:
        return ProposedAction(
            type="noop",
            source_text=text,
            input_source="viewer_message",
            confidence=0.35,
            reason=f"ConciergeAgent proposed unknown SKU id: {extracted.sku_id}.",
            evidence=extracted.evidence,
        )

    return ProposedAction(
        type="suggest_reply",
        source_text=text,
        input_source="viewer_message",
        sku_id=sku_id,
        reply_text=extracted.reply_text,
        confidence=extracted.confidence,
        reason=extracted.reason,
        evidence=extracted.evidence,
        requires_host_confirmation=extracted.requires_host_confirmation,
    )


def analyze_viewer_message(
    text: str,
    viewer: str,
    state: CommerceState,
) -> tuple[AgentDecision, list[ProposedAction], str | None]:
    try:
        extracted = _extract_with_openai(text, viewer, state)
        if extracted is not None:
            action = _to_action(extracted, text, state)
            decision = AgentDecision(
                agent="ConciergeAgent",
                summary=f"Drafted viewer reply for {extracted.intent} using OpenAI.",
                confidence=action.confidence,
                source_text=text,
            )
            return decision, [action], extracted.intent
    except (ValidationError, ValueError):
        pass

    extracted = _deterministic_reply(text, state)
    action = _to_action(extracted, text, state)
    decision = AgentDecision(
        agent="ConciergeAgent",
        summary=f"Drafted viewer reply for {extracted.intent} using deterministic fallback.",
        confidence=action.confidence,
        source_text=text,
    )
    return decision, [action], extracted.intent
