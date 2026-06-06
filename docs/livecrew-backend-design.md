# LiveCrew Backend Technical Design

## 1. Purpose

LiveCrew is a host-led AI operations crew for livestream commerce. The backend should let a solo host run a complete live commerce flow with agent support.

The key product behavior is:

```text
Host speaks naturally
-> agents understand the operating intent
-> commerce state is validated and updated
-> host and viewer UI update in real time
-> all actions are recorded in an event ledger
```

The backend must support more than product Q&A. The host transcript is an action stream that can update product state during the live show.

Supported host-driven actions for the MVP:

- Switch or list the active SKU.
- Update a SKU's regular price.
- Restore a SKU's regular price to its base price.
- Create or cancel a limited-time flash sale.
- Publish a live announcement.
- Override an incorrect SKU, reply, order, price, or promotion.

The system should prefer reliable operations over agent freedom. LLMs may understand host language later, but they must not directly mutate commerce state.

## 2. Technology Stack

Recommended stack:

```text
Python
FastAPI
Pydantic
LangGraph
In-memory state
Server-Sent Events
```

Initial dependencies:

```text
fastapi
uvicorn
pydantic
langgraph
python-dotenv
```

Optional dependencies for the later OpenAI step:

```text
langchain
langchain-openai
openai
```

Do not use these for the MVP unless explicitly requested:

- PostgreSQL
- Redis
- Celery
- WebSocket room infrastructure
- Vector databases
- Real commerce APIs
- LangChain `create_agent` free-form loops

## 3. Architecture

```text
Next.js /host and /viewer
        |
        v
FastAPI routes
        |
        v
LangGraph orchestrator
        |
        v
Agent nodes
  - CoHostAgent
  - ConciergeAgent
  - ProducerAgent
        |
        v
Guardrail node
        |
        v
Commerce service
        |
        v
In-memory commerce state + event ledger
        |
        v
SSE realtime broadcast
```

Responsibilities:

- FastAPI exposes HTTP and SSE endpoints.
- LangGraph controls the workflow path and keeps agent orchestration explicit.
- Agents produce structured decisions and proposed actions.
- Guardrail node validates safety, ambiguity, and commerce risk.
- Confirmation gate stores risky or ambiguous actions until the host approves, rejects, or overrides them.
- Commerce service is the only module allowed to mutate state.
- Ledger records every applied or blocked action.
- SSE pushes state changes to `/host` and `/viewer`.

## 4. Module Layout

```text
backend/
  main.py
  models.py
  state.py
  ledger.py
  realtime.py
  commerce.py
  confirmations.py

  data/
    catalogue.py

  agents/
    cohost.py
    concierge.py
    producer.py

  graphs/
    livecrew_graph.py

  policies/
    guardrails.py
    pricing.py
    grounding.py

  tools/
    sku_resolver.py
    quantity_extractor.py
    reply_grounder.py

  eval/
    cases.py
    runner.py
```

Module responsibilities:

- `main.py`: FastAPI app and route handlers.
- `models.py`: Pydantic request, response, state, action, and ledger models.
- `state.py`: In-memory state container and reset helpers.
- `ledger.py`: Append-only ledger helpers.
- `realtime.py`: SSE broadcaster and subscriber queue management.
- `commerce.py`: Only state writer for product, price, sale, order, and announcement actions.
- `confirmations.py`: Pending host-confirmation queue for risky, ambiguous, or low-confidence actions.
- `data/catalogue.py`: Seeded product catalogue.
- `agents/cohost.py`: Host-facing operations agent for transcript understanding and proposed commerce actions.
- `agents/concierge.py`: Viewer-facing service agent for product answers, safe replies, and order proposals.
- `agents/producer.py`: Read-only post-stream report agent.
- `graphs/livecrew_graph.py`: LangGraph workflow.
- `policies/*`: Deterministic validation policies shared by graph nodes and tests.
- `tools/*`: Pure helper modules used by agents and deterministic fallbacks.
- `eval/*`: Deterministic evaluation suite.

The backend should avoid creating one agent per feature. New capabilities should usually add:

1. a new `ProposedAction.type`,
2. deterministic helper or policy logic,
3. commerce service support when state mutation is needed,
4. evaluation cases.

Create a new agent only when the new capability has a different audience, timing, and responsibility boundary.

## 5. Seed Catalogue

Use a shared local catalogue before any external integration.

Seeded SKUs:

1. GlowFix Vitamin C Serum
2. HydraMist Cushion SPF
3. Bamboo Thermal Tumbler
4. Satin Cloud Sleep Mask

Each SKU must include:

```python
class SKU(BaseModel):
    id: str
    name: str
    aliases: list[str]
    base_price_cents: int
    current_price_cents: int
    stock: int
    facts: list[str]
```

`base_price_cents` is the original catalogue price. `current_price_cents` is the regular live price after host updates. Flash-sale pricing is tracked separately and does not overwrite `current_price_cents`.

## 6. Core State

```python
class CommerceState(BaseModel):
    active_sku_id: str | None
    skus: list[SKU]
    flash_sale: FlashSale | None
    orders: list[Order]
    announcements: list[Announcement]
    pending_actions: list[PendingAction]
    ledger: list[LedgerEntry]
    metrics: CommerceMetrics
```

Important rules:

- `active_sku_id` represents the product currently displayed in the live room.
- SKU stock and prices are backend source of truth.
- Orders use the backend price at order creation time.
- Flash sale applies only while active and within its time and stock limits.
- Pending actions represent proposals waiting for host approval and must not change commerce state.
- Reset restores SKUs to seeded stock and prices, then clears orders, flash sale, active SKU, announcements, pending actions, metrics, and ledger.

## 7. Host Transcript as Action Stream

The host transcript is the primary operating interface.

Examples:

```text
"Let's switch to the tumbler."
-> set_active_sku for Bamboo Thermal Tumbler

"Drop the tumbler to 22 dollars."
-> update_price for Bamboo Thermal Tumbler

"Restore the sunscreen cushion to original price."
-> restore_price for HydraMist Cushion SPF

"For the next five minutes, first 20 buyers get it at 18.8."
-> create_flash_sale for active SKU

"Cancel the flash deal."
-> cancel_flash_sale
```

Host transcript processing should support one proposed action or multiple proposed actions in a single utterance.

Example:

```text
"Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes."
```

Expected structured actions:

```json
[
  {
    "type": "set_active_sku",
    "sku_id": "bamboo-thermal-tumbler",
    "source_text": "Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes.",
    "confidence": 0.95,
    "reason": "The host explicitly asked to switch to the tumbler.",
    "evidence": ["tumbler"]
  },
  {
    "type": "update_price",
    "sku_id": "bamboo-thermal-tumbler",
    "price_cents": 2200,
    "source_text": "Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes.",
    "confidence": 0.9,
    "reason": "The host said to make the tumbler 22.",
    "evidence": ["make it 22"]
  },
  {
    "type": "create_flash_sale",
    "sku_id": "bamboo-thermal-tumbler",
    "sale_price_cents": 1880,
    "duration_seconds": 300,
    "stock_limit": 20,
    "source_text": "Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes.",
    "confidence": 0.88,
    "reason": "The host specified first 20 orders at 18.8 for five minutes.",
    "evidence": ["first 20 orders", "18.8", "five minutes"]
  }
]
```

## 8. Unified Action Model

```python
class ProposedAction(BaseModel):
    type: Literal[
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
    sku_id: str | None = None
    quantity: int | None = None
    price_cents: int | None = None
    sale_price_cents: int | None = None
    duration_seconds: int | None = None
    stock_limit: int | None = None
    reply_text: str | None = None
    announcement_text: str | None = None
    override_type: Literal[
        "sku",
        "answer",
        "order",
        "price",
        "promotion",
    ] | None = None
    target_event_id: str | None = None
    source_text: str
    confidence: float
    reason: str | None = None
    evidence: list[str] = []
    requires_host_confirmation: bool = False
```

Pending host confirmations use the same action contract plus approval metadata:

```python
class PendingAction(BaseModel):
    id: str
    action: ProposedAction
    guardrail_result: GuardrailResult
    requested_by: Literal["cohost", "concierge", "guardrail", "host_ui"]
    status: Literal["pending", "approved", "rejected", "overridden"]
    created_at: datetime
```

All realtime agents must return only structured `ProposedAction` objects plus optional natural-language explanations for the UI. Agents may propose actions, but they must never execute them.

Later OpenAI integration should use structured output for this same shape. The output must still pass deterministic SKU resolution, validation, and commerce guardrails before execution.

Action ownership:

- `CoHostAgent` may propose host operations: active SKU, price, flash sale, announcement, host override, or host confirmation.
- `ConciergeAgent` may propose viewer service actions: grounded reply, order creation, safe escalation, or host confirmation.
- `ProducerAgent` does not propose commerce mutations. It returns a report payload.
- `GuardrailNode` may allow actions, block actions, or convert risky actions to `request_host_confirmation` or `noop`.
- `ConfirmationGateNode` stores actions that need host approval and prevents them from reaching the commerce service.
- `CommerceService` is the only layer that applies approved state mutations.

### Host Confirmation Lifecycle

Host confirmation is a backend workflow, not a frontend-only display state.

Rules:

- Guardrails convert ambiguous, low-confidence, or risky actions into pending actions.
- Pending actions are stored in `CommerceState.pending_actions` and broadcast to the host cockpit.
- Pending actions do not mutate SKU, price, promotion, order, stock, or KPI state.
- Approving a pending action sends the original action back through guardrails with approval context, then into the commerce service.
- Rejecting a pending action marks it rejected and appends a ledger event.
- Host override may replace the pending action with a corrected action, which still passes through guardrails before execution.
- Reset clears all pending actions.

## 9. Agent Roles

The MVP should use three main agents:

```text
Host operation -> CoHostAgent
Viewer service -> ConciergeAgent
Post-stream analysis -> ProducerAgent
```

Do not split agents by every commerce subdomain. Pricing, SKU resolution, quantity extraction, and grounding are shared helper or policy modules, not independent agents.

### CoHostAgent

Input:

- Host transcript
- Current active SKU
- SKU catalogue
- Recent ledger context

Output:

- `ProposedAction[]`

Responsibilities:

- Understand host operating intent from natural transcript.
- Split a transcript into one or more proposed actions.
- Resolve explicit product mentions using shared SKU tools.
- Use active SKU only for contextual references like "this one" or "the current product".
- Propose product listing, price, flash-sale, announcement, and override actions.
- Mark low-confidence or ambiguous actions for host confirmation.
- Explain why a proposed action was selected.

Initial implementation:

- Deterministic parser and alias matching.

Later implementation:

- LLM structured output with deterministic fallback.

CoHostAgent must not mutate state directly. It must not directly approve risky discounts, medical claims, delivery promises, or unsupported promotion claims.

### ConciergeAgent

Input:

- Viewer message
- Current active SKU
- SKU catalogue and grounded facts
- Current backend price, stock, flash sale, and recent ledger context

Output:

- `ProposedAction[]`

Responsibilities:

- Classify viewer messages.
- Resolve SKU from explicit mention first, then active SKU.
- Extract order quantity from natural language.
- Generate grounded product replies from SKU facts and current commerce state.
- Propose `create_order` only when order intent is clear.
- Escalate ambiguous SKU, unclear quantity, unsupported discounts, and unsafe claims.

It cannot invent discounts, delivery promises, authenticity claims, medical guarantees, or unsupported product claims.

### GuardrailNode

Responsibilities:

- Validate every proposed answer or commerce action.
- Block unsupported claims.
- Escalate ambiguous SKU or quantity.
- Escalate suspicious price changes or discounts.
- Ensure viewer answers only cite grounded facts and current backend commerce state.

Suggested risk policy:

- Low risk: list active SKU, grounded answer, routine announcement.
- Medium risk: price update, flash-sale creation, order creation.
- High risk: very deep discount, unclear SKU, unclear quantity, unsupported claims, medical claims, authenticity promises, delivery promises.

GuardrailNode is not an agent. It should be deterministic and policy-driven where possible. If an LLM is later used to help with judgment, its result must still be constrained by deterministic policy checks.

### Commerce Service

The commerce service is the only state writer.

Allowed actions:

- `set_active_sku`
- `update_price`
- `restore_price`
- `create_flash_sale`
- `cancel_flash_sale`
- `create_order`
- `add_announcement`
- `host_override`
- `reset_state`

Every action must append a ledger event.

### ProducerAgent

Responsibilities:

- Read only ledger, orders, flash sale, and current state.
- Generate the post-stream report from exact backend numbers.
- Summarize operational performance, viewer demand, risk events, and host learning.
- Never mutate commerce state.

The report must include:

- All SKUs ever listed by host from `list_product` and `create_flash_sale` ledger events.
- Total units sold and total GMV.
- Per-product units sold and GMV.
- Flash-sale sell-through.
- Questions handled.
- Risk events.
- Host learning.
- Next recommendations.

It must not use latest active SKU as a proxy for listed SKU or top SKU.

## 10. LangGraph Workflow

Graph state:

```python
class LiveCrewGraphState(TypedDict):
    event: LiveEvent
    state_snapshot: CommerceState
    agent_decisions: list[AgentDecision]
    proposed_actions: list[ProposedAction]
    guardrail_results: list[GuardrailResult]
    pending_actions: list[PendingAction]
    applied_actions: list[CommerceAction]
    ledger_entries: list[LedgerEntry]
    realtime_events: list[RealtimeEvent]
    response: dict
```

Workflow:

```text
START
-> route_event
-> cohost_agent_node | concierge_agent_node | producer_agent_node | direct_host_action_node
-> guardrail_node
-> confirmation_gate_node
-> commerce_apply_node
-> realtime_broadcast_node
-> END
```

Event routing:

```text
host_transcript   -> cohost_agent_node
viewer_message    -> concierge_agent_node
host_confirmation -> direct_host_action_node
host_override     -> direct_host_action_node
flash_sale_create -> direct_host_action_node
report_request    -> producer_agent_node
reset             -> commerce_apply_node
```

Routing rules:

- Host transcript always enters `CoHostAgent`.
- Viewer message always enters `ConciergeAgent`.
- Report request enters `ProducerAgent` and skips commerce mutation unless the report itself is recorded in the ledger.
- Direct host UI actions may skip LLM agents and enter guardrails as prebuilt proposed actions.
- Actions requiring host confirmation stop at `confirmation_gate_node` and are not applied.
- Approved or overridden pending actions re-enter the graph as `host_confirmation` or `host_override` events.
- All commerce mutations must pass through `guardrail_node`, `confirmation_gate_node`, and `commerce_apply_node`.

## 11. API Design

```text
GET  /health
GET  /state
POST /reset

GET  /events/stream

POST /events/host-transcript
POST /events/viewer-message

POST /commerce/flash-sale
POST /commerce/announcement

POST /actions/{pending_action_id}/approve
POST /actions/{pending_action_id}/reject
POST /actions/host-override

GET  /report
POST /api/eval/run-agent-suite
```

`/api/eval/run-agent-suite` is the intended app route. If the Python backend is running, the Next.js route may proxy to an internal FastAPI `/eval/run-agent-suite` endpoint.

### `POST /events/host-transcript`

Request:

```json
{
  "text": "Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes."
}
```

Response:

```json
{
  "agent_decisions": [],
  "proposed_actions": [],
  "guardrail_results": [],
  "applied_actions": [],
  "ledger_entries": [],
  "state": {}
}
```

### `POST /events/viewer-message`

Request:

```json
{
  "viewer": "viewer_12",
  "text": "I want two of the sunscreen cushion. Any 50% discount?"
}
```

Response should include decisions, guardrail result, applied actions, ledger entries, and updated state.

Preferred shared response shape:

```python
class WorkflowResponse(BaseModel):
    agent_decisions: list[AgentDecision]
    proposed_actions: list[ProposedAction]
    guardrail_results: list[GuardrailResult]
    pending_actions: list[PendingAction]
    applied_actions: list[AppliedAction]
    ledger_entries: list[LedgerEntry]
    suggested_reply: str | None
    report: ProducerReport | None
    state: CommerceState
```

## 12. Realtime Updates

Use Server-Sent Events:

```text
GET /events/stream
```

Each completed workflow broadcasts:

```python
class RealtimeEvent(BaseModel):
    sequence: int
    type: str
    state: CommerceState
    decisions: list[AgentDecision]
    ledger_entries: list[LedgerEntry]
    created_at: datetime
```

Typical updates:

- `list_product`
- `price_updated`
- `create_flash_sale`
- `flash_sale_cancelled`
- `order_created`
- `guardrail_block`
- `host_escalation`
- `host_confirmation_requested`
- `host_confirmation_resolved`
- `answer_suggested`
- `report_generated`

The host and viewer pages subscribe to the same stream.

## 13. Flash Sale Rules

```python
class FlashSale(BaseModel):
    sku_id: str
    original_price_cents: int
    sale_price_cents: int
    starting_stock: int
    remaining_stock: int
    starts_at: datetime
    ends_at: datetime
    active: bool
```

Rules:

- Only one active flash sale is allowed for the MVP.
- `sale_price_cents` must be greater than 0.
- `sale_price_cents` must not exceed the SKU current price.
- `stock_limit` must not exceed current SKU stock.
- `duration_seconds` should be bounded, for example 30 seconds to 30 minutes.
- Orders use flash-sale price only when the sale is active, unexpired, and has enough remaining sale stock.
- Flash sale expiration does not alter `current_price_cents`.

Order pricing:

```text
If order SKU matches active flash sale
and flash sale is active
and current time is before ends_at
and remaining_stock >= quantity:
  unit_price_cents = flash_sale.sale_price_cents
else:
  unit_price_cents = sku.current_price_cents
```

## 14. Price Update Rules

`update_price` changes a SKU's regular live price:

- Price must be greater than 0.
- Very deep reductions should require host confirmation.
- Price changes must write `price_updated` ledger events.
- Viewer replies must cite current backend price, not catalogue assumptions.

`restore_price` sets:

```text
sku.current_price_cents = sku.base_price_cents
```

Restoring regular price does not cancel an active flash sale. If both happen in one transcript, proposed actions execute in extracted order after guardrail approval.

## 15. Ledger

Ledger event types:

```text
list_product
price_updated
price_restored
answer_suggested
guardrail_block
host_escalation
host_confirmation_requested
host_confirmation_resolved
host_override
order_created
stock_updated
create_flash_sale
flash_sale_cancelled
flash_sale_ended
announcement_created
report_generated
```

Model:

```python
class LedgerEntry(BaseModel):
    id: str
    type: str
    actor: str
    sku_id: str | None
    message: str
    payload: dict
    created_at: datetime
```

The ledger is the evidence layer for timeline UI, evaluation, and post-stream reporting.

For Producer reports, listed SKUs must be derived from `list_product` and `create_flash_sale` ledger events. `active_sku_changed` may be retained as a realtime event name, but report calculations should use the ledger event names above. Reset clears the current session ledger instead of adding a `state_reset` entry to it.

## 16. Evaluation

`POST /api/eval/run-agent-suite` should run deterministic cases without LLM calls. If the FastAPI backend is active, the Next.js route can proxy to an internal backend endpoint.

Categories:

- SKU Grounding
- Missing Context
- Grounded Product Facts
- Commerce Intent
- Safety Guardrails
- Host Command Understanding
- Pricing and Promotion Updates
- Judge Free-Form Stress

Each category should eventually contain at least 10 representative cases.

Evaluation output should include:

- Category cards.
- Pass rate by category.
- Inspectable result rows.
- Input message.
- Expected action or decision.
- Actual action or decision.
- Failure reason.

## 17. LLM Integration Plan

Phase 1:

```text
Deterministic parser only.
No OpenAI dependency.
```

Phase 2:

```text
CoHostAgent and ConciergeAgent use LLM structured output to produce ProposedAction[].
Deterministic parser remains fallback.
```

Hard constraints:

- LLM cannot mutate state.
- LLM cannot choose final order price.
- LLM cannot bypass guardrails.
- LLM cannot override SKU resolver, stock, price, order quantity, or backend metrics.
- Low-confidence LLM output must require host confirmation.

## 18. Implementation Order

Recommended build sequence:

1. FastAPI backend skeleton.
2. Pydantic models.
3. Seeded catalogue.
4. In-memory state and reset.
5. Ledger append helpers.
6. Pending host-confirmation queue.
7. Commerce service for active SKU, price update, flash sale, order, announcement.
8. Deterministic SKU resolver and quantity extractor.
9. Deterministic CoHostAgent.
10. Deterministic ConciergeAgent.
11. GuardrailNode and policy modules.
12. LangGraph workflow with confirmation gate.
13. API routes.
14. SSE realtime stream.
15. ProducerAgent report.
16. Evaluation suite.
17. Optional OpenAI structured action extraction inside CoHostAgent and ConciergeAgent.

## 19. Design Principle

The final backend boundary is:

```text
Host speech drives intent.
Agents produce structured decisions.
Guardrails validate risk.
Host confirmation pauses risky actions.
Commerce service mutates state.
Ledger records evidence.
SSE broadcasts reality.
```

This keeps the demo magical from the host's perspective while keeping commerce operations precise, inspectable, and safe.
