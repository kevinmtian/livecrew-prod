from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from threading import Lock
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from backend.models import (
    AgentDecision,
    CoHostDebugMessage,
    CoHostDebugMessagesResponse,
    CommerceState,
    InputSource,
    ProposedAction,
    utc_now,
)
from backend.openai_client import get_openai_client
from backend.tools.sku_resolver import get_sku_by_id, resolve_sku_from_text


PRICE_RE = re.compile(
    r"(?:drop|make|set|price|at|to|for)\D{0,16}(\d+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
FLASH_RE = re.compile(
    r"first\s+(\d+)\s+(?:buyers|orders|people)?.*?(?:at|for)\s+\$?(\d+(?:\.\d{1,2})?).*?(\d+)\s+minutes?",
    re.IGNORECASE | re.DOTALL,
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
MAX_USER_MESSAGES = 50
SUMMARY_USER_MESSAGES = 25
SUMMARY_MAX_CHARS = 7000


@dataclass
class CoHostMessage:
    role: Literal["system", "user", "assistant"]
    content: str
    source_text: str = ""
    is_open_user: bool = False


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


def _action_list_prompt() -> str:
    return "\n".join(
        [
            "- set_active_sku(sku_id)",
            "- update_price(sku_id, price_cents)",
            "- restore_price(sku_id)",
            "- update_stock(sku_id, stock)",
            "- create_flash_sale(sku_id, sale_price_cents, duration_seconds, stock_limit)",
            "- cancel_flash_sale(sku_id)",
            "- noop()",
        ]
    )


def _commerce_state_prompt(state: CommerceState) -> str:
    flash_sale = state.flash_sale.model_dump(mode="json") if state.flash_sale else None
    pending_actions = [
        pending.action.model_dump(mode="json", exclude_none=True)
        for pending in state.pending_actions[:10]
    ]
    return json.dumps(
        {
            "active_sku_id": state.active_sku_id,
            "flash_sale": flash_sale,
            "pending_actions": pending_actions,
        },
        ensure_ascii=False,
        indent=2,
    )


def _system_prompt(state: CommerceState) -> str:
    return (
        "You are LiveCrew's CoHostAgent. Extract host livestream commerce "
        "operations from chronological host transcript and assistant action-trace "
        "messages into structured tool calls. Support English, Chinese, and "
        "mixed-language phrasing. Return actions in the order the host intends "
        "them to happen.\n\n"
        "The user messages may contain merged transcript fragments when earlier "
        "fragments were not actionable by themselves. Use the latest unresolved "
        "host user message plus relevant prior action traces. Do not repeat a "
        "tool call already present in assistant action traces or pending actions "
        "unless the host clearly changes the request.\n\n"
        "Speech transcripts can contain minor recognition errors in commerce "
        "keywords. Infer the host's likely command when the transcript is close "
        "to a supported operation and all required fields are grounded by the "
        "raw text plus current context; for example, interpret 'Set talk to 100' "
        "as 'Set stock to 100' for the active SKU. Keep the raw transcript in "
        "evidence and mention the inferred correction in the reason. Do not "
        "repair vague or unsupported text into an action, and require host "
        "confirmation or return noop when the correction is uncertain.\n\n"
        "Supported action tool calls:\n"
        f"{_action_list_prompt()}\n\n"
        "Catalogue:\n"
        f"{_catalogue_prompt(state)}\n\n"
        "Current backend commerce state:\n"
        f"{_commerce_state_prompt(state)}\n\n"
        "Rules: Use only SKU ids from the catalogue. If a flash sale, price, "
        "stock, restore, or cancel action has no explicit product, use the "
        "current active SKU. Convert money expressions to integer cents, duration "
        "expressions to seconds, stock updates to integer stock, and quantity "
        "limits to integer stock_limit. For create_flash_sale, sale_price_cents "
        "must come from the host's promotional price expression, not the catalogue "
        "or current SKU price. Do not invent missing price, duration, quantity, "
        "SKU, discounts, delivery promises, or unsupported claims. If required "
        "fields are missing for update_price, update_stock, or create_flash_sale, "
        "return noop so the next transcript segment can be merged and re-analyzed. "
        "Use requires_host_confirmation only for complete but risky or ambiguous "
        "tool calls."
    )


def _format_user_segment(text: str, input_source: InputSource) -> str:
    timestamp = utc_now().isoformat()
    return f"- {timestamp} [{input_source}] {text.strip()}"


def _assistant_trace(actions: list[ProposedAction]) -> str:
    return json.dumps(
        {
            "cohost_tool_calls": [
                action.model_dump(mode="json", exclude_none=True)
                for action in actions
            ]
        },
        ensure_ascii=False,
        indent=2,
    )


def _summarize_message_span(messages: list[CoHostMessage]) -> CoHostMessage:
    lines = [
        "Summary of earlier CoHost context. This summary is memory only; "
        "current commerce facts must come from backend state and ledger."
    ]
    for message in messages:
        role = message.role
        content = message.content.replace("\n", " ").strip()
        if len(content) > 900:
            content = f"{content[:900]}..."
        lines.append(f"{role}: {content}")

    summary = "\n".join(lines)
    if len(summary) > SUMMARY_MAX_CHARS:
        summary = f"{summary[:SUMMARY_MAX_CHARS]}..."
    return CoHostMessage(role="user", content=summary, source_text=summary)


def _is_only_noop(actions: list[ProposedAction]) -> bool:
    return not actions or all(action.type == "noop" for action in actions)


class CoHostConversationContext:
    def __init__(self) -> None:
        self._lock = Lock()
        self._messages: list[CoHostMessage] = [
            CoHostMessage(role="system", content="CoHostAgent system prompt pending.")
        ]

    def reset(self) -> None:
        with self._lock:
            self._messages = [
                CoHostMessage(role="system", content="CoHostAgent system prompt pending.")
            ]

    def prepare_model_messages(
        self,
        text: str,
        state: CommerceState,
        input_source: InputSource,
    ) -> tuple[str, list[dict[str, str]]]:
        with self._lock:
            self._messages[0] = CoHostMessage(role="system", content=_system_prompt(state))
            self._append_or_merge_user_message(text, input_source)
            self._summarize_if_needed()
            return self._current_user_source_text(), self._messages_for_model()

    def record_assistant_actions(self, actions: list[ProposedAction]) -> None:
        with self._lock:
            if _is_only_noop(actions):
                return

            for message in self._messages:
                message.is_open_user = False
            self._messages.append(
                CoHostMessage(role="assistant", content=_assistant_trace(actions))
            )
            self._summarize_if_needed()

    def debug_snapshot(self, state: CommerceState) -> CoHostDebugMessagesResponse:
        with self._lock:
            self._messages[0] = CoHostMessage(role="system", content=_system_prompt(state))
            return CoHostDebugMessagesResponse(
                messages=[
                    CoHostDebugMessage(
                        role=message.role,
                        content=message.content,
                        source_text=message.source_text,
                        is_open_user=message.is_open_user,
                    )
                    for message in self._messages
                ]
            )

    def _append_or_merge_user_message(self, text: str, input_source: InputSource) -> None:
        clean_text = text.strip()
        if not clean_text:
            return

        segment = _format_user_segment(clean_text, input_source)
        open_user = next(
            (message for message in reversed(self._messages) if message.is_open_user),
            None,
        )
        if open_user:
            open_user.content = f"{open_user.content}\n{segment}"
            open_user.source_text = f"{open_user.source_text}\n{clean_text}".strip()
            return

        self._messages.append(
            CoHostMessage(
                role="user",
                content=f"Host transcript segments awaiting CoHost action:\n{segment}",
                source_text=clean_text,
                is_open_user=True,
            )
        )

    def _current_user_source_text(self) -> str:
        open_user = next(
            (message for message in reversed(self._messages) if message.is_open_user),
            None,
        )
        if open_user:
            return open_user.source_text

        last_user = next(
            (message for message in reversed(self._messages) if message.role == "user"),
            None,
        )
        return last_user.source_text if last_user else ""

    def _messages_for_model(self) -> list[dict[str, str]]:
        return [
            {"role": message.role, "content": message.content}
            for message in self._messages
        ]

    def _summarize_if_needed(self) -> None:
        user_indices = [
            index
            for index, message in enumerate(self._messages)
            if message.role == "user"
        ]
        if len(user_indices) <= MAX_USER_MESSAGES:
            return

        selected_user_indices = user_indices[:SUMMARY_USER_MESSAGES]
        start_index = selected_user_indices[0]
        end_index = selected_user_indices[-1]
        summary_message = _summarize_message_span(self._messages[start_index : end_index + 1])
        self._messages = [
            *self._messages[:start_index],
            summary_message,
            *self._messages[end_index + 1 :],
        ]


cohost_conversation_context = CoHostConversationContext()


def reset_cohost_context() -> None:
    cohost_conversation_context.reset()


def get_cohost_debug_messages(state: CommerceState) -> CoHostDebugMessagesResponse:
    return cohost_conversation_context.debug_snapshot(state)


def _extract_actions_with_openai(
    messages: list[dict[str, str]],
) -> list[ExtractedHostAction] | None:
    client = get_openai_client()
    if client is None:
        return None

    model = os.getenv("OPENAI_COHOST_MODEL", "gpt-5.4-mini")

    try:
        completion = client.beta.chat.completions.parse(
            model=model,
            temperature=0,
            messages=messages,
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
    missing_fields = _missing_required_fields(
        action_type,
        sku_id,
        price_cents,
        stock,
        sale_price_cents,
        duration_seconds,
        stock_limit,
    )
    if missing_fields:
        return ProposedAction(
            type="noop",
            source_text=text,
            input_source=input_source,
            confidence=min(extracted.confidence, 0.45),
            reason=(
                "CoHost is waiting for more host context before creating a "
                f"{action_type} tool call; missing {', '.join(missing_fields)}."
            ),
            evidence=extracted.evidence,
        )

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


def _missing_required_fields(
    action_type: str,
    sku_id: str | None,
    price_cents: int | None,
    stock: int | None,
    sale_price_cents: int | None,
    duration_seconds: int | None,
    stock_limit: int | None,
) -> list[str]:
    required_fields: dict[str, list[tuple[str, object | None]]] = {
        "set_active_sku": [("sku_id", sku_id)],
        "update_price": [("sku_id", sku_id), ("price_cents", price_cents)],
        "restore_price": [("sku_id", sku_id)],
        "update_stock": [("sku_id", sku_id), ("stock", stock)],
        "create_flash_sale": [
            ("sku_id", sku_id),
            ("sale_price_cents", sale_price_cents),
            ("duration_seconds", duration_seconds),
            ("stock_limit", stock_limit),
        ],
        "cancel_flash_sale": [("sku_id", sku_id)],
    }
    return [
        field_name
        for field_name, value in required_fields.get(action_type, [])
        if value is None
    ]


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
    promo_context = _has_promo_context(lower_text)
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
        and not promo_context
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


def _has_promo_context(lower_text: str) -> bool:
    promo_markers = (
        "flash",
        "deal",
        "promo",
        "promotion",
        "first",
        "buyer",
        "buyers",
        "order",
        "orders",
        "minute",
        "minutes",
        "闪促",
        "促销",
        "限时",
        "限量",
        "前",
    )
    return any(marker in lower_text for marker in promo_markers)


def analyze_host_text(
    text: str,
    state: CommerceState,
    input_source: InputSource,
) -> tuple[AgentDecision, list[ProposedAction]]:
    source_text, messages = cohost_conversation_context.prepare_model_messages(
        text,
        state,
        input_source,
    )
    try:
        extracted_actions = _extract_actions_with_openai(messages)
        if extracted_actions is not None:
            actions = _to_proposed_actions(
                extracted_actions,
                source_text,
                state,
                input_source,
            )
            if actions:
                decision = AgentDecision(
                    agent="CoHostAgent",
                    summary=f"Generated {len(actions)} proposed action(s) using OpenAI structured extraction.",
                    confidence=max(action.confidence for action in actions),
                    source_text=source_text,
                )
                cohost_conversation_context.record_assistant_actions(actions)
                return decision, actions
    except (ValidationError, ValueError):
        pass

    decision, actions = _analyze_host_text_deterministic(source_text, state, input_source)
    cohost_conversation_context.record_assistant_actions(actions)
    return decision, actions
