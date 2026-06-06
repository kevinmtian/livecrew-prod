from __future__ import annotations

from backend.models import CommerceState, GuardrailResult, ProposedAction
from backend.tools.sku_resolver import get_sku_by_id


def validate_action(action: ProposedAction, state: CommerceState) -> GuardrailResult:
    if action.type == "noop":
        return GuardrailResult(
            action_type=action.type,
            allowed=False,
            status="needs_host_confirmation",
            reason=action.reason or "No supported action detected.",
        )

    if action.sku_id and not get_sku_by_id(action.sku_id, state.skus):
        return GuardrailResult(
            action_type=action.type,
            allowed=False,
            status="blocked",
            reason="Action references an unknown SKU.",
        )

    if action.type == "update_price":
        if action.price_cents is None or action.price_cents <= 0:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Price update needs a positive price.",
            )
        if action.price_cents < 500:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="needs_host_confirmation",
                reason="Very low prices require host confirmation.",
            )

    if action.type == "create_flash_sale":
        if not action.sale_price_cents or not action.stock_limit or not action.duration_seconds:
            return GuardrailResult(
                action_type=action.type,
                allowed=False,
                status="blocked",
                reason="Flash sale needs price, quantity limit, and duration.",
            )
        if action.sale_price_cents < 500 or action.stock_limit > 50:
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
