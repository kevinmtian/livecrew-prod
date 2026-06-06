from datetime import datetime
from typing import Optional

from backend.models import CommerceState, GuardrailResult, ProposedAction
from backend.tools.reply_grounder import get_sku


UNSUPPORTED_CLAIMS = [
    "cure",
    "guarantee",
    "guaranteed",
    "authentic",
    "same day delivery",
    "free shipping",
    "50% off",
    "half off",
]


def _result(action: ProposedAction, decision: str, risk: str, message: str, *reasons: str):
    return GuardrailResult(
        action_type=action.type,
        decision=decision,
        risk_level=risk,
        message=message,
        reasons=[reason for reason in reasons if reason],
    )


def validate_action(
    state: CommerceState,
    action: ProposedAction,
    *,
    approved_by_host: bool = False,
) -> GuardrailResult:
    if action.requires_host_confirmation and not approved_by_host:
        return _result(action, "confirm", "high", "Action requires host confirmation.")

    if action.confidence < 0.62 and not approved_by_host:
        return _result(action, "confirm", "medium", "Low-confidence action needs host confirmation.")

    if action.type in ["set_active_sku", "update_price", "restore_price", "create_order", "create_flash_sale"]:
        sku = get_sku(state, action.sku_id)
        if not sku:
            return _result(action, "confirm", "high", "SKU is missing or ambiguous.")

    if action.type == "update_price":
        sku = get_sku(state, action.sku_id)
        if action.price_cents is None or action.price_cents <= 0:
            return _result(action, "block", "high", "Price update must be greater than zero.")
        if sku and action.price_cents < int(sku.current_price_cents * 0.7) and not approved_by_host:
            return _result(action, "confirm", "medium", "Deep price reduction needs host confirmation.")
        return _result(action, "allow", "medium", "Price update passed deterministic checks.")

    if action.type == "restore_price":
        return _result(action, "allow", "low", "Price restore passed deterministic checks.")

    if action.type == "set_active_sku":
        return _result(action, "allow", "low", "SKU listing passed deterministic checks.")

    if action.type == "create_flash_sale":
        sku = get_sku(state, action.sku_id)
        if not sku or action.sale_price_cents is None or action.stock_limit is None:
            return _result(action, "confirm", "high", "Flash sale is missing SKU, price, or quantity limit.")
        duration = action.duration_seconds or 0
        if action.sale_price_cents <= 0:
            return _result(action, "block", "high", "Flash-sale price must be greater than zero.")
        if action.sale_price_cents > sku.current_price_cents:
            return _result(action, "block", "high", "Flash-sale price cannot exceed current price.")
        if action.stock_limit <= 0 or action.stock_limit > sku.stock:
            return _result(action, "block", "high", "Flash-sale quantity must fit current stock.")
        if duration < 30 or duration > 1800:
            return _result(action, "confirm", "medium", "Flash-sale duration needs host confirmation.")
        if action.sale_price_cents < int(sku.current_price_cents * 0.55) and not approved_by_host:
            return _result(action, "confirm", "medium", "Deep flash-sale discount needs host confirmation.")
        return _result(action, "allow", "medium", "Flash sale passed deterministic checks.")

    if action.type == "cancel_flash_sale":
        if not state.flash_sale or not state.flash_sale.active or datetime.utcnow() >= state.flash_sale.ends_at:
            return _result(action, "block", "low", "No active flash sale is available to cancel.")
        return _result(action, "allow", "low", "Flash-sale cancellation passed deterministic checks.")

    if action.type == "create_order":
        sku = get_sku(state, action.sku_id)
        quantity = action.quantity or 0
        if quantity <= 0:
            return _result(action, "confirm", "high", "Order quantity is missing or ambiguous.")
        if sku and sku.stock < quantity:
            return _result(action, "block", "high", "Insufficient stock for the requested order.")
        return _result(action, "allow", "medium", "Order passed deterministic checks.")

    if action.type == "suggest_reply":
        reply = (action.reply_text or "").lower()
        blocked_claim = next((claim for claim in UNSUPPORTED_CLAIMS if claim in reply), None)
        if blocked_claim:
            return _result(action, "confirm", "high", "Suggested reply contains an unsupported claim.", blocked_claim)
        return _result(action, "allow", "low", "Suggested reply is grounded and safe.")

    if action.type in ["add_announcement", "host_override", "noop"]:
        return _result(action, "allow", "low", "Action passed deterministic checks.")

    if action.type == "request_host_confirmation":
        return _result(action, "confirm", "medium", action.reason or "Host confirmation requested.")

    return _result(action, "block", "high", "Unknown action type.")
