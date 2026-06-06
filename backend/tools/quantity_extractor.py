from __future__ import annotations

import re


NUMBER_WORDS = {
    "a": 1,
    "an": 1,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}

ORDER_KEYWORDS = {
    "buy",
    "order",
    "take",
    "want",
    "cart",
    "checkout",
    "reserve",
}


def has_order_intent(text: str) -> bool:
    normalized = text.lower()
    return any(re.search(rf"\b{re.escape(keyword)}\b", normalized) for keyword in ORDER_KEYWORDS)


def extract_order_quantity(text: str) -> int | None:
    normalized = text.lower()

    digit_match = re.search(r"\b(\d{1,2})(?!\s*%)\b", normalized)
    if digit_match:
        quantity = int(digit_match.group(1))
        if quantity > 0:
            return quantity

    for word, quantity in NUMBER_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", normalized):
            return quantity

    if has_order_intent(text):
        return 1

    return None
