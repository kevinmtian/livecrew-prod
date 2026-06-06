from __future__ import annotations

from backend.models import CommerceState, GuardrailResult, ProposedAction
from backend.tools.sku_resolver import get_sku_by_id


def validate_action(
    action: ProposedAction,
    state: CommerceState,
    host_approved: bool = False,
) -> GuardrailResult:
    if action.type == "noop":
        return GuardrailResult(
            action_type=action.type,
            allowed=True,
            status="allowed",
            reason=action.reason or "No commerce action required.",
        )

    if action.sku_id and not get_sku_by_id(action.sku_id, state.skus):
        return GuardrailResult(
            action_type=action.type,
            allowed=False,
            status="blocked",
            reason="Action references an unknown SKU.",
        )

    if action.type in {
        "set_active_sku",
        "update_price",
        "update_stock",
        "restore_price",
        "create_flash_sale",
    } and not action.sku_id:
        return GuardrailResult(
            action_type=action.type,
            allowed=False,
            status="blocked" if host_approved else "needs_host_confirmation",
            reason="Action needs a grounded SKU before it can be applied.",
        )

    if action.requires_host_confirmation and not host_approved:
        return GuardrailResult(
            action_type=action.type,
            allowed=False,
            status="needs_host_confirmation",
            reason=action.reason or "Agent marked this action for host confirmation.",
        )

    if action.type == "update_price":
        if action.price_cents is None or action.price_cents <= 0:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Price update needs a positive price.",
            )
        if action.price_cents < 500 and not host_approved:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="needs_host_confirmation",
                reason="Very low prices require host confirmation.",
            )

    if action.type == "update_stock":
        if action.stock is None or action.stock < 0:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Stock update needs a non-negative stock quantity.",
            )

    if action.type == "create_flash_sale":
        if not action.sale_price_cents or not action.stock_limit or not action.duration_seconds:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Flash sale needs price, quantity limit, and duration.",
            )
        sku = get_sku_by_id(action.sku_id, state.skus)
        if sku and action.sale_price_cents > sku.price_cents:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Flash sale price cannot exceed the current SKU price.",
            )
        if sku and action.stock_limit > sku.stock:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Flash sale quantity cannot exceed current SKU stock.",
            )
        if (
            action.duration_seconds < 30 or action.duration_seconds > 1800
        ) and not host_approved:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="needs_host_confirmation",
                reason="Flash sale duration must be between 30 seconds and 30 minutes.",
            )
        if (
            action.sale_price_cents < 500 or action.stock_limit > 50
        ) and not host_approved:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="needs_host_confirmation",
                reason="Risky flash sale terms require host confirmation.",
            )

    return GuardrailResult(
        action_type=action.type,
        allowed=True,
        status="allowed",
        reason="Action passed deterministic guardrails.",
    )
