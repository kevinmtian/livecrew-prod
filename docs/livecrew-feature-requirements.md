# LiveCrew Feature Requirements

## 1. Overview

LiveCrew is an AI operations crew for livestream commerce. The product goal is to let a solo livestream host operate product listing, pricing, promotion, viewer Q&A, and post-stream review through natural speech and chat.

The experience should feel like:

```text
Host speaks naturally
-> backend understands the intended commerce action
-> backend validates the action
-> frontend updates the live room
-> viewer questions are answered from current commerce reality
-> post-stream report is generated from recorded facts
```

This document describes the first target product capabilities and the extension rules for future capabilities. It is not intended to be a complete final requirement list. The backend technical design is documented separately in `docs/livecrew-backend-design.md`.

## 2. Product Principles

- The host should be able to operate the live room without clicking through complex controls.
- The frontend should reflect backend commerce state as the source of truth.
- Agents may propose actions and replies, but deterministic backend services must execute commerce changes.
- The system should prefer host confirmation over risky automation.
- Viewer-facing answers must be grounded in product facts and current live commerce state.
- Every important action should be recorded so the post-stream report can explain what happened.
- The framework should stay structured, cohesive, loosely coupled, and easy to extend as new livestream commerce requirements appear.

## 3. Core Users

### Host

The host runs the livestream, introduces products, changes prices, creates promotions, and may override wrong agent behavior.

### Viewer

The viewer watches the livestream, asks product questions, requests promotions, and may place orders using natural language.

### Producer

The producer reviews stream performance after the session and needs a factual report based on backend records.

## 4. Framework Requirements

The first six functional requirements are only the initial scope. The system should be designed so future requirements can be added without rewriting the agent graph, frontend state model, or commerce execution path.

### NFR-1: Structured Capability Model

Every product capability should be described through the same structure:

- Trigger: host transcript, viewer message, host UI action, timer, report request, or future integration event.
- Agent owner: `CoHostAgent`, `ConciergeAgent`, `ProducerAgent`, or no agent for deterministic UI actions.
- Proposed action type.
- Guardrail policy.
- Commerce service mutation, if any.
- Ledger event.
- Frontend state update.
- Evaluation cases.

This keeps new features comparable and prevents each feature from inventing its own path through the system.

### NFR-2: High Cohesion

Each module should own one clear responsibility:

- `CoHostAgent`: host-facing live operations intent.
- `ConciergeAgent`: viewer-facing service intent and grounded replies.
- `ProducerAgent`: post-stream analysis and report generation.
- Guardrail policies: allow, block, or escalate proposed actions.
- Commerce service: execute approved state mutations.
- Ledger: record evidence.
- Realtime layer: broadcast state changes.
- Frontend surfaces: render backend state and collect user input.

Modules should not duplicate each other's core job. For example, the frontend should not recompute final prices, and agents should not directly mutate SKU stock.

### NFR-3: Low Coupling

Modules should communicate through explicit data contracts instead of direct internal calls.

Required contracts:

- `LiveEvent`: normalized inbound event.
- `ProposedAction`: agent or UI proposal.
- `GuardrailResult`: validation outcome.
- `AppliedAction`: executed commerce mutation.
- `PendingAction`: proposed action waiting for host approval.
- `LedgerEntry`: durable event evidence.
- `CommerceState`: source-of-truth state snapshot.
- `WorkflowResponse`: API response to frontend.

Agents may use shared pure helper modules such as SKU resolution, quantity extraction, price parsing, and grounded reply generation. Agents should not import each other.

### NFR-4: Extensible Action Registry

New capabilities should usually be added by extending the action registry instead of adding a new agent.

For each new `ProposedAction.type`, define:

- Input fields.
- Required validation.
- Risk level.
- Whether host confirmation is required.
- Commerce executor behavior.
- Ledger event type.
- Frontend display behavior.
- Evaluation cases.

Examples of future action types:

- `create_bundle_offer`
- `apply_coupon`
- `answer_shipping_question`
- `handle_return_policy_question`
- `pin_viewer_question`
- `schedule_announcement`
- `compare_products`
- `summarize_viewer_sentiment`

### NFR-5: Extension Decision Rule

When adding a future feature, choose the smallest extension point that fits:

- Add a helper when the feature is reusable parsing, grounding, formatting, or calculation.
- Add a policy when the feature is validation, safety, risk, or permission logic.
- Add a `ProposedAction.type` when the feature changes workflow behavior.
- Add a commerce service method only when backend state must change.
- Add a frontend panel only when users need to inspect or control the feature.
- Add a new agent only when the feature has a new audience, timing, and reasoning boundary that does not fit `CoHostAgent`, `ConciergeAgent`, or `ProducerAgent`.

### NFR-6: Backward-Compatible Growth

Future features should not break the existing demo path.

Requirements:

- Existing action types should remain stable unless a migration is documented.
- API responses should tolerate additional optional fields.
- Ledger entries should keep enough payload data for old and new reports.
- Pending host confirmations should survive frontend refreshes until approved, rejected, overridden, or reset.
- Evaluation cases should cover both the new capability and regressions in existing flows.
- The frontend should degrade gracefully when a backend capability is unavailable.

### NFR-7: Testability and Observability

Each capability should be inspectable and testable.

Requirements:

- Deterministic evaluation cases should exist for agent routing, SKU grounding, guardrail decisions, and commerce execution.
- Ledger entries should explain why an action was applied, blocked, or escalated.
- Agent outputs should include confidence, reason, and evidence.
- The host UI should expose enough timeline detail to debug a wrong action during the demo.

## 5. Initial Functional Requirements

### FR-1: Detect Product Mentions and List SKU

When the host mentions a product during the livestream, the backend should identify the matching SKU and cause the frontend product shelf to list or highlight that SKU.

Examples:

```text
"Let's show the tumbler now."
-> Bamboo Thermal Tumbler becomes the active SKU.

"This vitamin C serum is great for morning routines."
-> GlowFix Vitamin C Serum becomes the active SKU.
```

Expected behavior:

- The backend resolves product mentions against the seeded SKU catalogue.
- Explicit product mentions should take priority over the current active SKU.
- Alias matching should support natural names, partial names, and common product references.
- If the product mention is ambiguous, the backend should ask for host confirmation instead of switching automatically.
- Ambiguous or risky actions should enter a pending host-confirmation queue and must not mutate commerce state until approved.
- The frontend host cockpit and viewer room should update to show the active SKU.
- The action should be recorded in the event ledger.

Acceptance criteria:

- Given a host transcript that clearly mentions one seeded SKU, the backend returns a proposed `set_active_sku` action.
- After approval, backend `active_sku_id` changes to the resolved SKU.
- The frontend product shelf updates without a page refresh.
- The ledger records the SKU switch with source text and selected SKU.

### FR-2: Switch SKU Freely During the Livestream

The host should be able to switch products at any time during the stream, and the frontend should follow the backend state.

Examples:

```text
"Okay, back to the cushion SPF."
-> HydraMist Cushion SPF becomes active.

"Now let's move from the serum to the sleep mask."
-> Satin Cloud Sleep Mask becomes active.
```

Expected behavior:

- The host can switch between any seeded SKUs multiple times in one stream.
- The active SKU shown to viewers must match backend `active_sku_id`.
- Viewer questions that use contextual wording like "this one" should resolve to the current active SKU.
- Previous SKU listing events should remain in the ledger for reporting.
- Switching SKU should not erase orders, price updates, flash sale history, or previous viewer messages.

Acceptance criteria:

- Multiple SKU switches can happen in a single session.
- Host and viewer surfaces show the same active SKU after each switch.
- The Producer report can list all SKUs that were shown during the stream.

### FR-3: Set or Modify SKU Price and Discount by Speech

The host should be able to change a SKU's live price or discount through spoken instructions.

Examples:

```text
"Drop the tumbler to 22 dollars."
-> Update Bamboo Thermal Tumbler current price to $22.00.

"Restore the cushion to the original price."
-> Restore HydraMist Cushion SPF to its base catalogue price.

"Give this one 15 percent off."
-> Propose a discounted price for the current active SKU.
```

Expected behavior:

- The backend extracts price or discount intent from host transcript.
- Explicit SKU mentions should determine which SKU is affected.
- If no SKU is explicitly mentioned, contextual phrases like "this one" should apply to the active SKU.
- Price changes should update backend SKU state, not just frontend display text.
- Deep discounts or suspicious price changes should require host confirmation.
- Price or discount proposals requiring confirmation should remain pending until the host approves, rejects, or overrides them.
- Viewer replies should cite the current backend price.
- Every price or discount change should be recorded in the ledger.

Acceptance criteria:

- Spoken price changes produce `update_price` or `restore_price` proposed actions.
- Approved price changes update `current_price_cents`.
- Discount-derived prices are calculated deterministically.
- Risky discounts are blocked or escalated before execution.
- The frontend price display updates from backend state.

### FR-4: Create Limited Promotions by Speech

The host should be able to create constrained promotions using natural language, including time limit, quantity limit, and promotional price.

Examples:

```text
"For the next five minutes, first 20 buyers get it at 18.8."
-> Create a flash sale for active SKU: five minutes, 20 units, $18.80.

"First 10 orders for the serum are 19 dollars."
-> Create a quantity-limited flash sale for GlowFix Vitamin C Serum.

"Cancel the flash deal."
-> Cancel the active flash sale.
```

Expected behavior:

- The backend extracts SKU, promotional price, duration, and stock limit.
- If no SKU is mentioned, the promotion applies to the active SKU.
- The backend validates that the promotional price and quantity limit are allowed.
- The frontend should show the active flash-sale state, including price, remaining quantity, and expiry.
- Orders should use flash-sale price only when the sale is active, unexpired, and has enough remaining promotional stock.
- Flash-sale events should be recorded for post-stream reporting.

Acceptance criteria:

- Spoken promotion setup produces a `create_flash_sale` proposed action.
- Approved promotions update backend `flash_sale` state.
- The viewer room displays flash-sale price and remaining stock.
- Orders reduce both SKU stock and flash-sale remaining stock when applicable.
- Cancelled or expired promotions no longer affect order price.

### FR-5: Answer Viewer Questions Autonomously

Viewers should be able to ask free-form questions in the live room. The agent should answer autonomously when it can produce a grounded and safe answer.

Examples:

```text
"Is the serum for morning or night?"
-> Answer using GlowFix grounded facts.

"How big is the tumbler?"
-> Answer using Bamboo Thermal Tumbler facts.

"Can I get 50% off?"
-> Do not invent discount. Escalate or explain only confirmed promotion state.

"Will this cure acne?"
-> Do not make medical claims. Provide a safe, limited response.
```

Expected behavior:

- The ConciergeAgent classifies viewer intent.
- Product questions should resolve SKU by explicit mention first, then active SKU.
- Answers must use SKU facts and current backend state such as price, stock, and active flash sale.
- The agent may answer routine grounded questions without host approval.
- The agent must not invent discounts, delivery promises, authenticity claims, medical guarantees, or unsupported product claims.
- Risky, ambiguous, or unsupported requests should be escalated to the host.
- Viewer Q&A events should be recorded for analytics and report generation.

Acceptance criteria:

- Product fact questions produce `suggest_reply` actions with grounded evidence.
- Unsupported discount requests are blocked or escalated.
- Ambiguous questions ask for clarification or host confirmation.
- Host confirmations are visible in the agent queue and are stored in backend state, not only in local UI state.
- Replies reference current backend price and promotion state when relevant.
- The event ledger records suggested replies and blocked claims.

### FR-6: Generate Post-Stream Review Document

After the livestream, the system should automatically generate a post-stream review document based on backend commerce records and the event ledger.

Expected report contents:

- SKUs shown during the stream.
- Active SKU changes and major host actions.
- Total units sold.
- Total GMV.
- Per-SKU units sold and GMV.
- Flash-sale performance and sell-through.
- Viewer questions handled.
- Risk events, blocked claims, and host escalations.
- Host learning and next recommendations.

Expected behavior:

- The ProducerAgent reads ledger, orders, SKU state, and flash-sale history.
- The report must cite backend numbers exactly.
- The report must not infer listed SKUs from the latest active SKU.
- The report should distinguish factual metrics from narrative recommendations.
- Generating a report should not mutate commerce state except for optionally adding a `report_generated` ledger event.

Acceptance criteria:

- A report can be generated after a demo stream without OpenAI dependency.
- Metrics match backend orders and ledger entries.
- Listed SKUs are derived from SKU listing and flash-sale events.
- Risk events include blocked replies, unsupported claims, and host confirmations.
- The report can be displayed in the host cockpit and exported later if needed.

## 6. Agent Responsibility Mapping

### CoHostAgent

Handles host-facing live operations:

- SKU mention detection.
- Active SKU switching.
- Spoken price changes.
- Spoken discount changes.
- Spoken flash-sale setup or cancellation.
- Host override interpretation.

CoHostAgent outputs proposed actions only. It does not mutate backend commerce state.

### ConciergeAgent

Handles viewer-facing service:

- Viewer question classification.
- SKU grounding for viewer messages.
- Grounded product answers.
- Safe promotion replies.
- Order intent extraction.
- Escalation for unsupported or ambiguous requests.

ConciergeAgent outputs proposed replies and order actions only. It does not finalize commerce state.

### ProducerAgent

Handles post-stream review:

- Reads backend commerce numbers.
- Reads ledger evidence.
- Produces the post-stream report.
- Summarizes risks, learnings, and next recommendations.

ProducerAgent is read-only and does not participate in live commerce mutation.

## 7. Cross-Cutting Extension Workflow

When a new requirement is introduced, use this workflow:

1. Write the user-facing behavior and example utterances.
2. Decide the owner: CoHost, Concierge, Producer, deterministic backend, or frontend-only.
3. Add or reuse a `ProposedAction.type`.
4. Define guardrail policy and host confirmation rules.
5. Add commerce executor support if state changes.
6. Add ledger event payload fields.
7. Add frontend display or controls.
8. Add deterministic evaluation cases.
9. Verify the original demo path still works.

The expected result is that new functionality plugs into the framework instead of bypassing it.

## 8. Frontend Requirements

The frontend should include:

- Host cockpit showing transcript, active SKU, price, stock, flash sale, agent queue, and ledger.
- Viewer room showing active SKU, price, stock, flash sale, and chat.
- Product shelf that reacts to backend active SKU changes.
- Flash-sale panel showing promotional price, time remaining, and remaining sale quantity.
- Suggested reply panel for grounded answers and escalations.
- Post-stream report panel.

Frontend state should come from backend state once backend integration is enabled.

## 9. Backend Requirements

The backend should provide:

- SKU catalogue and alias resolution.
- Active SKU state.
- Current SKU price and stock.
- Flash-sale state.
- Orders and GMV tracking.
- Pending host confirmations.
- Event ledger.
- LangGraph workflow for agent orchestration.
- Guardrail validation before execution.
- Commerce service as the only state writer.
- Realtime update stream for host and viewer surfaces.
- Report generation endpoint.

## 10. Out of Scope for MVP

- Real payment or checkout integration.
- Real marketplace API integration.
- Production database.
- Multi-room livestream infrastructure.
- RTMP/video streaming pipeline.
- Vector database retrieval.
- Fully autonomous price changes without guardrails.

## 11. Success Criteria

The demo is successful when the following path works end to end:

1. Host mentions a product.
2. Backend resolves the SKU.
3. Frontend lists or highlights the SKU.
4. Host switches SKU during the stream.
5. Host changes price or creates a limited promotion through speech.
6. Viewer asks a product question.
7. Agent answers using grounded facts and current backend state.
8. Agent blocks unsupported promotion or unsafe claim.
9. Backend records state changes and ledger events.
10. ProducerAgent generates a factual post-stream review.
