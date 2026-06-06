from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4


SkuId = str


INITIAL_SKUS: Dict[SkuId, Dict[str, Any]] = {
    "glowfix-vitamin-c-serum": {
        "id": "glowfix-vitamin-c-serum",
        "name": "GlowFix Vitamin C Serum",
        "current_price": 24.00,
        "stock": 42,
    },
    "hydramist-cushion-spf": {
        "id": "hydramist-cushion-spf",
        "name": "HydraMist Cushion SPF",
        "current_price": 31.00,
        "stock": 28,
    },
    "bamboo-thermal-tumbler": {
        "id": "bamboo-thermal-tumbler",
        "name": "Bamboo Thermal Tumbler",
        "current_price": 18.00,
        "stock": 55,
    },
    "satin-cloud-sleep-mask": {
        "id": "satin-cloud-sleep-mask",
        "name": "Satin Cloud Sleep Mask",
        "current_price": 12.00,
        "stock": 64,
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_state() -> Dict[str, Any]:
    return {
        "active_sku_id": None,
        "skus": deepcopy(INITIAL_SKUS),
        "flash_sale": None,
        "orders": [],
        "announcements": [],
        "event_ledger": [],
    }


commerce_state: Dict[str, Any] = _new_state()


def get_state() -> Dict[str, Any]:
    return deepcopy(commerce_state)


def append_event(event_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    event = {
        "id": str(uuid4()),
        "type": event_type,
        "payload": deepcopy(payload),
        "created_at": _now_iso(),
    }
    commerce_state["event_ledger"].append(event)
    return deepcopy(event)


def require_sku(sku_id: SkuId) -> Dict[str, Any]:
    sku = commerce_state["skus"].get(sku_id)

    if not sku:
        raise ValueError("Unknown SKU")

    return sku


def list_product(sku_id: SkuId) -> Dict[str, Any]:
    sku = require_sku(sku_id)
    commerce_state["active_sku_id"] = sku_id
    append_event(
        "list_product",
        {
            "sku_id": sku_id,
            "name": sku["name"],
            "price": sku["current_price"],
            "stock": sku["stock"],
        },
    )
    return get_state()


def change_price(sku_id: SkuId, current_price: float) -> Dict[str, Any]:
    sku = require_sku(sku_id)
    previous_price = sku["current_price"]
    sku["current_price"] = round(current_price, 2)
    append_event(
        "change_price",
        {
            "sku_id": sku_id,
            "previous_price": previous_price,
            "current_price": sku["current_price"],
        },
    )
    return get_state()


def create_flash_sale(
    sku_id: SkuId,
    sale_price: float,
    quantity: int,
    ends_in_seconds: int,
) -> Dict[str, Any]:
    sku = require_sku(sku_id)
    flash_sale = {
        "id": str(uuid4()),
        "sku_id": sku_id,
        "name": sku["name"],
        "sale_price": round(sale_price, 2),
        "quantity": quantity,
        "sold": 0,
        "ends_in_seconds": ends_in_seconds,
        "created_at": _now_iso(),
    }
    commerce_state["active_sku_id"] = sku_id
    commerce_state["flash_sale"] = flash_sale
    append_event("create_flash_sale", flash_sale)
    return get_state()


def update_stock(sku_id: SkuId, stock: int) -> Dict[str, Any]:
    sku = require_sku(sku_id)
    previous_stock = sku["stock"]
    sku["stock"] = stock
    append_event(
        "update_stock",
        {
            "sku_id": sku_id,
            "previous_stock": previous_stock,
            "stock": stock,
        },
    )
    return get_state()


def send_announcement(message: str) -> Dict[str, Any]:
    announcement = {
        "id": str(uuid4()),
        "message": message,
        "created_at": _now_iso(),
    }
    commerce_state["announcements"].append(announcement)
    append_event("send_announcement", announcement)
    return get_state()


def place_order(sku_id: SkuId, qty: int, viewer: str) -> Dict[str, Any]:
    if qty <= 0:
        raise ValueError("Order quantity must be greater than zero")

    sku = require_sku(sku_id)

    if sku["stock"] < qty:
        raise ValueError("Not enough stock")

    price = sku["current_price"]
    sku["stock"] -= qty

    flash_sale = commerce_state["flash_sale"]
    if flash_sale and flash_sale["sku_id"] == sku_id:
        price = flash_sale["sale_price"]
        flash_sale["sold"] += qty

    order = {
        "id": str(uuid4()),
        "sku_id": sku_id,
        "qty": qty,
        "price": round(price, 2),
        "viewer": viewer,
        "created_at": _now_iso(),
    }
    commerce_state["orders"].append(order)
    append_event(
        "order",
        {
            "sku_id": sku_id,
            "qty": qty,
            "price": order["price"],
            "viewer": viewer,
        },
    )
    return deepcopy(order)


def reset_state() -> Dict[str, Any]:
    commerce_state.clear()
    commerce_state.update(_new_state())
    return get_state()


def seed_demo_state() -> None:
    reset_state()
    list_product("glowfix-vitamin-c-serum")


__all__ = [
    "append_event",
    "change_price",
    "commerce_state",
    "create_flash_sale",
    "get_state",
    "list_product",
    "place_order",
    "reset_state",
    "send_announcement",
    "update_stock",
]
