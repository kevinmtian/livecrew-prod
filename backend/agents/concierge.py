from __future__ import annotations

from typing import Any

try:
    from ..commerce import require_sku
    from ..confirmations import create_pending_action
    from ..ledger import append_event
    from ..state import commerce_state
    from .actions import make_proposed_action
    from .guardrails import (
        allow_grounded_reply,
        ask_for_clarification,
        block_malicious_request,
        evaluate_order,
        review_promo_request,
        review_skin_safety_claim,
    )
    from .text import classify_viewer_intent, extract_quantity, resolve_sku_from_text
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from agents.actions import make_proposed_action
    from agents.guardrails import (
        allow_grounded_reply,
        ask_for_clarification,
        block_malicious_request,
        evaluate_order,
        review_promo_request,
        review_skin_safety_claim,
    )
    from agents.text import classify_viewer_intent, extract_quantity, resolve_sku_from_text
    from commerce import require_sku
    from confirmations import create_pending_action
    from ledger import append_event
    from state import commerce_state


def analyze_viewer_message(viewer: str, text: str) -> dict[str, Any]:
    intent = classify_viewer_intent(text)
    sku_id = resolve_sku_from_text(text)
    proposed_actions = []
    guardrail_results = []
    pending_actions = []
    ledger_entries = []
    suggested_reply = None

    if intent == "malicious":
        action = make_proposed_action(
            "noop",
            text,
            0.96,
            reason="Viewer asked the agent to ignore policy or promise an unsupported offer.",
        )
        guardrail = block_malicious_request()
        proposed_actions.append(action)
        guardrail_results.append(guardrail)
        pending_actions.append(create_pending_action(action, guardrail, "guardrail"))
        ledger_entries.append(
            append_event(
                "guardrail_block",
                {
                    "viewer": viewer,
                    "text": text,
                    "reason": guardrail["reason"],
                    "blocked_claims": guardrail["blocked_claims"],
                },
            )
        )
    elif intent == "skin_safety":
        action = make_proposed_action(
            "request_host_confirmation",
            text,
            0.9,
            sku_id=sku_id,
            reason="Skin or medical claim requires host review.",
        )
        guardrail = review_skin_safety_claim()
        proposed_actions.append(action)
        guardrail_results.append(guardrail)
        pending_actions.append(create_pending_action(action, guardrail, "concierge"))
        ledger_entries.append(
            append_event(
                "host_escalation",
                {
                    "viewer": viewer,
                    "text": text,
                    "sku_id": sku_id,
                    "reason": guardrail["reason"],
                    "blocked_claims": guardrail["blocked_claims"],
                },
            )
        )
    elif intent == "promo_request":
        action = make_proposed_action(
            "request_host_confirmation",
            text,
            0.86,
            sku_id=sku_id,
            reason="Promotion requests need host confirmation.",
        )
        guardrail = review_promo_request(bool(sku_id))
        proposed_actions.append(action)
        guardrail_results.append(guardrail)
        pending_actions.append(create_pending_action(action, guardrail, "concierge"))
        ledger_entries.append(
            append_event(
                "host_escalation",
                {
                    "viewer": viewer,
                    "text": text,
                    "sku_id": sku_id,
                    "reason": guardrail["reason"],
                    "blocked_claims": guardrail["blocked_claims"],
                },
            )
        )
    elif intent == "order":
        quantity = extract_quantity(text)
        action = make_proposed_action(
            "create_order",
            text,
            0.88 if sku_id else 0.64,
            sku_id=sku_id,
            quantity=quantity,
            reason="Order intent was detected from viewer language.",
            requires_host_confirmation=not bool(sku_id),
        )
        guardrail = evaluate_order(bool(sku_id))
        proposed_actions.append(action)
        guardrail_results.append(guardrail)
        if not sku_id:
            pending_actions.append(create_pending_action(action, guardrail, "concierge"))
            suggested_reply = "Which product would you like to order?"
    elif intent == "product_fact" and sku_id:
        sku = require_sku(sku_id)
        suggested_reply = f"{sku['name']} is currently {sku['current_price']} with {sku['stock']} in stock."
        action = make_proposed_action(
            "suggest_reply",
            text,
            0.88,
            sku_id=sku_id,
            reply_text=suggested_reply,
            reason="Grounded reply uses current backend price and stock.",
        )
        guardrail = allow_grounded_reply()
        proposed_actions.append(action)
        guardrail_results.append(guardrail)
        ledger_entries.append(
            append_event(
                "answer_suggested",
                {
                    "viewer": viewer,
                    "text": text,
                    "sku_id": sku_id,
                    "reply_text": suggested_reply,
                },
            )
        )
    else:
        action = make_proposed_action(
            "request_host_confirmation",
            text,
            0.58,
            sku_id=sku_id,
            reason="Viewer message is ambiguous or missing product context.",
        )
        guardrail = ask_for_clarification()
        proposed_actions.append(action)
        guardrail_results.append(guardrail)
        pending_actions.append(create_pending_action(action, guardrail, "concierge"))
        suggested_reply = "Which product should I check for you?"

    return {
        "agent_decisions": [
            {
                "owner": "concierge",
                "intent": intent,
                "confidence": proposed_actions[0]["confidence"] if proposed_actions else 0.0,
                "reason": proposed_actions[0].get("reason") if proposed_actions else "No action proposed.",
                "evidence": [text],
            }
        ],
        "proposed_actions": proposed_actions,
        "guardrail_results": guardrail_results,
        "pending_actions": pending_actions,
        "applied_actions": [],
        "ledger_entries": ledger_entries,
        "suggested_reply": suggested_reply,
        "report": None,
        "state": commerce_state,
    }
