from copy import deepcopy
from threading import RLock

from backend.data.catalogue import fresh_catalogue
from backend.models import CommerceMetrics, CommerceState


_lock = RLock()
_state = CommerceState(
    active_sku_id=None,
    skus=fresh_catalogue(),
    flash_sale=None,
    orders=[],
    announcements=[],
    pending_actions=[],
    ledger=[],
    metrics=CommerceMetrics(),
)


def get_state() -> CommerceState:
    with _lock:
        return deepcopy(_state)


def mutate_state(callback):
    with _lock:
        result = callback(_state)
        return deepcopy(result if result is not None else _state)


def reset_state() -> CommerceState:
    def reset(current: CommerceState) -> CommerceState:
        current.active_sku_id = None
        current.skus = fresh_catalogue()
        current.flash_sale = None
        current.orders = []
        current.announcements = []
        current.pending_actions = []
        current.ledger = []
        current.metrics = CommerceMetrics()
        return current

    return mutate_state(reset)


def replace_state(next_state: CommerceState) -> CommerceState:
    def replace(current: CommerceState) -> CommerceState:
        current.active_sku_id = next_state.active_sku_id
        current.skus = deepcopy(next_state.skus)
        current.flash_sale = deepcopy(next_state.flash_sale)
        current.orders = deepcopy(next_state.orders)
        current.announcements = deepcopy(next_state.announcements)
        current.pending_actions = deepcopy(next_state.pending_actions)
        current.ledger = deepcopy(next_state.ledger)
        current.metrics = deepcopy(next_state.metrics)
        return current

    return mutate_state(replace)
