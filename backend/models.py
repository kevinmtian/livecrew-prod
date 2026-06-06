from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


ActionType = Literal[
    "set_active_sku",
    "update_price",
    "restore_price",
    "create_flash_sale",
    "cancel_flash_sale",
    "create_order",
    "suggest_reply",
    "add_announcement",
    "host_override",
    "request_host_confirmation",
    "noop",
]


class SKU(BaseModel):
    id: str
    name: str
    aliases: List[str]
    base_price_cents: int
    current_price_cents: int
    stock: int
    facts: List[str]


class FlashSale(BaseModel):
    sku_id: str
    original_price_cents: int
    sale_price_cents: int
    starting_stock: int
    remaining_stock: int
    starts_at: datetime
    ends_at: datetime
    active: bool = True


class Order(BaseModel):
    id: str
    viewer: str
    sku_id: str
    quantity: int
    unit_price_cents: int
    total_price_cents: int
    used_flash_sale: bool
    created_at: datetime


class Announcement(BaseModel):
    id: str
    text: str
    created_at: datetime


class CommerceMetrics(BaseModel):
    total_units_sold: int = 0
    total_gmv_cents: int = 0
    questions_handled: int = 0
    risk_events: int = 0


class ProposedAction(BaseModel):
    type: ActionType
    sku_id: Optional[str] = None
    quantity: Optional[int] = None
    price_cents: Optional[int] = None
    sale_price_cents: Optional[int] = None
    duration_seconds: Optional[int] = None
    stock_limit: Optional[int] = None
    reply_text: Optional[str] = None
    announcement_text: Optional[str] = None
    override_type: Optional[Literal["sku", "answer", "order", "price", "promotion"]] = None
    target_event_id: Optional[str] = None
    source_text: str
    confidence: float = Field(ge=0, le=1)
    reason: Optional[str] = None
    evidence: List[str] = Field(default_factory=list)
    requires_host_confirmation: bool = False


class GuardrailResult(BaseModel):
    action_type: ActionType
    decision: Literal["allow", "block", "confirm"]
    risk_level: Literal["low", "medium", "high"]
    message: str
    reasons: List[str] = Field(default_factory=list)


class PendingAction(BaseModel):
    id: str
    action: ProposedAction
    guardrail_result: GuardrailResult
    requested_by: Literal["cohost", "concierge", "guardrail", "host_ui"]
    status: Literal["pending", "approved", "rejected", "overridden"] = "pending"
    created_at: datetime
    resolved_at: Optional[datetime] = None


class AppliedAction(BaseModel):
    type: ActionType
    sku_id: Optional[str] = None
    message: str
    payload: Dict[str, Any] = Field(default_factory=dict)


class LedgerEntry(BaseModel):
    id: str
    type: str
    actor: str
    sku_id: Optional[str]
    message: str
    payload: Dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class AgentDecision(BaseModel):
    agent: Literal["cohost", "concierge", "producer", "guardrail", "commerce"]
    intent: str
    confidence: float = Field(ge=0, le=1)
    reason: str
    evidence: List[str] = Field(default_factory=list)


class CommerceState(BaseModel):
    active_sku_id: Optional[str]
    skus: List[SKU]
    flash_sale: Optional[FlashSale]
    orders: List[Order]
    announcements: List[Announcement]
    pending_actions: List[PendingAction]
    ledger: List[LedgerEntry]
    metrics: CommerceMetrics


class ProducerReport(BaseModel):
    listed_sku_ids: List[str]
    total_units_sold: int
    total_gmv_cents: int
    per_product: List[Dict[str, Any]]
    flash_sale: Optional[Dict[str, Any]]
    questions_handled: int
    risk_events: int
    host_learning: List[str]
    next_recommendations: List[str]


class WorkflowResponse(BaseModel):
    agent_decisions: List[AgentDecision] = Field(default_factory=list)
    proposed_actions: List[ProposedAction] = Field(default_factory=list)
    guardrail_results: List[GuardrailResult] = Field(default_factory=list)
    pending_actions: List[PendingAction] = Field(default_factory=list)
    applied_actions: List[AppliedAction] = Field(default_factory=list)
    ledger_entries: List[LedgerEntry] = Field(default_factory=list)
    suggested_reply: Optional[str] = None
    report: Optional[ProducerReport] = None
    state: CommerceState


class HostTranscriptRequest(BaseModel):
    text: str


class ViewerMessageRequest(BaseModel):
    text: str
    viewer: str = "viewer"


class AnnouncementRequest(BaseModel):
    text: str


class FlashSaleRequest(BaseModel):
    sku_id: Optional[str] = None
    sale_price_cents: int
    duration_seconds: int = 300
    stock_limit: int


class HostOverrideRequest(BaseModel):
    pending_action_id: Optional[str] = None
    action: ProposedAction


class PendingActionEditRequest(BaseModel):
    reply_text: str
