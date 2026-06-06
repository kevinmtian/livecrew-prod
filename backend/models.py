from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

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

Actor = Literal["host", "viewer", "agent", "guardrail", "system"]
Decision = Literal["allow", "block", "host_review", "ask_clarification", "noop"]
RiskLevel = Literal["low", "medium", "high"]


class SKU(BaseModel):
    id: str
    name: str
    aliases: list[str] = []
    base_price_cents: int = Field(gt=0)
    current_price_cents: int = Field(gt=0)
    stock: int = Field(ge=0)
    facts: list[str] = []


class FlashSale(BaseModel):
    id: str
    sku_id: str
    original_price_cents: int = Field(gt=0)
    sale_price_cents: int = Field(gt=0)
    starting_stock: int = Field(ge=0)
    remaining_stock: int = Field(ge=0)
    starts_at: datetime
    ends_at: datetime
    active: bool = True


class Order(BaseModel):
    id: str
    sku_id: str
    qty: int = Field(gt=0)
    unit_price_cents: int = Field(gt=0)
    viewer: str
    flash_sale_applied: bool = False
    created_at: datetime


class Announcement(BaseModel):
    id: str
    message: str
    source: Literal["host", "agent", "system"] = "host"
    created_at: datetime


class CommerceMetrics(BaseModel):
    total_units_sold: int = 0
    total_gmv_cents: int = 0


class LedgerEntry(BaseModel):
    id: str
    type: str
    actor: Actor
    sku_id: Optional[str] = None
    message: str
    payload: dict[str, Any] = {}
    created_at: datetime


class ProposedAction(BaseModel):
    type: ActionType
    sku_id: Optional[str] = None
    quantity: Optional[int] = Field(default=None, gt=0)
    price_cents: Optional[int] = Field(default=None, gt=0)
    sale_price_cents: Optional[int] = Field(default=None, gt=0)
    duration_seconds: Optional[int] = Field(default=None, gt=0)
    stock_limit: Optional[int] = Field(default=None, gt=0)
    reply_text: Optional[str] = None
    announcement_text: Optional[str] = None
    override_type: Optional[Literal["sku", "answer", "order", "price", "promotion"]] = None
    target_event_id: Optional[str] = None
    source_text: str
    confidence: float = Field(ge=0, le=1)
    reason: Optional[str] = None
    evidence: list[str] = []
    requires_host_confirmation: bool = False


class GuardrailResult(BaseModel):
    action_type: ActionType
    decision: Decision
    risk_level: RiskLevel
    allowed: bool
    blocked_claims: list[str] = []
    reason: str


class PendingAction(BaseModel):
    id: str
    action: ProposedAction
    guardrail_result: GuardrailResult
    requested_by: Literal["cohost", "concierge", "guardrail", "host_ui"]
    status: Literal["pending", "approved", "rejected", "overridden"] = "pending"
    created_at: datetime


class AppliedAction(BaseModel):
    id: str
    action: ProposedAction
    ledger_entry: LedgerEntry
    created_at: datetime


class CommerceState(BaseModel):
    active_sku_id: Optional[str] = None
    skus: dict[str, SKU]
    flash_sale: Optional[FlashSale] = None
    orders: list[Order] = []
    announcements: list[Announcement] = []
    pending_actions: list[PendingAction] = []
    ledger: list[LedgerEntry] = []
    metrics: CommerceMetrics = CommerceMetrics()


class AgentDecision(BaseModel):
    owner: Literal["cohost", "concierge", "producer", "guardrail"]
    intent: str
    confidence: float = Field(ge=0, le=1)
    reason: str
    evidence: list[str] = []


class ProducerReport(BaseModel):
    generated_at: datetime
    total_units_sold: int
    total_gmv_cents: int
    per_sku: list[dict[str, Any]]
    flash_sale: Optional[dict[str, Any]] = None
    risk_events: list[LedgerEntry] = []
    notes: list[str] = []


class WorkflowResponse(BaseModel):
    agent_decisions: list[AgentDecision] = []
    proposed_actions: list[ProposedAction] = []
    guardrail_results: list[GuardrailResult] = []
    pending_actions: list[PendingAction] = []
    applied_actions: list[AppliedAction] = []
    ledger_entries: list[LedgerEntry] = []
    suggested_reply: Optional[str] = None
    report: Optional[ProducerReport] = None
    state: Optional[CommerceState] = None
