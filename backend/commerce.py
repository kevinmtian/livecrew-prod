from datetime import datetime, timedelta
from typing import List, Optional, Tuple
from uuid import uuid4

from backend.ledger import append_ledger
from backend.models import (
    Announcement,
    AppliedAction,
    CommerceState,
    FlashSale,
    Order,
    ProposedAction,
)
from backend.tools.money import cents_to_display
from backend.tools.reply_grounder import get_sku


def _flash_sale_is_usable(state: CommerceState, sku_id: str, quantity: int) -> bool:
    sale = state.flash_sale
    if not sale:
        return False
    return (
        sale.active
        and sale.sku_id == sku_id
        and sale.remaining_stock >= quantity
        and datetime.utcnow() < sale.ends_at
    )


def effective_unit_price(state: CommerceState, sku_id: str, quantity: int) -> Tuple[int, bool]:
    sku = get_sku(state, sku_id)
    if not sku:
        raise ValueError("Unknown SKU")

    if _flash_sale_is_usable(state, sku_id, quantity) and state.flash_sale:
        return state.flash_sale.sale_price_cents, True

    return sku.current_price_cents, False


def apply_action(
    state: CommerceState,
    action: ProposedAction,
    *,
    actor: str,
) -> Tuple[Optional[AppliedAction], List]:
    ledgers = []

    if action.type == "noop":
        return None, ledgers

    if action.type == "set_active_sku":
        sku = get_sku(state, action.sku_id)
        if not sku:
            raise ValueError("Cannot list an unknown SKU")
        state.active_sku_id = sku.id
        entry = append_ledger(
            state,
            "list_product",
            actor,
            f"Listed {sku.name} as the active SKU.",
            sku.id,
            {"source_text": action.source_text, "evidence": action.evidence},
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=sku.id,
                message=f"{sku.name} is now active.",
                payload={"active_sku_id": sku.id},
            ),
            ledgers,
        )

    if action.type == "update_price":
        sku = get_sku(state, action.sku_id)
        if not sku or action.price_cents is None:
            raise ValueError("Price update requires SKU and price")
        old_price = sku.current_price_cents
        sku.current_price_cents = action.price_cents
        entry = append_ledger(
            state,
            "price_updated",
            actor,
            f"Updated {sku.name} price from {cents_to_display(old_price)} to {cents_to_display(sku.current_price_cents)}.",
            sku.id,
            {
                "old_price_cents": old_price,
                "new_price_cents": sku.current_price_cents,
                "source_text": action.source_text,
            },
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=sku.id,
                message=f"{sku.name} price updated.",
                payload={"price_cents": sku.current_price_cents},
            ),
            ledgers,
        )

    if action.type == "restore_price":
        sku = get_sku(state, action.sku_id)
        if not sku:
            raise ValueError("Price restore requires SKU")
        old_price = sku.current_price_cents
        sku.current_price_cents = sku.base_price_cents
        entry = append_ledger(
            state,
            "price_restored",
            actor,
            f"Restored {sku.name} regular price to {cents_to_display(sku.base_price_cents)}.",
            sku.id,
            {"old_price_cents": old_price, "restored_price_cents": sku.base_price_cents},
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=sku.id,
                message=f"{sku.name} price restored.",
                payload={"price_cents": sku.current_price_cents},
            ),
            ledgers,
        )

    if action.type == "create_flash_sale":
        sku = get_sku(state, action.sku_id)
        if not sku or action.sale_price_cents is None or action.stock_limit is None:
            raise ValueError("Flash sale requires SKU, sale price, and stock limit")
        duration_seconds = action.duration_seconds or 300
        now = datetime.utcnow()
        state.flash_sale = FlashSale(
            sku_id=sku.id,
            original_price_cents=sku.current_price_cents,
            sale_price_cents=action.sale_price_cents,
            starting_stock=action.stock_limit,
            remaining_stock=action.stock_limit,
            starts_at=now,
            ends_at=now + timedelta(seconds=duration_seconds),
            active=True,
        )
        entry = append_ledger(
            state,
            "create_flash_sale",
            actor,
            f"Created flash sale for {sku.name} at {cents_to_display(action.sale_price_cents)}.",
            sku.id,
            {
                "sale_price_cents": action.sale_price_cents,
                "stock_limit": action.stock_limit,
                "duration_seconds": duration_seconds,
                "source_text": action.source_text,
            },
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=sku.id,
                message=f"Flash sale created for {sku.name}.",
                payload={"flash_sale": state.flash_sale.model_dump(mode="json")},
            ),
            ledgers,
        )

    if action.type == "cancel_flash_sale":
        sale = state.flash_sale
        if not sale or not sale.active:
            raise ValueError("No active flash sale to cancel")
        sale.active = False
        entry = append_ledger(
            state,
            "flash_sale_cancelled",
            actor,
            "Cancelled the active flash sale.",
            sale.sku_id,
            {"source_text": action.source_text},
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=sale.sku_id,
                message="Flash sale cancelled.",
                payload={},
            ),
            ledgers,
        )

    if action.type == "create_order":
        sku = get_sku(state, action.sku_id)
        quantity = action.quantity or 0
        if not sku or quantity <= 0:
            raise ValueError("Order requires SKU and positive quantity")
        if sku.stock < quantity:
            raise ValueError("Insufficient stock")
        unit_price, used_flash_sale = effective_unit_price(state, sku.id, quantity)
        sku.stock -= quantity
        if used_flash_sale and state.flash_sale:
            state.flash_sale.remaining_stock -= quantity
        viewer = actor.removeprefix("viewer:") if actor.startswith("viewer:") else actor
        order = Order(
            id="order-" + str(uuid4()),
            viewer=viewer,
            sku_id=sku.id,
            quantity=quantity,
            unit_price_cents=unit_price,
            total_price_cents=unit_price * quantity,
            used_flash_sale=used_flash_sale,
            created_at=datetime.utcnow(),
        )
        state.orders.append(order)
        state.metrics.total_units_sold += quantity
        state.metrics.total_gmv_cents += order.total_price_cents
        entry = append_ledger(
            state,
            "order_created",
            actor,
            f"Recorded order for {quantity} x {sku.name}.",
            sku.id,
            order.model_dump(mode="json"),
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=sku.id,
                message=f"Order recorded for {quantity} x {sku.name}.",
                payload={"order": order.model_dump(mode="json")},
            ),
            ledgers,
        )

    if action.type == "suggest_reply":
        state.metrics.questions_handled += 1
        entry = append_ledger(
            state,
            "answer_suggested",
            actor,
            action.reply_text or "Suggested grounded reply.",
            action.sku_id,
            {"source_text": action.source_text, "evidence": action.evidence},
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=action.sku_id,
                message="Suggested reply recorded.",
                payload={"reply_text": action.reply_text},
            ),
            ledgers,
        )

    if action.type == "add_announcement":
        text = action.announcement_text or action.source_text
        announcement = Announcement(
            id="announcement-" + str(uuid4()),
            text=text,
            created_at=datetime.utcnow(),
        )
        state.announcements.append(announcement)
        entry = append_ledger(
            state,
            "announcement_created",
            actor,
            text,
            action.sku_id,
            announcement.model_dump(mode="json"),
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=action.sku_id,
                message="Announcement published.",
                payload={"announcement": announcement.model_dump(mode="json")},
            ),
            ledgers,
        )

    if action.type == "host_override":
        entry = append_ledger(
            state,
            "host_override",
            actor,
            action.reason or "Host override recorded.",
            action.sku_id,
            action.model_dump(mode="json"),
        )
        ledgers.append(entry)
        return (
            AppliedAction(
                type=action.type,
                sku_id=action.sku_id,
                message="Host override recorded.",
                payload=action.model_dump(mode="json"),
            ),
            ledgers,
        )

    raise ValueError(f"Unsupported action type: {action.type}")
