from __future__ import annotations

try:
    from .actions import make_guardrail_result
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from agents.actions import make_guardrail_result


def block_malicious_request() -> dict[str, object]:
    return make_guardrail_result(
        "noop",
        "block",
        "high",
        False,
        "Unsupported policy bypass or promotional promise.",
        ["No discount or policy bypass is confirmed."],
    )


def review_skin_safety_claim() -> dict[str, object]:
    return make_guardrail_result(
        "request_host_confirmation",
        "host_review",
        "high",
        False,
        "Medical or cure claims cannot be answered autonomously.",
        ["No medical, cure, or guaranteed skin outcome claim is supported."],
    )


def review_promo_request(has_sku: bool) -> dict[str, object]:
    return make_guardrail_result(
        "request_host_confirmation",
        "host_review" if has_sku else "ask_clarification",
        "medium",
        False,
        "Do not invent discounts, vouchers, or promotional promises.",
        ["No discount, voucher, or price exception is confirmed."],
    )


def evaluate_order(has_sku: bool) -> dict[str, object]:
    return make_guardrail_result(
        "create_order",
        "allow" if has_sku else "ask_clarification",
        "medium",
        has_sku,
        "Order is proposed only when SKU and quantity are clear.",
    )


def allow_grounded_reply() -> dict[str, object]:
    return make_guardrail_result(
        "suggest_reply",
        "allow",
        "low",
        True,
        "Reply is grounded in backend commerce state.",
    )


def ask_for_clarification() -> dict[str, object]:
    return make_guardrail_result(
        "request_host_confirmation",
        "ask_clarification",
        "medium",
        False,
        "The deterministic analyzer could not produce a grounded autonomous reply.",
    )
