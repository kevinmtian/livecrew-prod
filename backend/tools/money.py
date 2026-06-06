import re
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional


def cents_to_display(cents: int) -> str:
    return "${:,.2f}".format(cents / 100)


def decimal_to_cents(value: str) -> int:
    amount = Decimal(value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return int(amount * 100)


def extract_money_cents(text: str, *, after_keywords: bool = False) -> Optional[int]:
    normalized = text.lower()
    money_match = re.search(r"\$\s*(\d+(?:\.\d{1,2})?)", normalized)
    if money_match:
        return decimal_to_cents(money_match.group(1))

    dollar_match = re.search(r"(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)\b", normalized)
    if dollar_match:
        return decimal_to_cents(dollar_match.group(1))

    if after_keywords:
        keyword_match = re.search(
            r"(?:to|at|for|make it|drop .* to|set .* to)\s+(\d+(?:\.\d{1,2})?)\b",
            normalized,
        )
        if keyword_match:
            return decimal_to_cents(keyword_match.group(1))

    return None
