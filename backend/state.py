from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any


DEFAULT_ACTIVE_SKU_ID = "sku-glowfix-vitamin-c-serum"


DEFAULT_SKUS: dict[str, dict[str, Any]] = {
    "sku-glowfix-vitamin-c-serum": {
        "id": "sku-glowfix-vitamin-c-serum",
        "name": "GlowFix Vitamin C Serum",
        "current_price": "S$29.90",
        "stock": 118,
    },
    "sku-hydramist-cushion-spf": {
        "id": "sku-hydramist-cushion-spf",
        "name": "HydraMist Cushion SPF",
        "current_price": "S$36.00",
        "stock": 92,
    },
    "sku-bamboo-thermal-tumbler": {
        "id": "sku-bamboo-thermal-tumbler",
        "name": "Bamboo Thermal Tumbler",
        "current_price": "S$24.50",
        "stock": 164,
    },
    "sku-satin-cloud-sleep-mask": {
        "id": "sku-satin-cloud-sleep-mask",
        "name": "Satin Cloud Sleep Mask",
        "current_price": "S$18.80",
        "stock": 246,
    },
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_initial_state() -> dict[str, Any]:
    return {
        "active_sku_id": DEFAULT_ACTIVE_SKU_ID,
        "skus": deepcopy(DEFAULT_SKUS),
        "flash_sale": None,
        "orders": [],
        "announcements": [],
        "pending_actions": [],
        "event_ledger": [],
    }


def make_reset_state() -> dict[str, Any]:
    state = make_initial_state()
    state["active_sku_id"] = None
    return state


commerce_state = make_initial_state()


def reset_commerce_state() -> dict[str, Any]:
    commerce_state.clear()
    commerce_state.update(make_reset_state())
    return commerce_state
