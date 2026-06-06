from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from .agents.concierge import analyze_viewer_message
    from .agents.producer import generate_report
    from .commerce import (
        change_price,
        create_flash_sale,
        list_product,
        place_order,
        send_announcement,
        update_stock,
    )
    from .confirmations import (
        approve_pending_action_by_id,
        reject_pending_action_by_id,
    )
    from .state import commerce_state, reset_commerce_state
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from agents.concierge import analyze_viewer_message
    from agents.producer import generate_report
    from commerce import (
        change_price,
        create_flash_sale,
        list_product,
        place_order,
        send_announcement,
        update_stock,
    )
    from confirmations import (
        approve_pending_action_by_id,
        reject_pending_action_by_id,
    )
    from state import commerce_state, reset_commerce_state


app = FastAPI(title="LiveCrew Commerce Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):30\d{2}",
    allow_methods=["*"],
    allow_headers=["*"],
)


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


class ViewerMessageRequest(BaseModel):
    viewer: str = Field(min_length=1)
    text: str = Field(min_length=1)


class ActionDecisionRequest(BaseModel):
    note: Optional[str] = None


@app.get("/live/state")
def get_live_state() -> dict[str, Any]:
    return commerce_state


@app.get("/report")
def get_report() -> dict[str, Any]:
    return generate_report()


@app.post("/live/order")
def post_live_order(request: OrderRequest) -> dict[str, Any]:
    order = place_order(request.sku_id, request.qty, request.viewer)
    return {"order": order, "state": commerce_state}


@app.post("/events/viewer-message")
def post_viewer_message(request: ViewerMessageRequest) -> dict[str, Any]:
    return analyze_viewer_message(request.viewer, request.text)


@app.post("/actions/{pending_action_id}/approve")
def approve_pending_action(
    pending_action_id: str,
    request: ActionDecisionRequest,
) -> dict[str, Any]:
    return approve_pending_action_by_id(pending_action_id, request.note)


@app.post("/actions/{pending_action_id}/reject")
def reject_pending_action(
    pending_action_id: str,
    request: ActionDecisionRequest,
) -> dict[str, Any]:
    return reject_pending_action_by_id(pending_action_id, request.note)


@app.post("/live/reset")
def post_live_reset() -> dict[str, Any]:
    return reset_commerce_state()


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
