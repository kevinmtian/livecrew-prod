from __future__ import annotations

from typing import Any

try:
    from .actions import make_proposed_action
    from .text import resolve_sku_from_text
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from agents.actions import make_proposed_action
    from agents.text import resolve_sku_from_text


def analyze_host_transcript(text: str) -> dict[str, Any]:
    sku_id = resolve_sku_from_text(text)
    proposed_actions = []

    if sku_id:
        proposed_actions.append(
            make_proposed_action(
                "set_active_sku",
                text,
                0.82,
                sku_id=sku_id,
                reason="Host transcript mentioned a catalogue SKU.",
            )
        )

    return {
        "agent_decisions": [
            {
                "owner": "cohost",
                "intent": "set_active_sku" if sku_id else "no_action",
                "confidence": 0.82 if sku_id else 0.0,
                "reason": "Host transcript mentioned a catalogue SKU." if sku_id else "No catalogue SKU detected.",
                "evidence": [text],
            }
        ],
        "proposed_actions": proposed_actions,
        "guardrail_results": [],
        "pending_actions": [],
        "applied_actions": [],
        "ledger_entries": [],
        "suggested_reply": None,
        "report": None,
        "state": None,
    }
