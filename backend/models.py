from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


ActionType = Literal[
    "set_active_sku",
    "update_price",
    "update_stock",
    "restore_price",
    "create_flash_sale",
    "cancel_flash_sale",
    "create_order",
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
    quantity: int | None = None
    price_cents: int | None = None
    stock: int | None = None
    sale_price_cents: int | None = None
    duration_seconds: int | None = None
    stock_limit: int | None = None
    reply_text: str | None = None
    viewer: str | None = None
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


class Order(BaseModel):
    id: str = Field(default_factory=lambda: create_id("order"))
    sku_id: str
    quantity: int
    unit_price_cents: int
    viewer: str
    created_at: datetime = Field(default_factory=utc_now)


class ViewerSession(BaseModel):
    id: str = Field(default_factory=lambda: create_id("viewer-session"))
    username: str
    created_at: datetime = Field(default_factory=utc_now)


class LedgerEntry(BaseModel):
    id: str = Field(default_factory=lambda: create_id("ledger"))
    type: str
    detail: str
    source_text: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utc_now)


class ViewerComment(BaseModel):
    id: str = Field(default_factory=lambda: create_id("comment"))
    viewer: str = "viewer"
    text: str
    sku_id: str | None = None
    suggested_reply: str | None = None
    reply_status: Literal["suggested", "needs_host", "blocked", "none"] = "none"
    intent: str | None = None
    created_at: datetime = Field(default_factory=utc_now)


class WordCloudTerm(BaseModel):
    text: str
    weight: int = Field(ge=1, le=10)
    count: int = Field(ge=1)


class ViewerInsightMetric(BaseModel):
    label: str
    count: int = Field(ge=1)
    weight: int = Field(ge=1, le=10)


class ViewerInsightSnapshot(BaseModel):
    id: str = Field(default_factory=lambda: create_id("insight"))
    window_started_at: datetime
    window_ended_at: datetime
    active_sku_id: str | None = None
    comment_count: int
    terms: list[WordCloudTerm] = Field(default_factory=list)
    intent_breakdown: list[ViewerInsightMetric] = Field(default_factory=list)
    summary: str
    suggested_replies: list[str] = Field(default_factory=list)
    source_comment_ids: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)


class PendingAction(BaseModel):
    id: str = Field(default_factory=lambda: create_id("pending"))
    action: ProposedAction
    guardrail_result: GuardrailResult
    requested_by: Literal["cohost", "concierge", "guardrail", "host_ui"] = "guardrail"
    status: Literal["pending", "approved", "rejected", "overridden"] = "pending"
    created_at: datetime = Field(default_factory=utc_now)


class CommerceState(BaseModel):
    active_sku_id: str | None = None
    skus: list[SKU]
    flash_sale: FlashSale | None = None
    viewer_sessions: list[ViewerSession] = Field(default_factory=list)
    viewer_comments: list[ViewerComment] = Field(default_factory=list)
    viewer_insights: list[ViewerInsightSnapshot] = Field(default_factory=list)
    orders: list[Order] = Field(default_factory=list)
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
    suggested_reply: str | None = None
    state: CommerceState


class TextEventRequest(BaseModel):
    text: str
    source: InputSource = "typed_command"


class ViewerMessageRequest(BaseModel):
    viewer: str = "viewer"
    text: str


class ViewerLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=32)


class ViewerLoginResponse(BaseModel):
    session: ViewerSession
    state: CommerceState


class PendingReplyRequest(BaseModel):
    reply_text: str | None = None


class ViewerInsightRequest(BaseModel):
    window_seconds: int = Field(default=180, ge=30, le=900)


class ViewerAnswerAssessmentRequest(BaseModel):
    question: str = Field(min_length=1)
    host_transcript: str = Field(min_length=1)


class ViewerAnswerAssessmentResponse(BaseModel):
    answered: bool = False


class CoHostDebugMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str
    source_text: str = ""
    is_open_user: bool = False


class CoHostDebugMessagesResponse(BaseModel):
    messages: list[CoHostDebugMessage] = Field(default_factory=list)


class MonitorSignalRequest(BaseModel):
    online_viewers: int = Field(ge=0)
    online_viewers_delta: float
    gpm_cents: int = Field(ge=0)
    gpm_delta: float
    conversion_rate: float = Field(ge=0)
    conversion_rate_delta: float
    comment_sentiment: float = Field(ge=0, le=1)
    interaction_rate: float = Field(ge=0)
    intent_distribution: dict[str, int] = Field(default_factory=dict)
    high_intent_density: float = Field(ge=0, default=0)
    top_question: str | None = None
    top_question_count: int = Field(ge=0, default=0)


class ViewerHeartbeatRequest(BaseModel):
    session_id: str = Field(min_length=1)


class ViewerMetricEventRequest(BaseModel):
    session_id: str = Field(min_length=1)
    event_type: Literal["message", "like", "order"] = "message"
    text: str | None = None


class MonitorScenario(BaseModel):
    id: Literal["hesitation", "spike_push", "warm_retention", "cold_warning", "steady"]
    label: str
    reason: str
    urgency: Literal["low", "medium", "high"]


class MonitorHook(BaseModel):
    id: Literal["suspense", "order_push", "benefit", "interaction"]
    label: str
    host_cue: str | None = None
    script: str


class MonitorResponse(BaseModel):
    agent: Literal["MonitorAgent"] = "MonitorAgent"
    scenario: MonitorScenario
    hook: MonitorHook
    signals: dict[str, str]
    created_at: datetime = Field(default_factory=utc_now)


class TranscriptionResponse(BaseModel):
    text: str
    source: Literal["openai", "unavailable"]


class RealtimeTranscriptionTokenResponse(BaseModel):
    value: str
    expires_at: int | None = None
    session_id: str | None = None
    model: str


class RealtimeTranscriptionOfferRequest(BaseModel):
    sdp: str


class RealtimeTranscriptionOfferResponse(BaseModel):
    answer_sdp: str
    model: str
    session_id: str | None = None


class MediaSession(BaseModel):
    session_id: str
    status: Literal["waiting", "offer_ready", "answer_ready", "live", "stopped"] = "waiting"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    offer: dict[str, Any] | None = None
    answer: dict[str, Any] | None = None
    host_candidates: list[dict[str, Any]] = Field(default_factory=list)
    viewer_candidates: list[dict[str, Any]] = Field(default_factory=list)
    viewer_offers: dict[str, dict[str, Any]] = Field(default_factory=dict)
    viewer_answers: dict[str, dict[str, Any]] = Field(default_factory=dict)
    viewer_host_candidates: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    viewer_ice_candidates: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    viewer_ids: list[str] = Field(default_factory=list)


class SessionCreateResponse(BaseModel):
    session_id: str


class SignalPayload(BaseModel):
    payload: dict[str, Any]
    role: Literal["host", "viewer"] = "host"
    viewer_id: str | None = None
