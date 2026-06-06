from __future__ import annotations

from typing import TypedDict

from langgraph.graph import END, StateGraph

from backend.agents.cohost import analyze_host_text
from backend.commerce import apply_action
from backend.models import (
    AgentDecision,
    AppliedAction,
    CommerceState,
    GuardrailResult,
    InputSource,
    LedgerEntry,
    ProposedAction,
    WorkflowResponse,
)
from backend.policies.guardrails import validate_action
from backend.state import commerce_store


class LiveCrewGraphState(TypedDict):
    text: str
    input_source: InputSource
    commerce_state: CommerceState
    agent_decisions: list[AgentDecision]
    proposed_actions: list[ProposedAction]
    guardrail_results: list[GuardrailResult]
    applied_actions: list[AppliedAction]
    ledger_entries: list[LedgerEntry]


def cohost_node(graph_state: LiveCrewGraphState) -> LiveCrewGraphState:
    decision, actions = analyze_host_text(
        graph_state["text"],
        graph_state["commerce_state"],
        graph_state["input_source"],
    )
    graph_state["agent_decisions"] = [decision]
    graph_state["proposed_actions"] = actions
    return graph_state


def guardrail_node(graph_state: LiveCrewGraphState) -> LiveCrewGraphState:
    graph_state["guardrail_results"] = [
        validate_action(action, graph_state["commerce_state"])
        for action in graph_state["proposed_actions"]
    ]
    return graph_state


def commerce_node(graph_state: LiveCrewGraphState) -> LiveCrewGraphState:
    state = graph_state["commerce_state"].model_copy(deep=True)
    applied_actions: list[AppliedAction] = []
    ledger_entries: list[LedgerEntry] = []

    for action, guardrail in zip(
        graph_state["proposed_actions"],
        graph_state["guardrail_results"],
        strict=False,
    ):
        applied, ledger_entry = apply_action(action, guardrail, state)
        if applied:
            applied_actions.append(applied)
        ledger_entries.append(ledger_entry)

    state.ledger = [*ledger_entries, *state.ledger][:200]
    graph_state["commerce_state"] = commerce_store.replace(state)
    graph_state["applied_actions"] = applied_actions
    graph_state["ledger_entries"] = ledger_entries
    return graph_state


def build_graph():
    graph = StateGraph(LiveCrewGraphState)
    graph.add_node("cohost_agent_node", cohost_node)
    graph.add_node("guardrail_node", guardrail_node)
    graph.add_node("commerce_apply_node", commerce_node)
    graph.set_entry_point("cohost_agent_node")
    graph.add_edge("cohost_agent_node", "guardrail_node")
    graph.add_edge("guardrail_node", "commerce_apply_node")
    graph.add_edge("commerce_apply_node", END)
    return graph.compile()


livecrew_graph = build_graph()


def run_cohost_workflow(text: str, input_source: InputSource) -> WorkflowResponse:
    result = livecrew_graph.invoke(
        {
            "text": text,
            "input_source": input_source,
            "commerce_state": commerce_store.get(),
            "agent_decisions": [],
            "proposed_actions": [],
            "guardrail_results": [],
            "applied_actions": [],
            "ledger_entries": [],
        }
    )
    return WorkflowResponse(
        agent_decisions=result["agent_decisions"],
        proposed_actions=result["proposed_actions"],
        guardrail_results=result["guardrail_results"],
        pending_actions=result["commerce_state"].pending_actions,
        applied_actions=result["applied_actions"],
        ledger_entries=result["ledger_entries"],
        state=result["commerce_state"],
    )
