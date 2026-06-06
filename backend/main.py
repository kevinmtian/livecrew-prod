from typing import Dict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.commerce import (
    change_price,
    create_flash_sale,
    get_state,
    list_product,
    place_order,
    reset_state,
    send_announcement,
    update_stock,
)


app = FastAPI(title="LiveCrew Commerce Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
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
    current_price: float = Field(gt=0)


class FlashSaleRequest(BaseModel):
    sku_id: str
    sale_price: float = Field(gt=0)
    quantity: int = Field(gt=0)
    ends_in_seconds: int = Field(gt=0)


class UpdateStockRequest(BaseModel):
    sku_id: str
    stock: int = Field(ge=0)


class AnnouncementRequest(BaseModel):
    message: str = Field(min_length=1)


def as_http_error(error: ValueError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(error))


@app.get("/live/state")
def live_state() -> Dict:
    return get_state()


@app.post("/live/order")
def live_order(request: OrderRequest) -> Dict:
    try:
        order = place_order(
            sku_id=request.sku_id,
            qty=request.qty,
            viewer=request.viewer,
        )
    except ValueError as error:
        raise as_http_error(error) from error

    return {"order": order, "state": get_state()}


@app.post("/live/reset")
def live_reset() -> Dict:
    return reset_state()


@app.post("/live/list-product")
def live_list_product(request: ListProductRequest) -> Dict:
    try:
        return list_product(request.sku_id)
    except ValueError as error:
        raise as_http_error(error) from error


@app.post("/live/change-price")
def live_change_price(request: ChangePriceRequest) -> Dict:
    try:
        return change_price(request.sku_id, request.current_price)
    except ValueError as error:
        raise as_http_error(error) from error


@app.post("/live/flash-sale")
def live_flash_sale(request: FlashSaleRequest) -> Dict:
    try:
        return create_flash_sale(
            sku_id=request.sku_id,
            sale_price=request.sale_price,
            quantity=request.quantity,
            ends_in_seconds=request.ends_in_seconds,
        )
    except ValueError as error:
        raise as_http_error(error) from error


@app.post("/live/stock")
def live_update_stock(request: UpdateStockRequest) -> Dict:
    try:
        return update_stock(request.sku_id, request.stock)
    except ValueError as error:
        raise as_http_error(error) from error


@app.post("/live/announcement")
def live_announcement(request: AnnouncementRequest) -> Dict:
    return send_announcement(request.message)
