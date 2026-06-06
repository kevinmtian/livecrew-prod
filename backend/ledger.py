from __future__ import annotations

from typing import Any
from uuid import uuid4

try:
    from .state import commerce_state, now_iso
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from state import commerce_state, now_iso


def append_event(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    event = {
        "id": str(uuid4()),
        "ts": now_iso(),
        "action": action,
        **payload,
    }
    commerce_state["event_ledger"].append(event)
    return event
