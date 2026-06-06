from datetime import datetime
from typing import Any, Dict, Optional
from uuid import uuid4

from backend.models import CommerceState, LedgerEntry


def append_ledger(
    state: CommerceState,
    event_type: str,
    actor: str,
    message: str,
    sku_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> LedgerEntry:
    entry = LedgerEntry(
        id="ledger-" + str(uuid4()),
        type=event_type,
        actor=actor,
        sku_id=sku_id,
        message=message,
        payload=payload or {},
        created_at=datetime.utcnow(),
    )
    state.ledger.append(entry)
    return entry
