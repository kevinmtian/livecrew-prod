from typing import List, Optional

from backend.agents.cohost import analyze_host_transcript
from backend.agents.concierge import analyze_viewer_message
from backend.agents.producer import generate_report
from backend.commerce import apply_action
from backend.confirmations import (
    add_pending_action,
    approve_pending_action,
    edit_pending_reply_action,
    reject_pending_action,
)
from backend.ledger import append_ledger
from backend.models import (
    AgentDecision,
    AppliedAction,
    CommerceState,
    GuardrailResult,
    ProposedAction,
    WorkflowResponse,
)
from backend.policies.guardrails import validate_action
from backend.state import get_state, mutate_state, reset_state


def _empty_response(state: CommerceState) -> WorkflowResponse:
    return WorkflowResponse(state=state)


def _process_actions(
    state: CommerceState,
    actions: List[ProposedAction],
    *,
    actor: str,
    requested_by: str,
    decisions: Optional[List[AgentDecision]] = None,
    approved_by_host: bool = False,
) -> WorkflowResponse:
    guardrail_results: List[GuardrailResult] = []
    pending_actions = []
    applied_actions: List[AppliedAction] = []
    ledger_entries = []
    suggested_reply = None

    for action in actions:
        before_ledger_count = len(state.ledger)
        result = validate_action(state, action, approved_by_host=approved_by_host)
        guardrail_results.append(result)

        if result.decision == "block":
            state.metrics.risk_events += 1
            append_ledger(
                state,
                "guardrail_block",
                "guardrail",
                result.message,
                action.sku_id,
                {"action": action.model_dump(mode="json"), "reasons": result.reasons},
            )
        elif result.decision == "confirm":
            pending_actions.append(add_pending_action(state, action, result, requested_by))
        else:
            applied, _ = apply_action(state, action, actor=actor)
            if applied:
                applied_actions.append(applied)
                if applied.type == "suggest_reply":
                    suggested_reply = action.reply_text

        ledger_entries.extend(state.ledger[before_ledger_count:])

    return WorkflowResponse(
        agent_decisions=decisions or [],
        proposed_actions=actions,
        guardrail_results=guardrail_results,
        pending_actions=pending_actions,
        applied_actions=applied_actions,
        ledger_entries=ledger_entries,
        suggested_reply=suggested_reply,
        state=state,
    )


def handle_host_transcript(text: str) -> WorkflowResponse:
    def run(state: CommerceState) -> WorkflowResponse:
        decisions, actions = analyze_host_transcript(state, text)
        return _process_actions(
            state,
            actions,
            actor="cohost",
            requested_by="cohost",
            decisions=decisions,
        )

    return mutate_state(run)


def handle_viewer_message(text: str, viewer: str) -> WorkflowResponse:
    def run(state: CommerceState) -> WorkflowResponse:
        decisions, actions = analyze_viewer_message(state, text, viewer)
        return _process_actions(
            state,
            actions,
            actor=f"viewer:{viewer}",
            requested_by="concierge",
            decisions=decisions,
        )

    return mutate_state(run)


def handle_direct_action(action: ProposedAction, *, actor: str = "host_ui") -> WorkflowResponse:
    def run(state: CommerceState) -> WorkflowResponse:
        return _process_actions(
            state,
            [action],
            actor=actor,
            requested_by="host_ui",
            decisions=[],
            approved_by_host=actor == "host",
        )

    return mutate_state(run)


def approve_action(pending_action_id: str, reply_text: Optional[str] = None) -> WorkflowResponse:
    def run(state: CommerceState) -> WorkflowResponse:
        before_ledger_count = len(state.ledger)
        if reply_text is not None:
            edit_pending_reply_action(state, pending_action_id, reply_text)
        pending = approve_pending_action(state, pending_action_id)
        response = _process_actions(
            state,
            [pending.action],
            actor="host",
            requested_by="host_ui",
            decisions=[],
            approved_by_host=True,
        )
        response.ledger_entries = state.ledger[before_ledger_count:]
        response.pending_actions = [pending]
        response.state = state
        return response

    return mutate_state(run)


def reject_action(pending_action_id: str) -> WorkflowResponse:
    def run(state: CommerceState) -> WorkflowResponse:
        before_ledger_count = len(state.ledger)
        pending = reject_pending_action(state, pending_action_id)
        return WorkflowResponse(
            pending_actions=[pending],
            ledger_entries=state.ledger[before_ledger_count:],
            state=state,
        )

    return mutate_state(run)


def generate_producer_report() -> WorkflowResponse:
    def run(state: CommerceState) -> WorkflowResponse:
        before_ledger_count = len(state.ledger)
        report = generate_report(state)
        return WorkflowResponse(
            report=report,
            ledger_entries=state.ledger[before_ledger_count:],
            state=state,
        )

    return mutate_state(run)


def reset_workflow() -> WorkflowResponse:
    state = reset_state()
    return _empty_response(state)


def state_response() -> WorkflowResponse:
    return _empty_response(get_state())
