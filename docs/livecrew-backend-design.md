# LiveCrew Backend Technical Design

## 1. Purpose

LiveCrew is a host-led AI operations crew for livestream commerce. The backend should let a solo host run a complete live commerce flow with agent support.

The key product behavior is:

```text
Host speaks naturally
-> OpenAI realtime transcription creates host transcript events
-> agents use OpenAI structured output to understand operating intent
-> commerce state is validated and updated
-> host and viewer UI update in real time
-> viewer watches the host browser camera/microphone stream
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
- Submit typed text commands to CoHostAgent for debugging and fallback operation.

The system should prefer reliable operations over agent freedom. LLMs may understand host and viewer language, but they must not directly mutate commerce state.

## 2. Technology Stack

Required backend stack:

```text
Python
FastAPI
Pydantic
LangGraph
In-memory state
Server-Sent Events
Browser WebRTC media streaming
```

Initial dependencies:

```text
fastapi
uvicorn
pydantic
langgraph
python-dotenv
openai
```

Frontend stack remains Next.js App Router, TypeScript, and Tailwind CSS. Frontend code may capture browser media, render UI, call backend routes, subscribe to backend realtime events, and host minimal proxy routes when needed. Frontend code must not become the source of truth for agent decisions, commerce state, OpenAI API calls, ledger events, report metrics, or guardrail outcomes.

Do not use these for the MVP unless explicitly requested:

- PostgreSQL
- Redis
- Celery
- Production WebSocket room infrastructure beyond simple media signaling
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

Browser media path:

```text
/host browser getUserMedia camera + microphone
        |
        v
WebRTC peer connection
        |
        v
/viewer video/audio playback

FastAPI only coordinates lightweight signaling.
Raw media should not be relayed through the commerce backend.
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
- Host typed debug commands enter the same workflow as finalized transcript events.
- Browser-native media capture provides the host camera/microphone stream to viewers.
- Media signaling coordinates host and viewer sessions but does not persist or inspect raw audio/video.
- OpenAI API calls for transcription, structured action extraction, grounded reply drafting, and report narrative generation are server-side backend responsibilities.
- Next.js should call the Python backend instead of implementing agent or commerce logic in API routes.

### Document-Driven Backend Rule

Backend implementation must follow this document. If the implementation needs to diverge from the documented route, model, graph node, or module boundary, update this document before changing code.

Rules:

- Add or update the requirement in `docs/livecrew-feature-requirements.md` before adding user-visible behavior.
- Add or update this design document before adding backend modules, routes, models, graph edges, action types, or ledger event shapes.
- Keep `backend/` as the home for FastAPI routes, LangGraph orchestration, agents, guardrails, commerce state, ledger, OpenAI integration, evaluation, and media signaling.
- Keep Next.js focused on `/host`, `/viewer`, `/agent_evaluation`, browser media capture, UI state rendering, and client calls to the Python backend.
- Do not implement a parallel source of truth in browser local storage or Next.js API routes once the Python backend contract exists.
- Every completed feature should be traceable to a requirement, a backend contract, an implementation module, and a verification check.

## 4. Module Layout

```text
backend/
  main.py
  models.py
  state.py
  ledger.py
  realtime.py
  media_signaling.py
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
- `media_signaling.py`: Ephemeral host/viewer signaling for browser media sessions.
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
    viewer_sessions: list[ViewerSession]
    viewer_comments: list[ViewerComment]
    viewer_insights: list[ViewerInsightSnapshot]
    orders: list[Order]
    announcements: list[Announcement]
    pending_actions: list[PendingAction]
    ledger: list[LedgerEntry]
    metrics: CommerceMetrics
```

Important rules:

- `active_sku_id` represents the product currently displayed in the live room.
- SKU stock and prices are backend source of truth.
- Viewer sessions store active username-only logins for the current demo run.
- Viewer comments are backend source of truth for ConciergeAgent replies and host word-cloud analysis.
- Viewer insight snapshots summarize recent viewer demand for the host cockpit, including deterministic intent counts derived from stored viewer comments.
- Viewer insight generation filters out host, system, and LiveCrew Agent sender names before building terms, intent counts, OpenAI prompts, summaries, or source comment ids.
- Orders use the backend price at order creation time.
- Flash sale applies only while active and within its time and stock limits.
- Pending actions represent proposals waiting for host approval and must not change commerce state.
- Reset restores SKUs to seeded stock and prices, then clears orders, flash sale, active SKU, announcements, pending actions, metrics, and ledger.
- Reset clears viewer sessions so usernames can be reused in the next demo run.
- Reset clears viewer comments and viewer insight snapshots.

## 7. Host Transcript and Text Commands as Action Stream

The host transcript is the primary operating interface. The host cockpit also provides a typed text command input for debugging and fallback operation.

Examples:

```text
"Let's switch to the tumbler."
-> set_active_sku for Bamboo Thermal Tumbler

"Drop the tumbler to 22 dollars."
-> update_price for Bamboo Thermal Tumbler

"Set the tumbler stock to 60."
-> update_stock for Bamboo Thermal Tumbler

"Restore the sunscreen cushion to original price."
-> restore_price for HydraMist Cushion SPF

"For the next five minutes, first 20 buyers get it at 18.8."
-> create_flash_sale for active SKU

"设置Vitamin C促销，限时3min，限价10元，限量10个"
-> set_active_sku for GlowFix Vitamin C Serum
-> create_flash_sale for GlowFix Vitamin C Serum

"Cancel the flash deal."
-> cancel_flash_sale
```

Host transcript processing should support one proposed action or multiple proposed actions in a single utterance or in a multi-segment host thought.
CoHostAgent should use OpenAI structured output for primary host intent extraction and return proposed actions in utterance order. Deterministic parsing remains a fallback when OpenAI is unavailable, times out, or returns invalid structured output; fallback output still passes through the same guardrails and commerce service.

CoHost conversation context:

- The backend maintains an ordered CoHost `messages` list for host operations. The list contains one system prompt message, host user messages, and assistant action-trace messages.
- The system prompt is refreshed on each CoHost call and injects the seeded SKU catalogue, current backend commerce state, and supported action list/tool schema. SKU, price, stock, flash-sale, pending-action, and supported-action facts should come from backend state and constants, not from a stale summary.
- Each finalized speech transcript or typed debug command is appended as the latest user message, then the CoHost model is called with the full bounded message list.
- If the CoHost output is only `noop`, the backend does not append a durable assistant trace. The next host user message is merged into the previous open user message, preserving time order, and the merged message is re-analyzed.
- Incomplete high-risk tool calls such as `update_price`, `update_stock`, or `create_flash_sale` with missing required fields are coerced to `noop` before assistant tracing, so partial transcript fragments keep accumulating instead of closing the host user message.
- If the CoHost output includes any effective action, those actions are appended as the next assistant action-trace message, and the current user message is closed.
- The context keeps at most 50 user-role messages. When that limit is exceeded, the earliest 25 user-role messages and their intervening assistant traces are summarized into one replacement user-role summary message inserted immediately after the system prompt, preserving chronological order.
- Summaries are memory only. Commerce mutations, guardrail decisions, report metrics, current prices, stock, flash sale, orders, and ledger facts remain sourced from backend state and ledger.
- The backend exposes a read-only debug snapshot of the current CoHost messages for the host cockpit. This snapshot may include system, user, and assistant action-trace content, but must never include API keys, realtime client secrets, or other credential material.

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

Typed text command rules:

- Typed commands enter the graph as `host_text_command` events.
- Typed commands use the same CoHostAgent, structured action schema, guardrails, confirmation gate, commerce service, ledger, and realtime broadcast path as finalized transcript events.
- Typed commands should carry `input_source: "typed_command"` so the UI and ledger can distinguish them from speech transcription.
- Typed commands are allowed when microphone capture, OpenAI realtime transcription, or camera permission is unavailable.
- Typed commands must never bypass SKU grounding, pricing policy, stock checks, unsupported-claim checks, or host confirmation.

## 8. Unified Action Model

```python
class ProposedAction(BaseModel):
    type: Literal[
        "set_active_sku",
        "update_price",
        "update_stock",
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
    stock: int | None = None
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
    input_source: Literal["speech_transcript", "typed_command", "viewer_message", "host_ui"]
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

OpenAI integration should use structured output for this same shape. The output must still pass deterministic SKU resolution, validation, and commerce guardrails before execution.

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
- `noop` and non-actionable host speech must never enter the pending confirmation queue.
- `noop` is an internal no-action result and must not be appended to the event ledger or displayed in the host ledger timeline.
- Pending actions are stored in `CommerceState.pending_actions` and broadcast to the host cockpit.
- Pending actions do not mutate SKU, price, promotion, order, stock, or KPI state.
- Approving a pending action sends the original action back through guardrails with approval context, then into the commerce service.
- Rejecting a pending action marks it rejected and appends a ledger event.
- The host cockpit must render pending actions with approve and reject controls backed by the `/actions/{pending_action_id}/approve` and `/actions/{pending_action_id}/reject` endpoints.
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
- Use OpenAI structured output as the primary extraction path for host operations, including multilingual and mixed-language phrasing.
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
- Return no proposed actions for totally irrelevant viewer messages.
- Resolve SKU from explicit mention first, then the active pinned SKU for contextual product references.
- Return no proposed actions when a product question cannot be grounded to a SKU.
- Extract order quantity from natural language.
- Treat explicit quantities in the raw viewer text as authoritative for order creation, overriding any conflicting LLM-extracted quantity.
- Default order quantity to 1 only when clear order intent exists and no explicit numeric or number-word quantity is present.
- Generate grounded product replies from SKU facts and current commerce state.
- Say that a detail cannot be verified when the requested product detail is not present in grounded SKU facts or current commerce state.
- Propose `create_order` only when order intent is clear.
- Escalate unclear quantity, unsupported discounts, health or allergy questions, unsafe claims, and unverified promotion or guarantee requests as pending host-reviewed reply drafts.

It cannot invent discounts, delivery promises, authenticity claims, medical guarantees, or unsupported product claims.

Host escalation behavior:

- Risky ConciergeAgent replies are stored as pending `suggest_reply` actions with `requested_by="concierge"`.
- Pending escalation payloads include the viewer raw question, escalation reason, and drafted reply.
- The host cockpit can accept the draft, edit and send the draft, or discard it with no viewer reply.
- Accepted or edited replies are validated by guardrails before being recorded as `answer_suggested` ledger events and returned to the frontend as `suggested_reply`.
- Discarded drafts append a `host_confirmation_resolved` ledger event and do not emit a suggested reply.

### GuardrailNode

Responsibilities:

- Validate every proposed answer or commerce action.
- Block unsupported claims.
- Escalate ambiguous SKU or quantity.
- Escalate suspicious price changes or discounts.
- Ensure viewer answers only cite grounded facts and current backend commerce state.

Suggested risk policy:

- Low risk: list active SKU, grounded answer, routine announcement.
- Medium risk: price update, stock update, flash-sale creation, order creation.
- High risk: very deep discount, unclear SKU, unclear quantity, unsupported claims, medical claims, authenticity promises, delivery promises.

GuardrailNode is not an agent. It should be deterministic and policy-driven where possible. If an LLM is later used to help with judgment, its result must still be constrained by deterministic policy checks.

### Commerce Service

The commerce service is the only state writer.

Allowed actions:

- `set_active_sku`
- `update_price`
- `update_stock`
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
host_text_command -> cohost_agent_node
viewer_message    -> concierge_agent_node
host_confirmation -> direct_host_action_node
host_override     -> direct_host_action_node
flash_sale_create -> direct_host_action_node
report_request    -> producer_agent_node
reset             -> commerce_apply_node
```

Routing rules:

- Host transcript always enters `CoHostAgent`.
- Host text command always enters `CoHostAgent` and is treated as a debug/fallback host operation input.
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
POST /events/host-command
POST /events/viewer-message
POST /events/realtime-transcription-token
POST /viewer-insights/word-cloud
GET  /debug/cohost-messages

POST /viewer-login
GET  /viewer-login/{session_id}
POST /viewer-login/{session_id}/logout

POST /commerce/flash-sale
POST /commerce/announcement

POST /actions/{pending_action_id}/approve
POST /actions/{pending_action_id}/reject
POST /actions/host-override

GET  /report
POST /api/eval/run-agent-suite

POST /media/session
POST /media/session/{session_id}/viewer/{viewer_id}
POST /media/session/{session_id}/offer
POST /media/session/{session_id}/answer
POST /media/session/{session_id}/ice-candidate
DELETE /media/session/{session_id}
```

`/api/eval/run-agent-suite` is the intended app route. The route must be read-only and isolated from live chat, host state, order state, event ledger writes, and production queues. It should use local deterministic analyzer behavior for regression scoring so the evaluation page can open without an OpenAI API key. If the Python backend is running, the Next.js route may proxy to an internal FastAPI `/eval/run-agent-suite` endpoint only if that backend endpoint is equally read-only.

Local FastAPI CORS should allow the primary Next.js dev origin `localhost:3000` and the fallback origin `localhost:3001`, including `127.0.0.1` variants, so the demo remains usable when one dev port is already occupied.

### `POST /events/host-transcript`

Request:

```json
{
  "text": "Switch to the tumbler, make it 22, and first 20 orders get 18.8 for five minutes."
}
```

### `POST /events/realtime-transcription-token`

Creates a short-lived OpenAI Realtime client secret for browser microphone transcription.
This endpoint is the only browser-facing OpenAI credential path. It uses the server-side
`OPENAI_API_KEY` and returns only the ephemeral client secret value and metadata needed
to initialize a WebRTC transcription session.

Request: empty JSON body or no body.

Response:

```json
{
  "value": "ek_...",
  "expires_at": 1767225600,
  "session_id": "sess_...",
  "model": "gpt-4o-transcribe"
}
```

Backend behavior:

- Use a Realtime transcription session with `type: "transcription"`.
- Default the transcription model to `gpt-4o-transcribe`, configurable by `OPENAI_REALTIME_TRANSCRIPTION_MODEL`.
- Use server VAD for turn boundaries so only completed speech turns are sent to `POST /events/host-transcript`.
- Include SKU names and aliases as transcription vocabulary guidance when the selected model supports prompt guidance.
- Return a clear `503` error when `OPENAI_API_KEY` is missing or the OpenAI client-secret request fails.
- Never write the ephemeral client secret to the ledger.
- For the local hackathon demo, backend OpenAI transcription setup calls may disable TLS certificate verification to avoid local CA-chain failures. This is a demo-only mode and must not be treated as production security posture.

### `POST /events/realtime-transcription-offer`

Exchanges a browser WebRTC SDP offer for an OpenAI Realtime SDP answer through the Python backend. The browser must not call OpenAI directly for transcription setup in the local demo path.

Request:

```json
{
  "sdp": "v=0..."
}
```

Response:

```json
{
  "answer_sdp": "v=0...",
  "model": "gpt-4o-transcribe",
  "session_id": "sess_..."
}
```

Backend behavior:

- Create a short-lived OpenAI Realtime transcription client secret server-side.
- POST the browser SDP offer to OpenAI Realtime from the backend.
- Disable TLS certificate verification for those backend OpenAI transcription setup calls in the local demo environment.
- Return only the SDP answer and non-secret metadata to the browser.
- Return a clear `503` error if the client-secret request or SDP exchange fails.

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

### `POST /events/host-command`

Typed debug command endpoint. It should normalize the request into the same workflow shape as a finalized host transcript while preserving the source as `typed_command`.

Request:

```json
{
  "text": "Switch to the sleep mask.",
  "source": "typed_command"
}
```

Response should use the shared `WorkflowResponse` shape and include proposed actions, guardrail results, pending confirmations, ledger entries, and updated state.

### `GET /debug/cohost-messages`

Returns the current backend-managed CoHost LLM message context for host debugging.
The system message is refreshed from current backend state before the response is returned.

Response:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are LiveCrew's CoHostAgent...",
      "is_open_user": false
    },
    {
      "role": "user",
      "content": "Host transcript segments awaiting CoHost action...",
      "source_text": "first 20 buyers",
      "is_open_user": true
    }
  ]
}
```

Backend behavior:

- Return messages in the same chronological order used for CoHost LLM calls.
- Include assistant action traces when they are part of the current CoHost context.
- Do not include OpenAI API keys, realtime client secrets, or other credential material.

### `POST /events/viewer-message`

Request:

```json
{
  "viewer": "viewer_12",
  "text": "I want two of the sunscreen cushion. Any 50% discount?"
}
```

Response should include decisions, guardrail result, applied actions, ledger entries, and updated state.
Irrelevant or ungrounded messages may return an empty `proposed_actions` list and `suggested_reply: null`.
Risky messages return a pending ConciergeAgent `suggest_reply` action and `suggested_reply: null` until host review.
The route records the raw viewer message in `CommerceState.viewer_comments` with viewer name, text, resolved SKU when available, reply status, intent, and suggested reply when one can be safely drafted.

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

### `POST /viewer-insights/word-cloud`

The host cockpit calls this once per minute and may call it manually for demo testing.

Request:

```json
{
  "window_seconds": 180
}
```

Response:

```python
class ViewerInsightMetric(BaseModel):
    label: str
    count: int
    weight: int

class ViewerInsightSnapshot(BaseModel):
    id: str
    window_started_at: datetime
    window_ended_at: datetime
    active_sku_id: str | None
    comment_count: int
    terms: list[WordCloudTerm]
    intent_breakdown: list[ViewerInsightMetric]
    summary: str
    suggested_replies: list[str]
    source_comment_ids: list[str]
    created_at: datetime
```

Rules:

- Default window is 180 seconds.
- Only viewer-authored comment text is analyzed; host replies, LiveCrew Agent replies, suggested reply text, and other automated response text are excluded.
- Terms are sorted by descending weight.
- Intent breakdown is computed deterministically from recorded viewer comment intent and guardrail status.
- OpenAI may cluster terms and draft summary text, but the backend validates the returned term shape and falls back to deterministic extraction if needed.
- The snapshot is stored in `CommerceState.viewer_insights` and a `viewer_word_cloud_generated` ledger entry is appended.

### Viewer Login Routes

`POST /viewer-login`

Request:

```json
{
  "username": "alice"
}
```

Response:

```python
class ViewerLoginResponse(BaseModel):
    session: ViewerSession
    state: CommerceState
```

Rules:

- Username is trimmed before validation.
- Username must be non-empty and short enough for the viewer UI.
- Active usernames are compared case-insensitively.
- If the username is already active, return `409 Conflict`.
- Successful login stores a backend viewer session and appends a `viewer_logged_in` ledger event.

`GET /viewer-login/{session_id}` returns the active viewer session for current-page validation, or `404` when the session is no longer valid. The browser should not persist this session across `/viewer` reloads; each new viewer entry should log in again to simulate multiple users on one device.

`POST /viewer-login/{session_id}/logout` removes the viewer session, appends `viewer_logged_out`, and allows the username to be reused.

### `POST /actions/{pending_action_id}/approve`

Accept a pending ConciergeAgent reply draft and send it to the viewer after guardrail validation.

### `POST /actions/{pending_action_id}/reply`

Send an edited reply for a pending ConciergeAgent escalation after guardrail validation.

### `POST /actions/{pending_action_id}/reject`

Discard a pending ConciergeAgent escalation without sending a viewer reply.

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

- `host_stream_started`
- `host_stream_stopped`
- `list_product`
- `price_updated`
- `stock_updated`
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

## 13. Host Media Streaming

The host camera and microphone stream is a browser media feature, not a commerce state mutation.

Frontend behavior:

- `/host` uses browser media permissions to access the Mac camera and microphone.
- `/host` shows a local preview and start/stop controls.
- `/viewer` plays the live host video/audio stream.
- `/viewer` renders the customer experience as a phone-style livestream room.
- `/viewer` reserves the upper two-thirds of the phone frame for host video and product information.
- `/viewer` reserves the lower one-third of the phone frame for viewer chat.
- Active product information displayed on `/viewer` must come from backend `active_sku_id` and SKU facts, with local demo state only as fallback.
- Viewer media playback should clearly show connecting, live, muted, offline, and permission/error states.
- Host audio should be reusable for OpenAI realtime transcription and viewer playback.

Transport behavior:

- Use browser-native `getUserMedia` for camera and microphone capture.
- Use WebRTC peer connection for host-to-viewer media transport.
- Use the backend only for lightweight signaling such as session creation, offer, answer, and ICE candidate exchange.
- Do not route raw audio/video through the commerce service, ledger, or OpenAI agent workflow.
- Do not record, store, replay, or upload raw media unless a later requirement explicitly adds recording.

Backend behavior:

- `media_signaling.py` stores ephemeral session metadata only.
- Media sessions should be resettable and should expire when the host stops streaming or refreshes for too long.
- A media session supports multiple viewers by `viewer_id`. Each viewer receives its own WebRTC offer from the host, submits its own answer, and exchanges ICE candidates in viewer-scoped candidate lists.
- The host creates one `RTCPeerConnection` per active viewer because a single peer connection cannot serve multiple independent viewer answers.
- `POST /media/session/{session_id}/viewer/{viewer_id}` registers a viewer as waiting for a viewer-scoped offer.
- `SignalPayload.viewer_id` scopes offer, answer, and ICE candidate payloads to a specific viewer when present. Legacy unscoped fields may remain for compatibility but should not be used for multi-viewer playback.
- Media state changes may broadcast lightweight realtime events such as `host_stream_started` and `host_stream_stopped`.
- Media failures should not block commerce state, viewer chat, product shelf updates, or agent workflows.

## 14. Flash Sale Rules

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

## 15. Price Update Rules

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

## 16. Stock Update Rules

`update_stock` changes a SKU's current sellable stock:

- Stock must be a non-negative integer.
- The action must reference a grounded SKU, using the active SKU only for contextual host phrases.
- Stock changes must write `stock_updated` ledger events.
- Stock changes must not alter price, active SKU, orders, or flash-sale pricing.
- If an active flash sale exists for the same SKU and its remaining stock is greater than the new SKU stock, the commerce service should cap `flash_sale.remaining_stock` to the new SKU stock.
- Viewer replies and product overlays must cite current backend stock, not catalogue assumptions.

## 17. Ledger

Ledger event types:

```text
list_product
price_updated
price_restored
answer_suggested
viewer_logged_in
viewer_logged_out
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

`noop` is intentionally excluded from ledger event types. It may appear in proposed agent output as an internal no-action result, but non-actionable speech should not create a ledger entry.

For Producer reports, listed SKUs must be derived from `list_product` and `create_flash_sale` ledger events. `active_sku_changed` may be retained as a realtime event name, but report calculations should use the ledger event names above. Reset clears the current session ledger instead of adding a `state_reset` entry to it.

## 18. Evaluation

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

Each displayed category should contain at least 10 representative cases, and the `/agent_evaluation` page should let every category summary card expand or collapse its own aligned sample table without touching production runtime flows.

Evaluation output should include:

- Category cards.
- Pass rate by category.
- Inspectable result rows.
- Input message.
- Expected action or decision.
- Actual action or decision.
- Failure reason.

## 19. LLM Integration Plan

Phase 1:

```text
Deterministic backend contracts, catalogue grounding, commerce service, guardrails, and eval cases.
Typed host command input and viewer chat fallback remain available for demo reliability.
```

Phase 2:

```text
OpenAI realtime transcription turns host microphone input into transcript events.
CoHostAgent, ConciergeAgent, and ProducerAgent use OpenAI structured output for their agent tasks.
Deterministic parsing and validation remain fallback and safety checks.
```

Runtime configuration:

- Read `OPENAI_API_KEY` from `.env`.
- Keep the key server-side only.
- Do not send the API key to the browser.
- Use a backend endpoint or short-lived client token pattern for browser microphone transcription, rather than exposing the long-lived API key.
- Surface missing or invalid API key setup clearly in the host cockpit.

Realtime transcription requirements:

- Host microphone audio should use the OpenAI Realtime API for transcription.
- WebRTC is preferred for browser microphone capture when practical; server-side WebSocket bridging is acceptable for a hackathon fallback.
- Only completed or finalized transcript segments should trigger CoHostAgent action generation.
- In-progress transcript text should be displayed in the host livestream panel while the host is speaking.
- A browser-side interim caption preview is acceptable for demo responsiveness as long as only finalized transcript text enters the backend workflow.
- Typed host commands should remain available as a no-microphone debugging path.

Hard constraints:

- LLM cannot mutate state.
- LLM cannot choose final order price.
- LLM cannot bypass guardrails.
- LLM cannot override SKU resolver, stock, price, order quantity, or backend metrics.
- Low-confidence LLM output must require host confirmation.
- Invalid or malformed LLM structured output must be rejected and logged.

## 20. Implementation Order

Recommended build sequence:

1. Confirm or update `docs/livecrew-feature-requirements.md` and this design document for the feature being built.
2. FastAPI backend skeleton.
3. Pydantic models.
4. Seeded catalogue.
5. In-memory state and reset.
6. Ledger append helpers.
7. Pending host-confirmation queue.
8. Commerce service for active SKU, price update, flash sale, order, announcement.
9. Deterministic SKU resolver and quantity extractor.
10. Deterministic CoHostAgent.
11. Deterministic ConciergeAgent.
12. GuardrailNode and policy modules.
13. LangGraph workflow with confirmation gate.
14. API routes.
15. SSE realtime stream.
16. ProducerAgent report.
17. Evaluation suite.
18. OpenAI API key loading and server-side OpenAI client.
19. OpenAI realtime transcription bridge for host microphone input.
20. Host typed command endpoint wired to CoHostAgent.
21. Host camera/microphone capture UI.
22. Lightweight WebRTC signaling and viewer playback.
23. OpenAI structured action extraction inside CoHostAgent and ConciergeAgent.
24. OpenAI-assisted ProducerAgent report narrative.

## 21. Design Principle

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
