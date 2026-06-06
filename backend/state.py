from __future__ import annotations

from copy import deepcopy
from threading import Lock

from backend.data.catalogue import SEED_CATALOGUE
from backend.models import CommerceState, LedgerEntry, utc_now


class CommerceStore:
    def __init__(self) -> None:
        self._lock = Lock()
        self._state = self._create_default_state()

    def _create_default_state(self) -> CommerceState:
        return CommerceState(
            active_sku_id=None,
            skus=deepcopy(SEED_CATALOGUE),
            ledger=[
                LedgerEntry(
                    type="backend_ready",
                    detail="Python FastAPI + LangGraph backend initialized with an empty product shelf.",
                )
            ],
        )

    def get(self) -> CommerceState:
        with self._lock:
            return self._state.model_copy(deep=True)

    def replace(self, state: CommerceState) -> CommerceState:
        with self._lock:
            state.updated_at = utc_now()
            self._state = state.model_copy(deep=True)
            return self._state.model_copy(deep=True)

    def reset(self) -> CommerceState:
        with self._lock:
            self._state = self._create_default_state()
            return self._state.model_copy(deep=True)


commerce_store = CommerceStore()
