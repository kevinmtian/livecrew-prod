import json
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from backend.config import (
    get_openai_api_key,
    get_openai_base_url,
    get_openai_concierge_model,
    openai_concierge_enabled,
)
from backend.models import AgentDecision, CommerceState, ProposedAction
from backend.tools.quantity_extractor import order_quantity_or_default
from backend.tools.reply_grounder import (
    basic_product_info_reply,
    no_such_product_reply,
    safe_promo_reply,
)
from backend.tools.sku_resolver import resolve_sku_from_text, resolve_with_context


OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"
def analyze_viewer_message_with_openai(
    state: CommerceState,
    text: str,
    viewer: str,
) -> Optional[Tuple[List[AgentDecision], List[ProposedAction]]]:
    if not _openai_enabled():
        return None

    decision = _request_concierge_decision(state, text)
    if not decision:
        return None

    return _decision_to_actions(state, text, viewer, decision)


def _openai_enabled() -> bool:
    return openai_concierge_enabled()


def _request_concierge_decision(
    state: CommerceState,
    text: str,
) -> Optional[Dict[str, Any]]:
    api_key = get_openai_api_key()
    if not api_key:
        return None

    payload = {
        "model": get_openai_concierge_model(),
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are LiveCrew's ConciergeAgent for livestream commerce. "
                    "Classify one viewer message into a structured decision. "
                    "Do not invent discounts, medical guarantees, delivery promises, "
                    "or product facts. Use SKU ids exactly as provided. "
                    "If the viewer asks an irrelevant question, set intent to no_reply. "
                    "If the viewer asks about a product without naming one, use the "
                    "pinned_sku_id when present. If no product can be identified, use "
                    "intent product_question with product_reference none. If the viewer "
                    "mentions a product outside the catalogue, use unknown_product. "
                    "Risky discount, health, symptoms, headache, heart, allergy, "
                    "pregnancy, skin problem, medication, cure, treatment, condition, "
                    "guarantee, delivery, or authenticity questions must use risky_question."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(_agent_context(state, text), separators=(",", ":")),
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "livecrew_concierge_decision",
                "strict": True,
                "schema": _decision_schema(),
            },
        },
    }
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        get_openai_base_url(OPENAI_CHAT_COMPLETIONS_URL),
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError):
        return None

    try:
        content = body["choices"][0]["message"]["content"]
        return json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return None


def _agent_context(state: CommerceState, text: str) -> Dict[str, Any]:
    return {
        "viewer_message": text,
        "pinned_sku_id": state.active_sku_id,
        "products": [
            {
                "id": sku.id,
                "name": sku.name,
                "aliases": sku.aliases,
                "current_price_cents": sku.current_price_cents,
                "stock": sku.stock,
                "facts": sku.facts,
            }
            for sku in state.skus
        ],
        "flash_sale": state.flash_sale.model_dump(mode="json")
        if state.flash_sale
        else None,
    }


def _decision_schema() -> Dict[str, Any]:
    sku_ids = [
        "glowfix-vitamin-c-serum",
        "hydramist-cushion-spf",
        "bamboo-thermal-tumbler",
        "satin-cloud-sleep-mask",
    ]
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "intent": {
                "type": "string",
                "enum": [
                    "no_reply",
                    "product_question",
                    "promo_request",
                    "risky_question",
                    "unknown_product",
                    "order_request",
                    "other",
                ],
            },
            "product_reference": {
                "type": "string",
                "enum": ["explicit_known", "explicit_unknown", "pinned", "none"],
            },
            "sku_id": {"type": ["string", "null"], "enum": sku_ids + [None]},
            "unknown_product_name": {"type": ["string", "null"]},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "risk_reason": {"type": ["string", "null"]},
            "evidence": {"type": "array", "items": {"type": "string"}},
        },
        "required": [
            "intent",
            "product_reference",
            "sku_id",
            "unknown_product_name",
            "confidence",
            "risk_reason",
            "evidence",
        ],
    }


def _decision_to_actions(
    state: CommerceState,
    text: str,
    viewer: str,
    decision: Dict[str, Any],
) -> Optional[Tuple[List[AgentDecision], List[ProposedAction]]]:
    intent = str(decision.get("intent") or "other")
    confidence = _bounded_confidence(decision.get("confidence"))
    evidence = _string_list(decision.get("evidence")) or ["openai concierge decision"]
    sku_id = _trusted_sku_id(state, text, decision)
    decisions = [
        AgentDecision(
            agent="concierge",
            intent=f"openai_{intent}",
            confidence=confidence,
            reason="OpenAI Concierge classified the viewer message into a structured decision.",
            evidence=evidence,
        )
    ]

    if intent == "no_reply":
        return decisions, [
            ProposedAction(
                type="noop",
                source_text=text,
                confidence=confidence,
                reason="OpenAI Concierge classified this viewer message as irrelevant to the livestream commerce flow.",
                evidence=evidence,
            )
        ]

    if intent == "unknown_product":
        product_name = str(decision.get("unknown_product_name") or "that product")
        return decisions, [
            ProposedAction(
                type="suggest_reply",
                sku_id=None,
                reply_text=no_such_product_reply(product_name),
                source_text=text,
                confidence=confidence,
                reason="OpenAI Concierge found an explicit product mention outside the seeded catalogue.",
                evidence=evidence,
            )
        ]

    if intent == "risky_question":
        reply_text = (
            "Based on our policy, I can only share verified product facts and approved "
            "promos. I will ask the host to review this before replying."
        )
        return decisions, [
            ProposedAction(
                type="suggest_reply",
                sku_id=sku_id,
                reply_text=reply_text,
                source_text=text,
                confidence=confidence,
                reason=decision.get("risk_reason") or "OpenAI Concierge classified this as a risky viewer question.",
                evidence=evidence,
                requires_host_confirmation=True,
            )
        ]

    if intent == "promo_request":
        return decisions, [
            ProposedAction(
                type="suggest_reply",
                sku_id=sku_id,
                reply_text=safe_promo_reply(state, sku_id),
                source_text=text,
                confidence=confidence,
                reason="OpenAI Concierge classified this as a promotion request; reply is grounded in backend promo state.",
                evidence=evidence,
                requires_host_confirmation=state.flash_sale is None,
            )
        ]

    if intent == "order_request":
        quantity = order_quantity_or_default(text)
        if sku_id and quantity:
            return decisions, [
                ProposedAction(
                    type="create_order",
                    sku_id=sku_id,
                    quantity=quantity,
                    source_text=text,
                    confidence=confidence,
                    reason="OpenAI Concierge classified this as an order request; SKU and quantity were resolved by deterministic helpers.",
                    evidence=evidence + [str(quantity)],
                )
            ]
        return decisions, [
            ProposedAction(
                type="request_host_confirmation",
                sku_id=sku_id,
                quantity=quantity,
                source_text=text,
                confidence=min(confidence, 0.6),
                reason="OpenAI Concierge detected order intent, but deterministic SKU or quantity resolution was incomplete.",
                evidence=evidence,
                requires_host_confirmation=True,
            )
        ]

    if intent == "product_question":
        if not sku_id:
            return decisions, [
                ProposedAction(
                    type="suggest_reply",
                    sku_id=None,
                    reply_text="Which product are you referring to?",
                    source_text=text,
                    confidence=confidence,
                    reason="OpenAI Concierge found a product question but no product could be identified.",
                    evidence=evidence,
                )
            ]

        return decisions, [
            ProposedAction(
                type="suggest_reply",
                sku_id=sku_id,
                reply_text=basic_product_info_reply(state, sku_id, text),
                source_text=text,
                confidence=confidence,
                reason="OpenAI Concierge classified this as a product question; reply uses backend product data.",
                evidence=evidence,
            )
        ]

    return None


def _trusted_sku_id(
    state: CommerceState,
    text: str,
    decision: Dict[str, Any],
) -> Optional[str]:
    explicit = resolve_sku_from_text(text, state.skus)
    if explicit.sku_id:
        return explicit.sku_id

    contextual = resolve_with_context(text, state.skus, state.active_sku_id)
    if contextual.sku_id:
        return contextual.sku_id

    candidate = decision.get("sku_id")
    if candidate and any(sku.id == candidate for sku in state.skus):
        return str(candidate)

    return state.active_sku_id


def _bounded_confidence(value: Any) -> float:
    if isinstance(value, (int, float)):
        return min(1.0, max(0.0, float(value)))
    return 0.7


def _string_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, (str, int, float))]
