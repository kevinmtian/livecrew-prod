from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


ActionType = Literal[
    "set_active_sku",
    "update_price",
    "restore_price",
    "create_flash_sale",
    "cancel_flash_sale",
    "suggest_reply",
    "request_host_confirmation",
    "noop",
]

InputSource = Literal["speech_transcript", "typed_command", "viewer_message", "host_ui"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def create_id(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:12]}"


class SKU(BaseModel):
    id: str
    name: str
    aliases: list[str]
    price_cents: int
    stock: int
    facts: list[str]
    base_price_cents: int | None = None

    def model_post_init(self, __context: Any) -> None:
        if self.base_price_cents is None:
            self.base_price_cents = self.price_cents


class FlashSale(BaseModel):
    sku_id: str
    sale_price_cents: int
    stock_limit: int
    remaining_stock: int
    duration_seconds: int
    created_at: datetime = Field(default_factory=utc_now)


class ProposedAction(BaseModel):
    type: ActionType
    source_text: str
    input_source: InputSource
    sku_id: str | None = None
    price_cents: int | None = None
    sale_price_cents: int | None = None
    duration_seconds: int | None = None
    stock_limit: int | None = None
    reply_text: str | None = None
    confidence: float = 0.0
    reason: str | None = None
    evidence: list[str] = Field(default_factory=list)
    requires_host_confirmation: bool = False


class AgentDecision(BaseModel):
    id: str = Field(default_factory=lambda: create_id("decision"))
    agent: Literal["CoHostAgent", "ConciergeAgent", "ProducerAgent"]
    summary: str
    confidence: float
    source_text: str
    created_at: datetime = Field(default_factory=utc_now)


class GuardrailResult(BaseModel):
    action_type: ActionType
    allowed: bool
    status: Literal["allowed", "blocked", "needs_host_confirmation"]
    reason: str


class AppliedAction(BaseModel):
    type: ActionType
    sku_id: str | None = None
    detail: str


class LedgerEntry(BaseModel):
    id: str = Field(default_factory=lambda: create_id("ledger"))
    type: str
    detail: str
    source_text: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class PendingAction(BaseModel):
    id: str = Field(default_factory=lambda: create_id("pending"))
    action: ProposedAction
    guardrail_result: GuardrailResult
    status: Literal["pending", "approved", "rejected", "overridden"] = "pending"
    created_at: datetime = Field(default_factory=utc_now)


class CommerceState(BaseModel):
    active_sku_id: str | None = None
    skus: list[SKU]
    flash_sale: FlashSale | None = None
    pending_actions: list[PendingAction] = Field(default_factory=list)
    ledger: list[LedgerEntry] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=utc_now)


class WorkflowResponse(BaseModel):
    agent_decisions: list[AgentDecision] = Field(default_factory=list)
    proposed_actions: list[ProposedAction] = Field(default_factory=list)
    guardrail_results: list[GuardrailResult] = Field(default_factory=list)
    pending_actions: list[PendingAction] = Field(default_factory=list)
    applied_actions: list[AppliedAction] = Field(default_factory=list)
    ledger_entries: list[LedgerEntry] = Field(default_factory=list)
    state: CommerceState


class TextEventRequest(BaseModel):
    text: str
    source: InputSource = "typed_command"


class ViewerMessageRequest(BaseModel):
    viewer: str = "viewer"
    text: str


class TranscriptionResponse(BaseModel):
    text: str
    source: Literal["openai", "unavailable"]


class MediaSession(BaseModel):
    session_id: str
    status: Literal["waiting", "offer_ready", "answer_ready", "live", "stopped"] = "waiting"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    offer: dict[str, Any] | None = None
    answer: dict[str, Any] | None = None
    host_candidates: list[dict[str, Any]] = Field(default_factory=list)
    viewer_candidates: list[dict[str, Any]] = Field(default_factory=list)


class SessionCreateResponse(BaseModel):
    session_id: str


class SignalPayload(BaseModel):
    payload: dict[str, Any]
    role: Literal["host", "viewer"] = "host"
