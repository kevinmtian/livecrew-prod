# LiveCrew Feature Requirements

## 1. Overview

LiveCrew is an AI operations crew for livestream commerce. The product goal is to let a solo livestream host operate product listing, pricing, promotion, viewer Q&A, and post-stream review through natural speech and chat.

The experience should feel like:

```text
Host speaks naturally
-> OpenAI realtime transcription produces host transcript events
-> CoHostAgent uses OpenAI LLM structured output to identify intent
-> backend validates the action
-> frontend updates the live room
-> ConciergeAgent answers viewer questions from current commerce reality
-> ProducerAgent generates a post-stream report from recorded facts
```

This document describes the first target product capabilities and the extension rules for future capabilities. It is not intended to be a complete final requirement list. The backend technical design is documented separately in `docs/livecrew-backend-design.md`.

## 2. Product Principles

- The host should be able to operate the live room without clicking through complex controls.
- Host speech should be transcribed in real time through the OpenAI API before it enters the agent workflow.
- The frontend should reflect backend commerce state as the source of truth.
- Agents should use the OpenAI API for language understanding, grounded reply drafting, and report generation in the OpenAI-enabled demo path.
- Agents may propose actions and replies, but deterministic backend services must execute commerce changes.
- LLM output must be structured, validated, and visible in the UI before it affects commerce state.
- The system should prefer host confirmation over risky automation.
- Viewer-facing answers must be grounded in product facts and current live commerce state.
- Every important action should be recorded so the post-stream report can explain what happened.
- The framework should stay structured, cohesive, loosely coupled, and easy to extend as new livestream commerce requirements appear.
- Development should be document-driven: product behavior, backend contracts, frontend states, and acceptance criteria must be captured in this document or `docs/livecrew-backend-design.md` before implementation.

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

### NFR-8: OpenAI Integration Boundary

OpenAI integration is now part of the target product experience, but it must sit behind deterministic contracts and guardrails.

Requirements:

- Host audio should be sent to the OpenAI API for realtime transcription.
- Transcript events should be normalized before they enter the CoHostAgent workflow.
- CoHostAgent should call the OpenAI API to classify host intent and produce structured `ProposedAction` objects.
- ConciergeAgent should call the OpenAI API to classify viewer messages and draft grounded replies.
- ProducerAgent should call the OpenAI API to generate a narrative post-stream report from ledger and commerce facts.
- LLM responses must not directly mutate commerce state.
- LLM responses must pass deterministic validation for SKU grounding, order quantity, price, stock, unsupported claims, and host-confirmation requirements.
- If OpenAI is unavailable, times out, or returns invalid structured output, the system should fall back to deterministic behavior or ask for host confirmation instead of executing a risky action.
- OpenAI prompts, model choices, and response schemas should be centralized so agents do not drift into incompatible formats.

### NFR-9: API Key and Runtime Configuration

OpenAI credentials are provided by the developer through local environment files.

Requirements:

- The app should read the API key from `.env`.
- The expected variable name is `OPENAI_API_KEY`.
- Optional model or realtime settings may be provided through additional environment variables, but safe defaults should exist for the demo.
- API keys must never be hardcoded in source files, committed to git, sent to the browser, or displayed in UI logs.
- OpenAI calls should run only on the server side.
- Missing or invalid API key state should be surfaced as an operational setup issue, not as a broken blank screen.

### NFR-10: Document-Driven Development

All implementation work should follow the project documents as the source of truth.

Requirements:

- New product behavior must first be added to `docs/livecrew-feature-requirements.md` with expected behavior and acceptance criteria.
- Backend architecture, routes, models, graph flow, and module ownership must be added to `docs/livecrew-backend-design.md` before backend implementation.
- Frontend work should reference documented states, actions, and API contracts instead of inventing local-only behavior.
- If implementation discovers a better or safer approach, update the documents first, then adjust code.
- Pulling behavior directly into code without matching documentation is out of process unless it is a small bug fix with no product or API impact.
- Completed features should be traceable from requirement to backend contract to frontend UI state to verification check.

## 5. Initial Functional Requirements

### FR-0: Realtime Host Speech Transcription

The host should be able to speak naturally during the livestream. The system should use the OpenAI API to transcribe host speech in real time and feed transcript events into the CoHostAgent.

Examples:

```text
Host speaks: "Let's show the tumbler now."
-> OpenAI realtime transcription emits: "Let's show the tumbler now."
-> CoHostAgent receives the transcript event.
```

Expected behavior:

- The host cockpit should provide a microphone-driven transcription flow for the demo.
- Host audio should use a realtime transcription flow for low-latency transcript display.
- The host cockpit should show in-progress transcript text in the livestream panel while the host is speaking.
- Only finalized transcript segments should trigger commerce actions.
- Each finalized transcript segment should become a normalized `host_transcript` event.
- Transcript events should include timestamp, source, text, and processing status.
- Transcription errors should be visible to the host and should not trigger agent actions.
- The event ledger should record finalized transcript events that lead to proposed or applied actions.

Acceptance criteria:

- While the host is speaking during a live stream, transcript text appears in the livestream transcript area.
- With `OPENAI_API_KEY` configured, host speech can produce finalized transcript events for CoHostAgent processing.
- A finalized transcript segment can trigger CoHostAgent intent recognition.
- If transcription fails, no commerce state is mutated.
- The host can still use the typed CoHost debug input as a fallback for hackathon reliability.

### FR-0A: Text Command Debug Input for CoHostAgent

For debugging and demo control, the host cockpit should support typed text commands that are sent to the same CoHostAgent workflow as finalized speech transcripts.

Examples:

```text
Host types: "Switch to the sleep mask."
-> CoHostAgent receives a `host_text_command` event.
-> CoHostAgent proposes `set_active_sku` for Satin Cloud Sleep Mask.
```

Expected behavior:

- The host cockpit should include a text command input dedicated to CoHostAgent debugging.
- The typed debug input should be the only manual text entry point for CoHostAgent commands in the host cockpit.
- Submitted text commands should use the same intent recognition, structured action schema, guardrails, host-confirmation flow, commerce executor, and ledger path as speech transcripts.
- Text commands should be clearly labeled as typed/debug input in transcript history and ledger evidence.
- Text commands should not bypass safety checks, SKU grounding, price validation, or host confirmation.
- The host should be able to submit text commands even when microphone permission, OpenAI realtime transcription, or camera capture is unavailable.

Acceptance criteria:

- A typed command can trigger the same product listing, price, promotion, and override proposals as a spoken transcript.
- The UI shows whether an action came from speech transcription or typed debug input.
- The ledger records the typed command source text and resulting proposed or applied action.
- Invalid or ambiguous typed commands are escalated or rejected using the same rules as speech commands.

### FR-0B: Host Camera and Microphone Livestream to Viewer

The host cockpit should access the host's Mac camera and microphone through the browser and stream live audio/video to the viewer room for the demo.

Expected behavior:

- The host page should request browser permission for camera and microphone access.
- The host should be able to start and stop the live camera/microphone stream.
- The host page should show a local preview so the host can verify camera framing and microphone state.
- The viewer page should show the host's live video and audio with low latency.
- Host audio should be available both for viewer playback and for OpenAI realtime transcription.
- If the camera is unavailable, the viewer page should degrade to audio-only or a clear placeholder.
- If the microphone is unavailable, the viewer page should show video-only and transcription should not trigger agent actions.
- Browser permission errors should be visible in the host cockpit.
- The demo should not record or persist raw audio/video unless a later requirement explicitly asks for recording.

Acceptance criteria:

- On a Mac with browser camera and microphone permission granted, `/host` can capture local media and `/viewer` can play the live host stream.
- The host can stop the stream and the viewer room reflects that the stream is offline.
- Media permission failure does not break product shelf, chat, agent queue, or commerce state.
- The implementation uses browser-native media capture and a lightweight realtime transport suitable for the hackathon demo.

### FR-0C: Mobile Viewer Room Layout

The viewer room should look and behave like a mobile livestream commerce app instead of an operator dashboard.

Expected behavior:

- `/viewer` should render as a phone-sized customer room, centered on desktop and filling the available viewport on mobile.
- The upper two-thirds of the phone room should be the livestream area.
- The lower one-third of the phone room should be the chat area.
- The livestream area should show host video when available, and a clear offline or connecting state when unavailable.
- When CoHostAgent or host actions set the active SKU, the livestream area should show the active product details.
- Active product details should include product name, price, stock, and a short grounded description from SKU facts.
- Product information should come from backend active SKU state, with local demo state only as a fallback.
- The product overlay must not hide the chat input or make the video controls unusable.
- Viewer chat should stay readable and scrollable within the lower third of the phone layout.

Acceptance criteria:

- `/viewer` visually reads as a mobile livestream room on desktop and mobile.
- The livestream section occupies roughly two-thirds of the phone frame and the chat section roughly one-third.
- Changing the active SKU from `/host` updates the product information shown over the livestream area.
- The chat panel remains usable without overlapping the product overlay.

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

- CoHostAgent receives finalized transcript events from OpenAI realtime transcription or typed fallback input.
- CoHostAgent uses the OpenAI API to classify host intent and propose SKU listing or switching actions.
- The backend resolves product mentions against the seeded SKU catalogue.
- Explicit product mentions should take priority over the current active SKU.
- Alias matching should support natural names, partial names, and common product references.
- If the product mention is ambiguous, the backend should ask for host confirmation instead of switching automatically.
- Ambiguous or risky actions should enter a pending host-confirmation queue and must not mutate commerce state until approved.
- The frontend host cockpit and viewer room should update to show the active SKU.
- The action should be recorded in the event ledger.

Acceptance criteria:

- Given a host transcript that clearly mentions one seeded SKU, CoHostAgent returns a proposed `set_active_sku` action using the shared structured action schema.
- The proposed action includes source transcript text, confidence, reason, and evidence.
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

- CoHostAgent uses the OpenAI API to extract price or discount intent from host transcript.
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

### FR-3A: Update SKU Stock

The host should be able to update the current backend stock for a grounded SKU from the host cockpit or host command stream.

Examples:

```text
"Set the tumbler stock to 60."
-> update_stock for Bamboo Thermal Tumbler with stock 60.

"Update this product inventory to 12."
-> update_stock for the active SKU with stock 12.
```

Expected behavior:

- Explicit SKU mentions should determine which SKU is affected.
- If no SKU is explicitly mentioned, contextual phrases like "this product" should apply to the active SKU.
- Stock changes should update backend SKU state, not just frontend display text.
- Stock must be a non-negative integer.
- Stock updates must use the same structured action, guardrail, commerce service, ledger, and realtime state path as other host actions.
- Every stock update should be recorded in the ledger as `stock_updated`.
- Viewer and host stock displays should update from backend state.

Acceptance criteria:

- Host stock changes produce an `update_stock` proposed action.
- Approved stock changes update the target SKU `stock`.
- Invalid stock values are blocked before execution.
- The frontend stock display updates from backend state.

### FR-4: Create Limited Promotions by Speech

The host should be able to create constrained promotions using natural language, including time limit, quantity limit, and promotional price.

Examples:

```text
"For the next five minutes, first 20 buyers get it at 18.8."
-> Create a flash sale for active SKU: five minutes, 20 units, $18.80.

"First 10 orders for the serum are 19 dollars."
-> Create a quantity-limited flash sale for GlowFix Vitamin C Serum.

"设置Vitamin C促销，限时3min，限价10元，限量10个"
-> Use LLM intent extraction to create a flash sale for GlowFix Vitamin C Serum: three minutes, 10 units, $10.

"Cancel the flash deal."
-> Cancel the active flash sale.
```

Expected behavior:

- CoHostAgent uses the OpenAI API to extract SKU, promotional price, duration, and stock limit from natural host language, including multilingual and mixed-language phrasing.
- If no SKU is mentioned, the promotion applies to the active SKU.
- The backend validates that the promotional price and quantity limit are allowed.
- The frontend should show the active flash-sale state, including price, remaining quantity, and a prominent countdown timer.
- Orders should use flash-sale price only when the sale is active, unexpired, and has enough remaining promotional stock.
- Flash-sale events should be recorded for post-stream reporting.
- If OpenAI is unavailable, times out, or returns invalid structured output, the backend may use deterministic fallback parsing or request host confirmation, but it should not execute an unvalidated promotion.

Acceptance criteria:

- Spoken promotion setup produces a `create_flash_sale` proposed action.
- Mixed-language promotion setup produces the same structured action fields as English setup when OpenAI extraction is available.
- Approved promotions update backend `flash_sale` state.
- The viewer room displays flash-sale price, remaining stock, and a prominent countdown timer.
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

- The ConciergeAgent uses the OpenAI API to classify viewer intent and draft a response.
- Product questions should resolve SKU by explicit mention first, then active SKU.
- Answers must use SKU facts and current backend state such as price, stock, and active flash sale.
- The agent may answer routine grounded questions without host approval.
- The agent must not invent discounts, delivery promises, authenticity claims, medical guarantees, or unsupported product claims.
- Risky, ambiguous, or unsupported requests should be escalated to the host.
- Viewer Q&A events should be recorded for analytics and report generation.

Acceptance criteria:

- Product fact questions produce `suggest_reply` actions with grounded evidence and structured LLM output.
- Unsupported discount requests are blocked or escalated.
- Ambiguous questions ask for clarification or host confirmation.
- Host confirmations are visible in the agent queue and are stored in backend state, not only in local UI state.
- Pending host confirmations in the host cockpit should provide approve and reject controls that resolve the backend pending action.
- Replies reference current backend price and promotion state when relevant.
- The event ledger records suggested replies and blocked claims.

### FR-5A: Viewer Comment Monitoring and Host Word Cloud

During the livestream, LiveCrew should monitor viewer comments and give the host a compact view of recent demand. Every minute, the host cockpit should request an AI-assisted summary of the past three minutes of viewer comments and render it as a word cloud with grounded reply suggestions.

Expected behavior:

- Viewer messages submitted from `/viewer` should be recorded in backend state with viewer name, text, timestamp, resolved SKU when available, and ConciergeAgent suggested reply when one can be safely drafted.
- ConciergeAgent should resolve SKU by explicit product mention first, then by the current active SKU for contextual comments such as "this one".
- Suggested replies must cite only seeded SKU facts, current backend price, stock, and active flash-sale state.
- Unsupported discounts, medical guarantees, delivery promises, authenticity claims, and unsafe claims should be handled with safe wording or host escalation instead of invented promises.
- The host cockpit should show recent backend viewer comments, per-message AI draft replies, and controls to use a draft reply or ignore it.
- Once per minute, the host cockpit should call the backend to summarize comments from the previous three minutes.
- The word cloud should group repeated viewer language and product-specific themes into weighted terms.
- The word cloud snapshot should include source comment count, time window, active SKU context, short summary, and suggested host talking points or replies.
- If OpenAI is unavailable, the backend should generate a deterministic fallback word cloud from comment terms and SKU aliases.
- Reset should clear stored viewer comments and word cloud snapshots.

Acceptance criteria:

- Sending messages from `/viewer` updates backend `viewer_comments` and they appear in `/host` without page refresh after polling.
- Product questions produce grounded `suggest_reply` actions and suggested reply text tied to the active or explicitly mentioned SKU.
- A host can click a suggested reply from the monitoring panel and send it through the existing host reply flow.
- The host cockpit refreshes the three-minute word cloud every minute and also provides a manual refresh for demo testing.
- The word cloud never exposes the OpenAI API key and does not call OpenAI from the browser.
- Unsupported claims or discount requests do not produce invented commercial promises.

### FR-5B: Viewer Purchase Confirmation and Host Checkout Nudges

Viewers should be able to buy the currently displayed product from the mobile live room. The purchase flow should protect stock accuracy and give the host a chance to encourage viewers who are hesitating at checkout.

Expected behavior:

- The viewer room should show a purchase control for the currently active SKU.
- Clicking purchase should open a confirmation modal instead of immediately creating an order.
- The modal should show product name, current backend price, selected quantity, total price, and current available quantity.
- Quantity must be a positive integer and must not exceed the currently available purchasable quantity.
- Current price should come from backend commerce state: use active flash-sale price when the flash sale is active and has remaining sale stock; otherwise use the SKU current price.
- Opening the modal should create a backend `checkout_intent` with status `pending`.
- Confirming the modal should create a backend order, reduce SKU stock, reduce flash-sale remaining stock when applicable, close the modal, and append ledger events.
- Cancelling or closing the modal should mark the backend checkout intent as `cancelled`.
- If stock changes while the modal is open, confirmation should revalidate stock and fail gracefully instead of overselling.
- The host cockpit should surface a nudge when one or more unique viewers have pending checkout intents older than five seconds.
- The nudge should show the number of hesitant viewers and a short product breakdown so the host can encourage them verbally.

Acceptance criteria:

- A viewer can start checkout for the active product and sees a confirmation modal.
- The modal prevents selecting a quantity greater than the currently available quantity.
- Confirming checkout creates an order using the backend current price and updates backend stock.
- Flash-sale purchases use sale price only while sale stock is available.
- Host sees a checkout nudge after a viewer remains in the modal for at least five seconds without confirming.
- Confirmed or cancelled checkout intents no longer count toward the host nudge.

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
- The ProducerAgent uses the OpenAI API to draft the narrative sections of the report.
- The report must cite backend numbers exactly.
- The report must not infer listed SKUs from the latest active SKU.
- The report should distinguish factual metrics from narrative recommendations.
- Generating a report should not mutate commerce state except for optionally adding a `report_generated` ledger event.

Acceptance criteria:

- A report can be generated after a demo stream using OpenAI for narrative generation when the API key is configured.
- If OpenAI is unavailable, a deterministic report fallback should still show backend metrics for demo continuity.
- Metrics match backend orders and ledger entries.
- Listed SKUs are derived from SKU listing and flash-sale events.
- Risk events include blocked replies, unsupported claims, and host confirmations.
- The report can be displayed in the host cockpit and exported later if needed.

## 6. Agent Responsibility Mapping

### CoHostAgent

Handles host-facing live operations:

- OpenAI realtime transcript consumption.
- SKU mention detection.
- Active SKU switching.
- Spoken price changes.
- Spoken discount changes.
- Spoken flash-sale setup or cancellation.
- Host override interpretation.

CoHostAgent outputs proposed actions only. It does not mutate backend commerce state.

CoHostAgent should use OpenAI structured output for intent recognition, then pass proposed actions through deterministic SKU resolution and guardrails.

### ConciergeAgent

Handles viewer-facing service:

- Viewer question classification.
- SKU grounding for viewer messages.
- Grounded product answers.
- Safe promotion replies.
- Order intent extraction.
- Escalation for unsupported or ambiguous requests.

ConciergeAgent outputs proposed replies and order actions only. It does not finalize commerce state.

ConciergeAgent should use OpenAI structured output for intent classification and reply drafting, then pass replies through grounding and commerce guardrails.

### ProducerAgent

Handles post-stream review:

- Reads backend commerce numbers.
- Reads ledger evidence.
- Produces the post-stream report.
- Summarizes risks, learnings, and next recommendations.

ProducerAgent is read-only and does not participate in live commerce mutation.

ProducerAgent may use OpenAI to draft narrative analysis, but all numeric metrics and listed SKUs must come from backend state and ledger records.

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
9. Add or update OpenAI prompt and structured-output schema coverage when the capability needs LLM understanding.
10. Verify the original demo path still works.

The expected result is that new functionality plugs into the framework instead of bypassing it.

## 8. Frontend Requirements

The frontend should include:

- Host microphone/transcription controls for the OpenAI realtime transcription flow.
- Host text command input for CoHostAgent debugging.
- Host camera and microphone permission controls.
- Host local video preview with live/offline/muted states.
- Host cockpit showing live transcript, active SKU, price, stock, flash sale, agent queue, and ledger.
- Viewer room styled as a mobile livestream commerce room.
- Viewer livestream area occupying the top two-thirds of the mobile room.
- Viewer chat area occupying the bottom one-third of the mobile room.
- Viewer product overlay showing active SKU name, price, stock, and short grounded facts during the livestream.
- Product shelf that reacts to backend active SKU changes.
- Flash-sale panel showing promotional price, time remaining, and remaining sale quantity.
- Suggested reply panel for grounded answers and escalations.
- Post-stream report panel.

Frontend state should come from backend state once backend integration is enabled.

Host media capture should use browser permissions and should not require installing a native Mac app.

## 9. Backend Requirements

The backend should provide:

- Python FastAPI service under `backend/` as the backend runtime.
- LangGraph workflow as the required orchestration layer for CoHostAgent, ConciergeAgent, ProducerAgent, guardrails, confirmation, and commerce application.
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
- Server-side OpenAI client configuration using `OPENAI_API_KEY` from `.env`.
- Realtime transcription endpoint or bridge for host speech.
- Structured LLM action generation for CoHostAgent, ConciergeAgent, and ProducerAgent.
- Host text command endpoint that normalizes typed debug commands into the CoHostAgent workflow.
- Lightweight signaling or session coordination for host-to-viewer browser media streaming.

The Next.js app should not implement core backend behavior directly. It may render UI, capture browser media, call the Python backend, subscribe to backend realtime updates, and proxy requests only when that proxy does not become the source of truth.

## 10. Out of Scope for MVP

- Real payment or checkout integration.
- Real marketplace API integration.
- Production database.
- Multi-room livestream infrastructure.
- Production RTMP/video streaming pipeline.
- Media recording, replay, clipping, or cloud storage.
- Vector database retrieval.
- Fully autonomous price changes without guardrails.

## 11. Success Criteria

The demo is successful when the following path works end to end:

1. Host mentions a product.
2. OpenAI realtime transcription produces a finalized host transcript segment.
3. CoHostAgent uses OpenAI structured output to propose the intended action.
4. Backend validates the proposed SKU and guardrails.
5. Frontend lists or highlights the SKU.
6. Host can submit the same operation as a typed debug command when speech input is inconvenient.
7. Viewer sees and hears the host's live camera/microphone stream.
8. Host switches SKU during the stream.
9. Host changes price or creates a limited promotion through speech or typed debug command.
10. Viewer asks a product question.
11. ConciergeAgent uses OpenAI to draft a grounded answer from product and commerce facts.
12. Agent blocks unsupported promotion or unsafe claim.
13. Backend records state changes and ledger events.
14. ProducerAgent generates a factual post-stream review using backend numbers and OpenAI narrative drafting.
