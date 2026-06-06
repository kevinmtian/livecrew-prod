from __future__ import annotations

from datetime import timedelta
from typing import Literal

from backend.models import (
    AppliedAction,
    CheckoutIntent,
    CommerceState,
    FlashSale,
    LedgerEntry,
    Order,
    PendingAction,
    ProposedAction,
    GuardrailResult,
    utc_now,
)
from backend.policies.guardrails import validate_action
from backend.tools.sku_resolver import get_sku_by_id


RequestedBy = Literal["cohost", "concierge", "guardrail", "host_ui"]


def _requested_by(action: ProposedAction) -> RequestedBy:
    if action.input_source == "viewer_message":
        return "concierge"
    if action.input_source == "host_ui":
        return "host_ui"
    return "cohost"


def _flash_sale_applies(action: ProposedAction, state: CommerceState) -> bool:
    if not state.flash_sale or not action.sku_id or not action.quantity:
        return False
    if state.flash_sale.sku_id != action.sku_id:
        return False
    if state.flash_sale.remaining_stock < action.quantity:
        return False

    ends_at = state.flash_sale.created_at + timedelta(seconds=state.flash_sale.duration_seconds)
    return utc_now() <= ends_at


def _flash_sale_available_for_sku(state: CommerceState, sku_id: str) -> bool:
    if not state.flash_sale or state.flash_sale.sku_id != sku_id:
        return False
    if state.flash_sale.remaining_stock <= 0:
        return False
    ends_at = state.flash_sale.created_at + timedelta(seconds=state.flash_sale.duration_seconds)
    return utc_now() <= ends_at


def get_purchase_terms(state: CommerceState, sku_id: str) -> tuple[int, int]:
    sku = get_sku_by_id(sku_id, state.skus)
    if not sku:
        return 0, 0

    if _flash_sale_available_for_sku(state, sku_id) and state.flash_sale:
        return state.flash_sale.sale_price_cents, min(sku.stock, state.flash_sale.remaining_stock)

    return sku.price_cents, sku.stock


def create_checkout_intent(
    state: CommerceState,
    viewer: str,
    sku_id: str,
    quantity: int,
) -> tuple[CheckoutIntent, LedgerEntry]:
    sku = get_sku_by_id(sku_id, state.skus)
    if not sku:
        raise ValueError("Product is not available.")
    if quantity < 1:
        raise ValueError("Quantity must be at least 1.")

    unit_price_cents, available_quantity = get_purchase_terms(state, sku_id)
    if quantity > available_quantity:
        raise ValueError(f"Only {available_quantity} unit(s) are available.")

    intent = CheckoutIntent(
        viewer=viewer,
        sku_id=sku_id,
        quantity=quantity,
        unit_price_cents=unit_price_cents,
        total_price_cents=unit_price_cents * quantity,
    )
    state.checkout_intents = [intent, *state.checkout_intents][:200]
    return intent, LedgerEntry(
        type="checkout_intent_started",
        detail=f"{viewer} opened checkout for {quantity} x {sku.name}.",
        payload={
            "checkout_intent_id": intent.id,
            "viewer": viewer,
            "sku_id": sku_id,
            "quantity": quantity,
            "unit_price_cents": unit_price_cents,
            "available_quantity": available_quantity,
        },
    )


def _find_pending_checkout_intent(
    state: CommerceState,
    checkout_intent_id: str,
) -> CheckoutIntent | None:
    return next(
        (
            intent
            for intent in state.checkout_intents
            if intent.id == checkout_intent_id and intent.status == "pending"
        ),
        None,
    )


def confirm_checkout_intent(
    state: CommerceState,
    checkout_intent_id: str,
) -> tuple[Order, list[LedgerEntry]]:
    intent = _find_pending_checkout_intent(state, checkout_intent_id)
    if not intent:
        raise ValueError("Pending checkout intent was not found.")

    sku = get_sku_by_id(intent.sku_id, state.skus)
    if not sku:
        raise ValueError("Product is no longer available.")

    unit_price_cents, available_quantity = get_purchase_terms(state, intent.sku_id)
    if intent.quantity > available_quantity:
        raise ValueError(f"Only {available_quantity} unit(s) are available.")

    sku.stock -= intent.quantity
    if (
        _flash_sale_available_for_sku(state, intent.sku_id)
        and state.flash_sale
        and unit_price_cents == state.flash_sale.sale_price_cents
    ):
        state.flash_sale.remaining_stock -= intent.quantity

    intent.status = "confirmed"
    intent.unit_price_cents = unit_price_cents
    intent.total_price_cents = unit_price_cents * intent.quantity
    intent.updated_at = utc_now()

    order = Order(
        viewer=intent.viewer,
        sku_id=intent.sku_id,
        quantity=intent.quantity,
        unit_price_cents=unit_price_cents,
        total_price_cents=unit_price_cents * intent.quantity,
        checkout_intent_id=intent.id,
    )
    state.orders = [order, *state.orders][:200]
    return order, [
        LedgerEntry(
            type="order_created",
            detail=f"{intent.viewer} ordered {intent.quantity} x {sku.name}.",
            payload={
                "order_id": order.id,
                "checkout_intent_id": intent.id,
                "viewer": intent.viewer,
                "sku_id": intent.sku_id,
                "quantity": intent.quantity,
                "unit_price_cents": unit_price_cents,
                "total_price_cents": order.total_price_cents,
            },
        ),
        LedgerEntry(
            type="checkout_intent_confirmed",
            detail=f"{intent.viewer} confirmed checkout.",
            payload={"checkout_intent_id": intent.id, "order_id": order.id},
        ),
    ]


def cancel_checkout_intent(
    state: CommerceState,
    checkout_intent_id: str,
) -> tuple[CheckoutIntent, LedgerEntry]:
    intent = _find_pending_checkout_intent(state, checkout_intent_id)
    if not intent:
        raise ValueError("Pending checkout intent was not found.")

    intent.status = "cancelled"
    intent.updated_at = utc_now()
    return intent, LedgerEntry(
        type="checkout_intent_cancelled",
        detail=f"{intent.viewer} cancelled checkout.",
        payload={"checkout_intent_id": intent.id, "viewer": intent.viewer},
    )


def apply_action(
    action: ProposedAction,
    guardrail: GuardrailResult,
    state: CommerceState,
) -> tuple[AppliedAction | None, LedgerEntry | None]:
    if guardrail.status == "needs_host_confirmation":
        pending = PendingAction(
            action=action,
            guardrail_result=guardrail,
            requested_by=_requested_by(action),
        )
        state.pending_actions.insert(0, pending)
        return None, LedgerEntry(
            type="host_confirmation_requested",
            detail=guardrail.reason,
            source_text=action.source_text,
            payload={"action": action.model_dump(mode="json")},
        )

    if not guardrail.allowed:
        return None, LedgerEntry(
            type="guardrail_block",
            detail=guardrail.reason,
            source_text=action.source_text,
            payload={"action": action.model_dump(mode="json")},
        )

    if action.type == "suggest_reply" and action.reply_text:
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=action.reply_text),
            LedgerEntry(
                type="answer_suggested",
                detail=action.reply_text,
                source_text=action.source_text,
                payload={
                    "sku_id": action.sku_id,
                    "viewer": action.viewer,
                    "reply_text": action.reply_text,
                    "evidence": action.evidence,
                },
            ),
        )

    if action.type == "create_order" and action.sku_id and action.quantity:
        sku = get_sku_by_id(action.sku_id, state.skus)
        if not sku:
            return None, LedgerEntry(
                type="guardrail_block",
                detail="Order references an unknown SKU.",
                source_text=action.source_text,
                payload={"action": action.model_dump(mode="json")},
            )

        unit_price_cents = (
            state.flash_sale.sale_price_cents
            if _flash_sale_applies(action, state) and state.flash_sale
            else sku.price_cents
        )
        sku.stock -= action.quantity
        if (
            state.flash_sale
            and state.flash_sale.sku_id == action.sku_id
            and unit_price_cents == state.flash_sale.sale_price_cents
        ):
            state.flash_sale.remaining_stock -= action.quantity

        order = Order(
            sku_id=action.sku_id,
            quantity=action.quantity,
            unit_price_cents=unit_price_cents,
            viewer=action.viewer or "viewer",
        )
        state.orders.insert(0, order)
        detail = (
            f"Recorded order for {action.quantity} x {sku.name} at "
            f"${unit_price_cents / 100:.2f}."
        )
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(
                type="order_created",
                detail=detail,
                source_text=action.source_text,
                payload=order.model_dump(mode="json"),
            ),
        )

    if action.type == "set_active_sku" and action.sku_id:
        state.active_sku_id = action.sku_id
        sku = get_sku_by_id(action.sku_id, state.skus)
        detail = f"Active SKU changed to {sku.name if sku else action.sku_id}."
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(
                type="list_product",
                detail=detail,
                source_text=action.source_text,
                payload={"sku_id": action.sku_id},
            ),
        )

    if action.type == "update_price" and action.sku_id and action.price_cents:
        sku = get_sku_by_id(action.sku_id, state.skus)
        if sku:
            sku.price_cents = action.price_cents
        detail = f"Updated price to ${action.price_cents / 100:.2f}."
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(
                type="price_updated",
                detail=detail,
                source_text=action.source_text,
                payload={"sku_id": action.sku_id, "price_cents": action.price_cents},
            ),
        )

    if action.type == "update_stock" and action.sku_id and action.stock is not None:
        sku = get_sku_by_id(action.sku_id, state.skus)
        if sku:
            sku.stock = action.stock
        if (
            state.flash_sale
            and state.flash_sale.sku_id == action.sku_id
            and state.flash_sale.remaining_stock > action.stock
        ):
            state.flash_sale.remaining_stock = action.stock
        detail = f"Updated stock to {action.stock} units."
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(
                type="stock_updated",
                detail=detail,
                source_text=action.source_text,
                payload={"sku_id": action.sku_id, "stock": action.stock},
            ),
        )

    if action.type == "restore_price" and action.sku_id:
        sku = get_sku_by_id(action.sku_id, state.skus)
        if sku and sku.base_price_cents:
            sku.price_cents = sku.base_price_cents
        detail = "Restored product to catalogue price."
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(
                type="price_restored",
                detail=detail,
                source_text=action.source_text,
                payload={"sku_id": action.sku_id},
            ),
        )

    if action.type == "create_flash_sale" and action.sku_id:
        state.flash_sale = FlashSale(
            sku_id=action.sku_id,
            sale_price_cents=action.sale_price_cents or 0,
            stock_limit=action.stock_limit or 0,
            remaining_stock=action.stock_limit or 0,
            duration_seconds=action.duration_seconds or 0,
        )
        detail = "Created flash sale for active product."
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(
                type="create_flash_sale",
                detail=detail,
                source_text=action.source_text,
                payload=state.flash_sale.model_dump(mode="json"),
            ),
        )

    if action.type == "cancel_flash_sale":
        state.flash_sale = None
        detail = "Cancelled active flash sale."
        return (
            AppliedAction(type=action.type, sku_id=action.sku_id, detail=detail),
            LedgerEntry(type="flash_sale_cancelled", detail=detail, source_text=action.source_text),
        )

    return None, None


def _find_pending_action(
    state: CommerceState,
    pending_action_id: str,
) -> PendingAction | None:
    return next(
        (
            pending
            for pending in state.pending_actions
            if pending.id == pending_action_id and pending.status == "pending"
        ),
        None,
    )


def approve_pending_action(
    pending_action_id: str,
    state: CommerceState,
) -> tuple[list[AppliedAction], list[GuardrailResult], list[LedgerEntry]] | None:
    pending = _find_pending_action(state, pending_action_id)
    if not pending:
        return None

    pending.status = "approved"
    action = pending.action.model_copy(update={"requires_host_confirmation": False})
    guardrail = validate_action(action, state, host_approved=True)
    applied, action_ledger = apply_action(action, guardrail, state)
    resolution_ledger = LedgerEntry(
        type="host_confirmation_resolved",
        detail=f"Host approved {action.type.replace('_', ' ')}.",
        source_text=action.source_text,
        payload={
            "pending_action_id": pending.id,
            "resolution": "approved",
            "action": action.model_dump(mode="json"),
        },
    )

    applied_actions = [applied] if applied else []
    ledger_entries = [resolution_ledger]
    if action_ledger:
        ledger_entries.append(action_ledger)
    return applied_actions, [guardrail], ledger_entries


def reject_pending_action(
    pending_action_id: str,
    state: CommerceState,
) -> tuple[list[GuardrailResult], list[LedgerEntry]] | None:
    pending = _find_pending_action(state, pending_action_id)
    if not pending:
        return None

    pending.status = "rejected"
    action = pending.action
    ledger_entry = LedgerEntry(
        type="host_confirmation_resolved",
        detail=f"Host rejected {action.type.replace('_', ' ')}.",
        source_text=action.source_text,
        payload={
            "pending_action_id": pending.id,
            "resolution": "rejected",
            "action": action.model_dump(mode="json"),
        },
    )
    return [pending.guardrail_result], [ledger_entry]
