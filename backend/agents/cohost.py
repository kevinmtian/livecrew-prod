import re
from typing import List, Optional

from backend.models import AgentDecision, CommerceState, ProposedAction
from backend.tools.money import decimal_to_cents, extract_money_cents
from backend.tools.sku_resolver import resolve_sku_from_text, resolve_with_context


PRICE_TERMS = ["drop", "price", "make it", "set", "change", "dollars", "$", "off"]
RESTORE_TERMS = ["restore", "original price", "base price"]
FLASH_TERMS = ["flash", "first", "buyers", "orders", "limited", "next"]
CANCEL_FLASH_TERMS = ["cancel the flash", "cancel flash", "cancel the deal", "cancel promo"]
ANNOUNCEMENT_TERMS = ["announce", "tell viewers", "say to viewers"]

PERCENT_RE = re.compile(r"\b(\d{1,2})\s*(?:percent|%)\s*off\b")
FIRST_RE = re.compile(r"\bfirst\s+(\d{1,3})\b")
MINUTES_RE = re.compile(r"\b(\d{1,2})\s*(?:minutes?|mins?)\b")
SECONDS_RE = re.compile(r"\b(\d{2,3})\s*(?:seconds?|secs?)\b")

WORD_NUMBERS = {
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
    "twenty": 20,
}


def _extract_money_values(text: str) -> List[int]:
    lowered = text.lower()
    values: List[int] = []
    patterns = [
        r"\$\s*(\d+(?:\.\d{1,2})?)",
        r"(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?)\b",
        r"(?:make it|drop .* to|set .* to|to|at|are|get it at|get)\s+(\d+(?:\.\d{1,2})?)\b",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, lowered):
            cents = decimal_to_cents(match.group(1))
            if cents not in values:
                values.append(cents)
    return values


def _word_number(text: str) -> Optional[int]:
    lowered = text.lower()
    for word, value in WORD_NUMBERS.items():
        if re.search(r"\b" + re.escape(word) + r"\b", lowered):
            return value
    return None


def _parse_duration_seconds(text: str) -> Optional[int]:
    minutes = MINUTES_RE.search(text.lower())
    if minutes:
        return int(minutes.group(1)) * 60
    seconds = SECONDS_RE.search(text.lower())
    if seconds:
        return int(seconds.group(1))
    if "minute" in text.lower():
        word_value = _word_number(text)
        if word_value:
            return word_value * 60
    return None


def _parse_stock_limit(text: str) -> Optional[int]:
    match = FIRST_RE.search(text.lower())
    if match:
        return int(match.group(1))
    if "first" in text.lower():
        return _word_number(text)
    return None


def _discount_price_cents(state: CommerceState, sku_id: Optional[str], text: str) -> Optional[int]:
    match = PERCENT_RE.search(text.lower())
    if not match or not sku_id:
        return None
    sku = next((candidate for candidate in state.skus if candidate.id == sku_id), None)
    if not sku:
        return None
    discount_percent = int(match.group(1))
    return int(sku.current_price_cents * (100 - discount_percent) / 100)


def analyze_host_transcript(state: CommerceState, text: str) -> tuple[List[AgentDecision], List[ProposedAction]]:
    decisions: List[AgentDecision] = []
    actions: List[ProposedAction] = []
    lowered = text.lower()

    explicit_resolution = resolve_sku_from_text(text, state.skus)
    context_resolution = resolve_with_context(text, state.skus, state.active_sku_id)
    working_sku_id = explicit_resolution.sku_id or context_resolution.sku_id

    if explicit_resolution.sku_id:
        actions.append(
            ProposedAction(
                type="set_active_sku",
                sku_id=explicit_resolution.sku_id,
                source_text=text,
                confidence=explicit_resolution.confidence,
                reason=(
                    "Fallback rule hit: the host mentioned a seeded SKU, so "
                    "select and pin it for the shared host/viewer room state."
                ),
                evidence=explicit_resolution.evidence,
            )
        )
        decisions.append(
            AgentDecision(
                agent="cohost",
                intent="set_active_sku",
                confidence=explicit_resolution.confidence,
                reason=(
                    "Resolved host product mention against the seeded catalogue "
                    "and proposed it as the pinned room SKU."
                ),
                evidence=explicit_resolution.evidence,
            )
        )

    if explicit_resolution.ambiguous:
        actions.append(
            ProposedAction(
                type="request_host_confirmation",
                source_text=text,
                confidence=0.45,
                reason="The product mention matched multiple SKUs.",
                evidence=explicit_resolution.evidence,
                requires_host_confirmation=True,
            )
        )

    if any(term in lowered for term in CANCEL_FLASH_TERMS):
        actions.append(
            ProposedAction(
                type="cancel_flash_sale",
                sku_id=state.flash_sale.sku_id if state.flash_sale else working_sku_id,
                source_text=text,
                confidence=0.9,
                reason="The host asked to cancel the active flash deal.",
                evidence=["cancel flash"],
            )
        )

    if any(term in lowered for term in RESTORE_TERMS):
        actions.append(
            ProposedAction(
                type="restore_price",
                sku_id=working_sku_id,
                source_text=text,
                confidence=0.86 if working_sku_id else 0.5,
                reason="The host asked to restore the original price.",
                evidence=["restore", "original price"],
                requires_host_confirmation=working_sku_id is None,
            )
        )

    money_values = _extract_money_values(text)
    price_cents = extract_money_cents(text, after_keywords=True)
    discount_cents = _discount_price_cents(state, working_sku_id, text)
    has_price_intent = any(term in lowered for term in PRICE_TERMS)
    has_flash_intent = any(term in lowered for term in FLASH_TERMS)

    if price_cents and has_price_intent and (not has_flash_intent or len(money_values) > 1):
        actions.append(
            ProposedAction(
                type="update_price",
                sku_id=working_sku_id,
                price_cents=price_cents,
                source_text=text,
                confidence=0.88 if working_sku_id else 0.55,
                reason="The host gave a live price update.",
                evidence=[str(price_cents)],
                requires_host_confirmation=working_sku_id is None,
            )
        )
    elif discount_cents and has_price_intent:
        actions.append(
            ProposedAction(
                type="update_price",
                sku_id=working_sku_id,
                price_cents=discount_cents,
                source_text=text,
                confidence=0.84,
                reason="The host gave a percentage discount for the current product.",
                evidence=[PERCENT_RE.search(lowered).group(0) if PERCENT_RE.search(lowered) else "discount"],
            )
        )

    if has_flash_intent:
        sale_price = money_values[-1] if money_values else price_cents
        duration_seconds = _parse_duration_seconds(text) or 300
        stock_limit = _parse_stock_limit(text)
        if sale_price or stock_limit:
            actions.append(
                ProposedAction(
                    type="create_flash_sale",
                    sku_id=working_sku_id,
                    sale_price_cents=sale_price,
                    duration_seconds=duration_seconds,
                    stock_limit=stock_limit,
                    source_text=text,
                    confidence=0.82 if working_sku_id and sale_price and stock_limit else 0.58,
                    reason="The host described a limited-time or quantity-limited promotion.",
                    evidence=[evidence for evidence in ["first", str(sale_price or ""), str(duration_seconds)] if evidence],
                    requires_host_confirmation=not bool(working_sku_id and sale_price and stock_limit),
                )
            )

    if any(term in lowered for term in ANNOUNCEMENT_TERMS):
        actions.append(
            ProposedAction(
                type="add_announcement",
                sku_id=working_sku_id,
                announcement_text=text,
                source_text=text,
                confidence=0.74,
                reason="The host asked to publish an announcement.",
                evidence=["announce"],
            )
        )

    if not actions:
        decisions.append(
            AgentDecision(
                agent="cohost",
                intent="noop",
                confidence=0.7,
                reason="No supported host commerce action was detected.",
                evidence=[],
            )
        )
        actions.append(
            ProposedAction(
                type="noop",
                source_text=text,
                confidence=0.7,
                reason="No supported host commerce action was detected.",
            )
        )

    return decisions, actions
