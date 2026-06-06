from typing import List

from backend.models import AgentDecision, CommerceState, ProposedAction
from backend.tools.quantity_extractor import (
    extract_quantity,
    has_order_intent,
    order_quantity_or_default,
)
from backend.tools.reply_grounder import grounded_product_reply, safe_promo_reply
from backend.tools.sku_resolver import resolve_with_context


PROMO_TERMS = ["discount", "promo", "promotion", "deal", "cheaper", "50%", "half off"]
SAFETY_TERMS = ["cure", "acne", "medical", "guarantee", "authentic", "delivery", "free shipping"]
QUESTION_TERMS = ["?", "is", "how", "what", "can", "will", "does", "size", "big", "morning", "night"]


def analyze_viewer_message(
    state: CommerceState,
    text: str,
    viewer: str,
) -> tuple[List[AgentDecision], List[ProposedAction]]:
    lowered = text.lower()
    resolution = resolve_with_context(text, state.skus, state.active_sku_id)
    raw_quantity = extract_quantity(text)
    quantity = order_quantity_or_default(text)
    promo_request = any(term in lowered for term in PROMO_TERMS)
    safety_request = any(term in lowered for term in SAFETY_TERMS)
    resolved_sku_id = resolution.sku_id
    resolution_evidence = list(resolution.evidence)
    decisions: List[AgentDecision] = []
    actions: List[ProposedAction] = []

    if has_order_intent(text) and not (
        (promo_request or safety_request) and raw_quantity is None
    ):
        if not resolved_sku_id and state.active_sku_id:
            resolved_sku_id = state.active_sku_id
            resolution_evidence.append("active SKU context")

        if resolved_sku_id and quantity:
            actions.append(
                ProposedAction(
                    type="create_order",
                    sku_id=resolved_sku_id,
                    quantity=quantity,
                    source_text=text,
                    confidence=0.86 if not resolution.used_active_context else 0.76,
                    reason=f"{viewer} used clear order language and quantity was resolved.",
                    evidence=resolution_evidence + [str(quantity)],
                )
            )
            decisions.append(
                AgentDecision(
                    agent="concierge",
                    intent="create_order",
                    confidence=0.86,
                    reason="Detected viewer order intent with quantity.",
                    evidence=resolution_evidence + [str(quantity)],
                )
            )
        else:
            actions.append(
                ProposedAction(
                    type="request_host_confirmation",
                    sku_id=resolution.sku_id,
                    quantity=quantity,
                    source_text=text,
                    confidence=0.52,
                    reason="Viewer order is missing SKU context or quantity.",
                    evidence=resolution.evidence,
                    requires_host_confirmation=True,
                )
            )

    if promo_request:
        actions.append(
            ProposedAction(
                type="suggest_reply",
                sku_id=resolution.sku_id,
                reply_text=safe_promo_reply(state, resolution.sku_id),
                source_text=text,
                confidence=0.78,
                reason="Viewer asked about a promotion; reply cites only verified backend promo state.",
                evidence=resolution.evidence,
                requires_host_confirmation=state.flash_sale is None,
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="promo_request",
                confidence=0.78,
                reason="Detected promotion request and avoided inventing a discount.",
                evidence=resolution.evidence,
            )
        )

    if safety_request:
        actions.append(
            ProposedAction(
                type="request_host_confirmation",
                sku_id=resolution.sku_id,
                source_text=text,
                confidence=0.7,
                reason="Viewer asked for an unsupported safety, authenticity, delivery, or medical claim.",
                evidence=[term for term in SAFETY_TERMS if term in lowered],
                requires_host_confirmation=True,
            )
        )

    is_question = any(term in lowered for term in QUESTION_TERMS)
    if is_question and not any(term in lowered for term in PROMO_TERMS + SAFETY_TERMS):
        if has_order_intent(text):
            pass
        elif resolution.sku_id:
            actions.append(
                ProposedAction(
                    type="suggest_reply",
                    sku_id=resolution.sku_id,
                    reply_text=grounded_product_reply(state, resolution.sku_id),
                    source_text=text,
                    confidence=0.84 if not resolution.used_active_context else 0.74,
                    reason="Viewer asked a product question that can be answered from grounded facts.",
                    evidence=resolution.evidence,
                )
            )
            decisions.append(
                AgentDecision(
                    agent="concierge",
                    intent="product_fact",
                    confidence=0.84,
                    reason="Resolved product question to grounded catalogue facts.",
                    evidence=resolution.evidence,
                )
            )
        else:
            actions.append(
                ProposedAction(
                    type="request_host_confirmation",
                    source_text=text,
                    confidence=0.5,
                    reason="Viewer question is missing product context.",
                    evidence=[],
                    requires_host_confirmation=True,
                )
            )

    if not actions:
        actions.append(
            ProposedAction(
                type="noop",
                source_text=text,
                confidence=0.65,
                reason="Viewer message did not match a supported commerce or product-help intent.",
            )
        )
        decisions.append(
            AgentDecision(
                agent="concierge",
                intent="noop",
                confidence=0.65,
                reason="No supported viewer action was detected.",
                evidence=[],
            )
        )

    return decisions, actions
