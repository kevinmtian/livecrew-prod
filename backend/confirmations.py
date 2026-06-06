from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException

try:
    from .commerce import place_order
    from .ledger import append_event
    from .state import commerce_state, now_iso
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from commerce import place_order
    from ledger import append_event
    from state import commerce_state, now_iso


def create_pending_action(
    action: dict[str, Any],
    guardrail_result: dict[str, Any],
    requested_by: str,
) -> dict[str, Any]:
    pending_action = {
        "id": str(uuid4()),
        "action": action,
        "guardrail_result": guardrail_result,
        "requested_by": requested_by,
        "status": "pending",
        "created_at": now_iso(),
    }
    commerce_state["pending_actions"].append(pending_action)
    append_event(
        "host_confirmation_requested",
        {
            "pending_action_id": pending_action["id"],
            "action_type": action["type"],
            "reason": guardrail_result["reason"],
            "risk_level": guardrail_result["risk_level"],
        },
    )
    return pending_action


def get_pending_action(pending_action_id: str) -> dict[str, Any]:
    for pending_action in commerce_state["pending_actions"]:
        if pending_action["id"] == pending_action_id:
            return pending_action

    raise HTTPException(status_code=404, detail=f"Unknown pending action: {pending_action_id}")


def approve_pending_action_by_id(
    pending_action_id: str,
    note: Optional[str] = None,
) -> dict[str, Any]:
    pending_action = get_pending_action(pending_action_id)
    if pending_action["status"] != "pending":
        raise HTTPException(status_code=400, detail="Pending action is already resolved")

    action = pending_action["action"]
    applied_actions = []

    if action["type"] == "create_order" and action.get("sku_id") and action.get("quantity"):
        order = place_order(action["sku_id"], action["quantity"], "host_approved")
        applied_actions.append(
            {
                "id": str(uuid4()),
                "action": action,
                "result": order,
                "created_at": now_iso(),
            }
        )

    pending_action["status"] = "approved"
    ledger_entry = append_event(
        "host_confirmation_resolved",
        {
            "pending_action_id": pending_action_id,
            "resolution": "approved",
            "action_type": action["type"],
            "note": note,
        },
    )

    return {
        "agent_decisions": [],
        "proposed_actions": [action],
        "guardrail_results": [pending_action["guardrail_result"]],
        "pending_actions": [pending_action],
        "applied_actions": applied_actions,
        "ledger_entries": [ledger_entry],
        "suggested_reply": None,
        "report": None,
        "state": commerce_state,
    }


def reject_pending_action_by_id(
    pending_action_id: str,
    note: Optional[str] = None,
) -> dict[str, Any]:
    pending_action = get_pending_action(pending_action_id)
    if pending_action["status"] != "pending":
        raise HTTPException(status_code=400, detail="Pending action is already resolved")

    pending_action["status"] = "rejected"
    ledger_entry = append_event(
        "host_confirmation_resolved",
        {
            "pending_action_id": pending_action_id,
            "resolution": "rejected",
            "action_type": pending_action["action"]["type"],
            "note": note,
        },
    )

    return {
        "agent_decisions": [],
        "proposed_actions": [pending_action["action"]],
        "guardrail_results": [pending_action["guardrail_result"]],
        "pending_actions": [pending_action],
        "applied_actions": [],
        "ledger_entries": [ledger_entry],
        "suggested_reply": None,
        "report": None,
        "state": commerce_state,
    }
