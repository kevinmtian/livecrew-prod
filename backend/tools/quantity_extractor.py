import re
from typing import Optional


ORDER_TERMS = [
    "order",
    "buy",
    "purchase",
    "get",
    "take",
    "add",
    "want",
    "checkout",
    "reserve",
    "send me",
]

NUMBER_WORDS = {
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
    "pair": 2,
    "couple": 2,
}


def has_order_intent(text: str) -> bool:
    normalized = text.lower()
    return any(term in normalized for term in ORDER_TERMS)


def extract_quantity(text: str) -> Optional[int]:
    normalized = text.lower()

    multiplier_match = re.search(r"(?:x|qty\s*)\s*(\d{1,2})\b", normalized)
    if multiplier_match:
        return int(multiplier_match.group(1))

    numeric_match = re.search(
        r"\b(\d{1,2})(?!\s*%)\s*(?:pcs?|pieces?|units?|items?)?\b",
        normalized,
    )
    if numeric_match:
        return int(numeric_match.group(1))

    for word, value in NUMBER_WORDS.items():
        if re.search(r"\b" + re.escape(word) + r"\b", normalized):
            return value

    return None


def order_quantity_or_default(text: str) -> Optional[int]:
    quantity = extract_quantity(text)
    if quantity is not None:
        return quantity
    if has_order_intent(text):
        return 1
    return None
