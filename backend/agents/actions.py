from __future__ import annotations

from typing import Any, Optional


def make_proposed_action(
    action_type: str,
    source_text: str,
    confidence: float,
    **payload: Any,
) -> dict[str, Any]:
    return {
        "type": action_type,
        "source_text": source_text,
        "confidence": confidence,
        "evidence": [],
        "requires_host_confirmation": False,
        **payload,
    }


def make_guardrail_result(
    action_type: str,
    decision: str,
    risk_level: str,
    allowed: bool,
    reason: str,
    blocked_claims: Optional[list[str]] = None,
) -> dict[str, Any]:
    return {
        "action_type": action_type,
        "decision": decision,
        "risk_level": risk_level,
        "allowed": allowed,
        "blocked_claims": blocked_claims or [],
        "reason": reason,
    }
