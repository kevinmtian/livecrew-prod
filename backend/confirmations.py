from datetime import datetime
from typing import Optional
from uuid import uuid4

from backend.ledger import append_ledger
from backend.models import CommerceState, GuardrailResult, PendingAction, ProposedAction


def add_pending_action(
    state: CommerceState,
    action: ProposedAction,
    guardrail_result: GuardrailResult,
    requested_by: str,
) -> PendingAction:
    pending = PendingAction(
        id="pending-" + str(uuid4()),
        action=action,
        guardrail_result=guardrail_result,
        requested_by=requested_by,
        status="pending",
        created_at=datetime.utcnow(),
    )
    state.pending_actions.append(pending)
    state.metrics.risk_events += 1
    append_ledger(
        state,
        "host_confirmation_requested",
        requested_by,
        guardrail_result.message,
        action.sku_id,
        {"pending_action_id": pending.id, "action": action.model_dump(mode="json")},
    )
    return pending


def find_pending_action(state: CommerceState, pending_action_id: str) -> Optional[PendingAction]:
    return next(
        (
            pending
            for pending in state.pending_actions
            if pending.id == pending_action_id and pending.status == "pending"
        ),
        None,
    )


def reject_pending_action(state: CommerceState, pending_action_id: str) -> PendingAction:
    pending = find_pending_action(state, pending_action_id)
    if not pending:
        raise ValueError("Pending action not found")
    pending.status = "rejected"
    pending.resolved_at = datetime.utcnow()
    append_ledger(
        state,
        "host_confirmation_resolved",
        "host",
        "Host rejected pending action.",
        pending.action.sku_id,
        {"pending_action_id": pending.id, "status": "rejected"},
    )
    return pending


def approve_pending_action(state: CommerceState, pending_action_id: str) -> PendingAction:
    pending = find_pending_action(state, pending_action_id)
    if not pending:
        raise ValueError("Pending action not found")
    pending.status = "approved"
    pending.resolved_at = datetime.utcnow()
    append_ledger(
        state,
        "host_confirmation_resolved",
        "host",
        "Host approved pending action.",
        pending.action.sku_id,
        {"pending_action_id": pending.id, "status": "approved"},
    )
    return pending
