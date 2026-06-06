from __future__ import annotations

from typing import Literal

try:
    from ..state import commerce_state
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from state import commerce_state


ViewerIntent = Literal[
    "product_fact",
    "promo_request",
    "order",
    "skin_safety",
    "malicious",
    "ambiguous",
]


def normalize_text(value: str) -> str:
    return " ".join(
        "".join(
            character.lower()
            if character.isalnum() or character.isspace() or character == "%"
            else " "
            for character in value
        ).split()
    )


def resolve_sku_from_text(text: str) -> str | None:
    normalized = normalize_text(text)
    sku_terms = {
        "sku-glowfix-vitamin-c-serum": ["glowfix", "vitamin c", "serum"],
        "sku-hydramist-cushion-spf": ["hydramist", "cushion", "spf"],
        "sku-bamboo-thermal-tumbler": ["bamboo", "tumbler"],
        "sku-satin-cloud-sleep-mask": ["satin", "sleep mask"],
    }

    for sku_id, terms in sku_terms.items():
        if any(term in normalized for term in terms):
            return sku_id

    contextual_terms = ["it", "this", "this one", "that one", "the product", "active product"]
    if commerce_state["active_sku_id"] and any(term in normalized for term in contextual_terms):
        return commerce_state["active_sku_id"]

    return None


def classify_viewer_intent(text: str) -> ViewerIntent:
    normalized = normalize_text(text)

    if "ignore policy" in normalized or "promise me" in normalized:
        return "malicious"
    if any(term in normalized for term in ["order", "purchase", "buy", "another", "add to cart", "checkout"]):
        return "order"
    if any(term in normalized for term in ["cure", "acne", "eczema", "medical"]):
        return "skin_safety"
    if any(term in normalized for term in ["discount", "voucher", "promo", "coupon", "50% off"]):
        return "promo_request"
    if any(
        term in normalized
        for term in ["ship", "shipping", "deliver", "singapore", "price", "how much", "stock", "benefit", "use", "spf"]
    ):
        return "product_fact"
    return "ambiguous"


def extract_quantity(text: str) -> int:
    normalized = normalize_text(text)
    word_numbers = {
        "one": 1,
        "two": 2,
        "three": 3,
        "four": 4,
        "five": 5,
        "ten": 10,
        "twenty": 20,
        "fifty": 50,
        "hundred": 100,
    }

    for token in normalized.split():
        if token.isdigit():
            return max(1, min(999, int(token)))
        if token in word_numbers:
            return word_numbers[token]

    return 1
