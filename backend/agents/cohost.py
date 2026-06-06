from __future__ import annotations

import re

from backend.models import AgentDecision, CommerceState, InputSource, ProposedAction
from backend.tools.sku_resolver import get_sku_by_id, resolve_sku_from_text


PRICE_RE = re.compile(
    r"(?:drop|make|set|price|at|to|for)\D{0,16}(\d+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
FLASH_RE = re.compile(
    r"first\s+(\d+)\s+(?:buyers|orders|people)?.*?(?:at|for)\s+\$?(\d+(?:\.\d{1,2})?).*?(\d+)\s+minutes?",
    re.IGNORECASE,
)


def cents_from_text(value: str) -> int:
    return int(round(float(value) * 100))


def analyze_host_text(
    text: str,
    state: CommerceState,
    input_source: InputSource,
) -> tuple[AgentDecision, list[ProposedAction]]:
    sku = resolve_sku_from_text(text, state.skus)
    contextual_sku = sku or get_sku_by_id(state.active_sku_id, state.skus)
    actions: list[ProposedAction] = []

    if sku:
        actions.append(
            ProposedAction(
                type="set_active_sku",
                sku_id=sku.id,
                source_text=text,
                input_source=input_source,
                confidence=0.93,
                reason=f"Matched product mention to {sku.name}.",
                evidence=[sku.name],
            )
        )

    lower_text = text.lower()
    if contextual_sku and "original price" in lower_text:
        actions.append(
            ProposedAction(
                type="restore_price",
                sku_id=contextual_sku.id,
                source_text=text,
                input_source=input_source,
                confidence=0.88,
                reason="Host asked to restore the product to original price.",
                evidence=["original price"],
            )
        )

    flash_match = FLASH_RE.search(text)
    if contextual_sku and flash_match:
        stock_limit, price_text, minutes_text = flash_match.groups()
        actions.append(
            ProposedAction(
                type="create_flash_sale",
                sku_id=contextual_sku.id,
                sale_price_cents=cents_from_text(price_text),
                stock_limit=int(stock_limit),
                duration_seconds=int(minutes_text) * 60,
                source_text=text,
                input_source=input_source,
                confidence=0.87,
                reason="Host specified a quantity-limited timed promotional price.",
                evidence=[flash_match.group(0)],
            )
        )
    elif "cancel" in lower_text and ("flash" in lower_text or "deal" in lower_text):
        actions.append(
            ProposedAction(
                type="cancel_flash_sale",
                sku_id=contextual_sku.id if contextual_sku else None,
                source_text=text,
                input_source=input_source,
                confidence=0.86,
                reason="Host asked to cancel the flash deal.",
                evidence=["cancel", "flash deal"],
            )
        )

    price_match = PRICE_RE.search(text)
    if contextual_sku and price_match and not flash_match and "original price" not in lower_text:
        actions.append(
            ProposedAction(
                type="update_price",
                sku_id=contextual_sku.id,
                price_cents=cents_from_text(price_match.group(1)),
                source_text=text,
                input_source=input_source,
                confidence=0.82,
                reason="Host requested a live price update.",
                evidence=[price_match.group(0)],
            )
        )

    if not actions:
        actions.append(
            ProposedAction(
                type="noop",
                source_text=text,
                input_source=input_source,
                confidence=0.35,
                reason="No supported host commerce action was detected.",
                evidence=[],
                requires_host_confirmation=True,
            )
        )

    decision = AgentDecision(
        agent="CoHostAgent",
        summary=f"Generated {len(actions)} proposed action(s) from host input.",
        confidence=max(action.confidence for action in actions),
        source_text=text,
    )
    return decision, actions
