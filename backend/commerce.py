from __future__ import annotations

from backend.models import (
    AppliedAction,
    CommerceState,
    FlashSale,
    LedgerEntry,
    PendingAction,
    ProposedAction,
    GuardrailResult,
)
from backend.policies.guardrails import validate_action
from backend.tools.sku_resolver import get_sku_by_id


def apply_action(
    action: ProposedAction,
    guardrail: GuardrailResult,
    state: CommerceState,
) -> tuple[AppliedAction | None, LedgerEntry]:
    if guardrail.status == "needs_host_confirmation":
        pending = PendingAction(action=action, guardrail_result=guardrail)
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

    return None, LedgerEntry(
        type="noop",
        detail=action.reason or "No action applied.",
        source_text=action.source_text,
        payload={"action": action.model_dump(mode="json")},
    )


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
    return applied_actions, [guardrail], [resolution_ledger, action_ledger]


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
