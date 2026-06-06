from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


app = FastAPI(title="LiveCrew Commerce Backend")

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
        "event_ledger": [],
    }


def make_reset_state() -> dict[str, Any]:
    state = make_initial_state()
    state["active_sku_id"] = None
    return state


commerce_state = make_initial_state()


class OrderRequest(BaseModel):
    sku_id: str
    qty: int = Field(gt=0)
    viewer: str = Field(min_length=1)


class ListProductRequest(BaseModel):
    sku_id: str


class ChangePriceRequest(BaseModel):
    sku_id: str
    price: str = Field(min_length=1)


class FlashSaleRequest(BaseModel):
    sku_id: str
    sale_price: str = Field(min_length=1)
    total: int = Field(gt=0)
    remaining: int = Field(ge=0)
    ends_in_seconds: int = Field(gt=0)


class UpdateStockRequest(BaseModel):
    sku_id: str
    stock: int = Field(ge=0)


class AnnouncementRequest(BaseModel):
    message: str = Field(min_length=1)
    source: Literal["host", "agent", "system"] = "host"


def append_event(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    event = {
        "id": str(uuid4()),
        "ts": now_iso(),
        "action": action,
        **payload,
    }
    commerce_state["event_ledger"].append(event)
    return event


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

    sku["stock"] -= qty

    if (
        commerce_state["flash_sale"]
        and commerce_state["flash_sale"]["sku_id"] == sku_id
        and commerce_state["flash_sale"]["remaining"] > 0
    ):
        commerce_state["flash_sale"]["remaining"] = max(
            commerce_state["flash_sale"]["remaining"] - qty,
            0,
        )

    order = {
        "id": str(uuid4()),
        "sku_id": sku_id,
        "qty": qty,
        "price": sku["current_price"],
        "viewer": viewer,
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
            "order_id": order["id"],
        },
    )
    return order


@app.get("/live/state")
def get_live_state() -> dict[str, Any]:
    return commerce_state


@app.post("/live/order")
def post_live_order(request: OrderRequest) -> dict[str, Any]:
    order = place_order(request.sku_id, request.qty, request.viewer)
    return {"order": order, "state": commerce_state}


@app.post("/live/reset")
def post_live_reset() -> dict[str, Any]:
    commerce_state.clear()
    commerce_state.update(make_reset_state())
    return commerce_state


@app.post("/tools/list_product")
def post_list_product(request: ListProductRequest) -> dict[str, Any]:
    sku = list_product(request.sku_id)
    return {"sku": sku, "state": commerce_state}


@app.post("/tools/change_price")
def post_change_price(request: ChangePriceRequest) -> dict[str, Any]:
    sku = change_price(request.sku_id, request.price)
    return {"sku": sku, "state": commerce_state}


@app.post("/tools/create_flash_sale")
def post_create_flash_sale(request: FlashSaleRequest) -> dict[str, Any]:
    flash_sale = create_flash_sale(
        request.sku_id,
        request.sale_price,
        request.total,
        request.remaining,
        request.ends_in_seconds,
    )
    return {"flash_sale": flash_sale, "state": commerce_state}


@app.post("/tools/update_stock")
def post_update_stock(request: UpdateStockRequest) -> dict[str, Any]:
    sku = update_stock(request.sku_id, request.stock)
    return {"sku": sku, "state": commerce_state}


@app.post("/tools/send_announcement")
def post_send_announcement(request: AnnouncementRequest) -> dict[str, Any]:
    announcement = send_announcement(request.message, request.source)
    return {"announcement": announcement, "state": commerce_state}
