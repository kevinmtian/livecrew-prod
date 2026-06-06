from __future__ import annotations

from typing import Any
from uuid import uuid4

from fastapi import HTTPException

try:
    from .ledger import append_event
    from .state import commerce_state, now_iso
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from ledger import append_event
    from state import commerce_state, now_iso


def require_sku(sku_id: str) -> dict[str, Any]:
    sku = commerce_state["skus"].get(sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail=f"Unknown sku_id: {sku_id}")
    return sku


def list_product(sku_id: str) -> dict[str, Any]:
    sku = require_sku(sku_id)
    commerce_state["active_sku_id"] = sku_id
    append_event("list_product", {"sku_id": sku_id})
    return sku


def change_price(sku_id: str, price: str) -> dict[str, Any]:
    sku = require_sku(sku_id)
    previous_price = sku["current_price"]
    sku["current_price"] = price
    append_event(
        "change_price",
        {
            "sku_id": sku_id,
            "previous_price": previous_price,
            "current_price": price,
        },
    )
    return sku


def create_flash_sale(
    sku_id: str,
    sale_price: str,
    total: int,
    remaining: int,
    ends_in_seconds: int,
) -> dict[str, Any]:
    require_sku(sku_id)
    if remaining > total:
        raise HTTPException(status_code=400, detail="remaining cannot exceed total")

    flash_sale = {
        "id": str(uuid4()),
        "sku_id": sku_id,
        "sale_price": sale_price,
        "total": total,
        "remaining": remaining,
        "ends_in_seconds": ends_in_seconds,
        "created_at": now_iso(),
    }
    commerce_state["flash_sale"] = flash_sale
    commerce_state["active_sku_id"] = sku_id
    append_event("create_flash_sale", flash_sale)
    return flash_sale


def update_stock(sku_id: str, stock: int) -> dict[str, Any]:
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
    return sku


def send_announcement(message: str, source: str = "host") -> dict[str, Any]:
    announcement = {
        "id": str(uuid4()),
        "message": message,
        "source": source,
        "created_at": now_iso(),
    }
    commerce_state["announcements"].append(announcement)
    append_event("send_announcement", announcement)
    return announcement


def place_order(sku_id: str, qty: int, viewer: str) -> dict[str, Any]:
    sku = require_sku(sku_id)
    if sku["stock"] < qty:
        raise HTTPException(status_code=400, detail="Insufficient stock")

    order_price = sku["current_price"]
    flash_sale_applied = False

    if (
        commerce_state["flash_sale"]
        and commerce_state["flash_sale"]["sku_id"] == sku_id
        and commerce_state["flash_sale"]["remaining"] >= qty
    ):
        order_price = commerce_state["flash_sale"]["sale_price"]
        flash_sale_applied = True
        commerce_state["flash_sale"]["remaining"] -= qty

    sku["stock"] -= qty

    order = {
        "id": str(uuid4()),
        "sku_id": sku_id,
        "qty": qty,
        "price": order_price,
        "viewer": viewer,
        "flash_sale_applied": flash_sale_applied,
        "created_at": now_iso(),
    }
    commerce_state["orders"].append(order)
    append_event(
        "order",
        {
            "sku_id": sku_id,
            "qty": qty,
            "price": order["price"],
            "viewer": viewer,
            "flash_sale_applied": flash_sale_applied,
            "order_id": order["id"],
        },
    )
    return order


def parse_price(price: str) -> float:
    numeric = "".join(character for character in price if character.isdigit() or character == ".")
    return float(numeric) if numeric else 0.0


def build_report() -> dict[str, Any]:
    per_sku: dict[str, dict[str, Any]] = {}

    for order in commerce_state["orders"]:
        sku_id = order["sku_id"]
        sku = commerce_state["skus"].get(sku_id, {"name": sku_id})
        summary = per_sku.setdefault(
            sku_id,
            {
                "sku_id": sku_id,
                "name": sku["name"],
                "units_sold": 0,
                "gmv": 0.0,
            },
        )
        summary["units_sold"] += order["qty"]
        summary["gmv"] += parse_price(order["price"]) * order["qty"]

    listed_sku_ids = []
    risk_events = []
    for event in commerce_state["event_ledger"]:
        if event["action"] in {"list_product", "create_flash_sale"}:
            sku_id = event.get("sku_id")
            if sku_id and sku_id not in listed_sku_ids:
                listed_sku_ids.append(sku_id)
        if event["action"] in {"guardrail_block", "host_escalation"}:
            risk_events.append(event)

    total_units = sum(item["units_sold"] for item in per_sku.values())
    total_gmv = sum(item["gmv"] for item in per_sku.values())
    flash_sale = commerce_state["flash_sale"]
    flash_sale_report = None

    if flash_sale:
        sold = flash_sale["total"] - flash_sale["remaining"]
        flash_sale_report = {
            "sku_id": flash_sale["sku_id"],
            "sale_price": flash_sale["sale_price"],
            "units_sold": sold,
            "remaining": flash_sale["remaining"],
            "total": flash_sale["total"],
            "sell_through_rate": sold / flash_sale["total"] if flash_sale["total"] else 0,
        }

    return {
        "generated_at": now_iso(),
        "listed_sku_ids": listed_sku_ids,
        "total_units_sold": total_units,
        "total_gmv": round(total_gmv, 2),
        "per_sku": list(per_sku.values()),
        "flash_sale": flash_sale_report,
        "viewer_questions_handled": len(
            [event for event in commerce_state["event_ledger"] if event["action"] == "answer_suggested"]
        ),
        "risk_events": risk_events,
        "ledger_event_count": len(commerce_state["event_ledger"]),
        "notes": [
            "Report is generated deterministically from backend orders and event_ledger.",
            "Narrative recommendations are deferred until ProducerAgent is implemented.",
        ],
    }
