from __future__ import annotations

import os
import re
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from backend.models import AgentDecision, CommerceState, InputSource, ProposedAction
from backend.openai_client import get_openai_client
from backend.tools.sku_resolver import get_sku_by_id, resolve_sku_from_text


PRICE_RE = re.compile(
    r"(?:drop|make|set|price|at|to|for)\D{0,16}(\d+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
FLASH_RE = re.compile(
    r"first\s+(\d+)\s+(?:buyers|orders|people)?.*?(?:at|for)\s+\$?(\d+(?:\.\d{1,2})?).*?(\d+)\s+minutes?",
    re.IGNORECASE,
)
STOCK_RE = re.compile(
    r"(?:stock|inventory|units)\D{0,24}(\d+)",
    re.IGNORECASE,
)
SUPPORTED_COHOST_ACTIONS = {
    "set_active_sku",
    "update_price",
    "update_stock",
    "restore_price",
    "create_flash_sale",
    "cancel_flash_sale",
    "noop",
}


class ExtractedHostAction(BaseModel):
    type: Literal[
        "set_active_sku",
        "update_price",
        "update_stock",
        "restore_price",
        "create_flash_sale",
        "cancel_flash_sale",
        "noop",
    ]
    sku_id: str | None = None
    price_cents: int | None = None
    stock: int | None = None
    sale_price_cents: int | None = None
    duration_seconds: int | None = None
    stock_limit: int | None = None
    confidence: float = Field(ge=0, le=1)
    reason: str
    evidence: list[str] = Field(default_factory=list)
    requires_host_confirmation: bool = False


class HostActionExtraction(BaseModel):
    actions: list[ExtractedHostAction] = Field(default_factory=list)


def cents_from_text(value: str) -> int:
    return int(round(float(value) * 100))


def _catalogue_prompt(state: CommerceState) -> str:
    sku_lines = []
    for sku in state.skus:
        aliases = ", ".join(sku.aliases)
        sku_lines.append(
            f"- id={sku.id}; name={sku.name}; aliases={aliases}; "
            f"current_price_cents={sku.price_cents}; stock={sku.stock}"
        )
    return "\n".join(sku_lines)


def _extract_actions_with_openai(
    text: str,
    state: CommerceState,
) -> list[ExtractedHostAction] | None:
    client = get_openai_client()
    if client is None:
        return None

    model = os.getenv("OPENAI_COHOST_MODEL", "gpt-4o-mini")
    system_prompt = (
        "You are LiveCrew's CoHostAgent. Extract host livestream commerce "
        "operations from natural language into structured actions. Support "
        "English, Chinese, and mixed-language phrasing. Return actions in the "
        "order the host intends them to happen.\n\n"
        "Supported action types: set_active_sku, update_price, restore_price, "
        "update_stock, create_flash_sale, cancel_flash_sale, noop.\n"
        "Use only SKU ids from the provided catalogue. If a flash sale or price "
        "or stock action has no explicit product, use the current active SKU. Convert "
        "money expressions to integer cents, duration expressions to seconds, "
        "stock updates to integer stock, and quantity limits to integer stock_limit. "
        "For create_flash_sale, "
        "sale_price_cents must come from the host's promotional price expression, "
        "not the catalogue or current SKU price. Do not invent missing price, "
        "duration, quantity, SKU, discounts, delivery promises, or unsupported claims. "
        "If required fields are ambiguous or missing, return noop or mark the "
        "action as requiring host confirmation."
    )
    user_prompt = (
        f"Current active SKU id: {state.active_sku_id or 'none'}\n"
        f"Catalogue:\n{_catalogue_prompt(state)}\n\n"
        f"Host text:\n{text}"
    )

    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            temperature=0,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            response_format=HostActionExtraction,
        )
    except Exception:
        return None

    parsed = completion.choices[0].message.parsed
    if parsed is None:
        return None
    return parsed.actions


def _to_proposed_actions(
    extracted_actions: list[ExtractedHostAction],
    text: str,
    state: CommerceState,
    input_source: InputSource,
) -> list[ProposedAction]:
    valid_sku_ids = {sku.id for sku in state.skus}
    proposed_actions: list[ProposedAction] = []

    for extracted in extracted_actions[:6]:
        action_type = extracted.type
        if action_type not in SUPPORTED_COHOST_ACTIONS:
            continue

        sku_id = extracted.sku_id
        if sku_id and sku_id not in valid_sku_ids:
            proposed_actions.append(
                ProposedAction(
                    type="noop",
                    source_text=text,
                    input_source=input_source,
                    confidence=min(extracted.confidence, 0.4),
                    reason=f"OpenAI proposed unknown SKU id: {sku_id}.",
                    evidence=extracted.evidence,
                )
            )
            continue

        if action_type in {
            "update_price",
            "update_stock",
            "restore_price",
            "create_flash_sale",
            "cancel_flash_sale",
        } and not sku_id:
            sku_id = state.active_sku_id

        proposed_actions.append(
            _build_proposed_action(extracted, action_type, sku_id, text, input_source)
        )

    return _with_display_sku_action(proposed_actions, text, state, input_source)


def _build_proposed_action(
    extracted: ExtractedHostAction,
    action_type: str,
    sku_id: str | None,
    text: str,
    input_source: InputSource,
) -> ProposedAction:
    price_cents = extracted.price_cents if action_type == "update_price" else None
    stock = extracted.stock if action_type == "update_stock" else None
    sale_price_cents = extracted.sale_price_cents if action_type == "create_flash_sale" else None
    duration_seconds = extracted.duration_seconds if action_type == "create_flash_sale" else None
    stock_limit = extracted.stock_limit if action_type == "create_flash_sale" else None

    return ProposedAction(
        type=action_type,
        sku_id=sku_id,
        price_cents=price_cents,
        stock=stock,
        sale_price_cents=sale_price_cents,
        duration_seconds=duration_seconds,
        stock_limit=stock_limit,
        source_text=text,
        input_source=input_source,
        confidence=extracted.confidence,
        reason=extracted.reason,
        evidence=extracted.evidence,
        requires_host_confirmation=extracted.requires_host_confirmation,
    )


def _with_display_sku_action(
    actions: list[ProposedAction],
    text: str,
    state: CommerceState,
    input_source: InputSource,
) -> list[ProposedAction]:
    if any(action.type == "set_active_sku" for action in actions):
        return actions

    first_referenced_sku_id = next(
        (
            action.sku_id
            for action in actions
            if action.type
            in {"update_price", "update_stock", "restore_price", "create_flash_sale"}
            and action.sku_id
            and action.sku_id != state.active_sku_id
        ),
        None,
    )
    if not first_referenced_sku_id:
        return actions

    sku = get_sku_by_id(first_referenced_sku_id, state.skus)
    return [
        ProposedAction(
            type="set_active_sku",
            sku_id=first_referenced_sku_id,
            source_text=text,
            input_source=input_source,
            confidence=0.9,
            reason=f"Keep the live shelf aligned with {sku.name if sku else first_referenced_sku_id}.",
            evidence=[sku.name if sku else first_referenced_sku_id],
        ),
        *actions,
    ]


def _analyze_host_text_deterministic(
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
    stock_match = STOCK_RE.search(text)
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

    if contextual_sku and stock_match and not flash_match:
        actions.append(
            ProposedAction(
                type="update_stock",
                sku_id=contextual_sku.id,
                stock=int(stock_match.group(1)),
                source_text=text,
                input_source=input_source,
                confidence=0.84,
                reason="Host requested a live stock update.",
                evidence=[stock_match.group(0)],
            )
        )

    price_match = PRICE_RE.search(text)
    if (
        contextual_sku
        and price_match
        and not flash_match
        and not stock_match
        and "original price" not in lower_text
    ):
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
            )
        )

    decision = AgentDecision(
        agent="CoHostAgent",
        summary=f"Generated {len(actions)} proposed action(s) from host input.",
        confidence=max(action.confidence for action in actions),
        source_text=text,
    )
    return decision, actions


def analyze_host_text(
    text: str,
    state: CommerceState,
    input_source: InputSource,
) -> tuple[AgentDecision, list[ProposedAction]]:
    try:
        extracted_actions = _extract_actions_with_openai(text, state)
        if extracted_actions is not None:
            actions = _to_proposed_actions(extracted_actions, text, state, input_source)
            if actions:
                decision = AgentDecision(
                    agent="CoHostAgent",
                    summary=f"Generated {len(actions)} proposed action(s) using OpenAI structured extraction.",
                    confidence=max(action.confidence for action in actions),
                    source_text=text,
                )
                return decision, actions
    except (ValidationError, ValueError):
        pass

    return _analyze_host_text_deterministic(text, state, input_source)
