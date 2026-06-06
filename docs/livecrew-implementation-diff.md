# LiveCrew Implementation Diff

This document records implementation choices that are not fully captured in the original requirements/design docs, plus the rationale for each choice.

## 1. Next.js-first demo scaffold

Original docs focus on the final FastAPI + LangGraph backend boundary. The current implementation started with a Next.js App Router demo so `/host`, `/viewer`, and `/agent_evaluation` could be exercised early.

Implemented:

- `/host` operator cockpit.
- `/viewer` customer room.
- `/agent_evaluation` local scorecard surface.
- Local room APIs under `/api/live/*` and `/api/room`.

Reason:

- The demo needed a usable visible workflow before the full backend graph existed.
- This allowed UI acceptance checks and state-shape iteration before adding agents.

## 2. Shared TypeScript catalogue before Python model split

Original backend design places the seeded catalogue in `backend/data/catalogue.py`. The current implementation also keeps a frontend shared catalogue in `src/lib/catalogue.ts`.

Implemented:

- Backend-compatible slug IDs:
  - `sku-glowfix-vitamin-c-serum`
  - `sku-hydramist-cushion-spf`
  - `sku-bamboo-thermal-tumbler`
  - `sku-satin-cloud-sleep-mask`
- Frontend helpers for SKU lookup, alias resolution, and active SKU display.

Reason:

- Host, viewer, evaluation, and deterministic analyzer code need catalogue access without depending on the Python process.
- The slug IDs are kept stable so the TypeScript and Python layers can interoperate.

Follow-up:

- When the backend is modularized, keep one canonical seed format or add a sync check so frontend and backend catalogues cannot drift.

## 3. Polling before SSE

Original docs specify `GET /events/stream` with Server-Sent Events. The current UI polls backend state every second.

Implemented:

- `/host` polls FastAPI `/live/state`.
- `/viewer` polls FastAPI `/live/state`.
- Local room state still uses BroadcastChannel/localStorage plus `/api/room` fallback.

Reason:

- Polling is sufficient for the current demo and easier to debug in constrained local environments.
- SSE can be added after the backend state and workflow contracts stabilize.

Follow-up:

- Replace polling with SSE once `RealtimeEvent` and sequence handling are implemented.

## 4. Browser-local room channel

Original docs place viewer message routing in backend workflow endpoints. The current demo also has a browser-local room channel.

Implemented:

- Transport dedupe by message `id`.
- BroadcastChannel/localStorage synchronization.
- Host-only grouped viewer question cards.

Reason:

- It enables multi-tab demo behavior before the backend agent workflow is complete.
- It reduces demo risk while `/events/viewer-message` is still pending.

Follow-up:

- Move durable viewer messages and grouped question handling into the backend workflow or mirror them there.

## 5. Deterministic analyzer in TypeScript

Original docs describe `ConciergeAgent` as a backend agent concept. The current deterministic viewer-message analyzer is implemented in TypeScript.

Implemented:

- `src/lib/agent-analyzer.ts`
- `POST /api/agent/analyze-message`
- Intent classification, SKU grounding, order quantity extraction, safe replies, blocked claims, and group keys.
- `normalizeQuestionKey` is shared with host viewer-question grouping.

Reason:

- The project already had the shared TypeScript catalogue and frontend grouped-question logic.
- This provides a no-OpenAI Phase 1 implementation that can be tested immediately.

Follow-up:

- Wrap analyzer output into `ProposedAction` / `GuardrailResult` / `WorkflowResponse`.
- Decide whether the final deterministic ConciergeAgent lives in TypeScript, Python, or both with shared test fixtures.

## 6. Lightweight evaluation route

Original docs call for `POST /api/eval/run-agent-suite`. The current implementation adds a small deterministic suite focused on the analyzer acceptance cases.

Implemented:

- `POST /api/eval/run-agent-suite`
- Category cards.
- Inspectable rows with input, expected fields, actual analyzer output, pass/fail, and failure reason.

Reason:

- This makes analyzer behavior regression-testable before the full backend graph and eval package exist.

Follow-up:

- Expand each category to at least 10 cases as requested in the backend design.
- Add host command, pricing, promotion, and report-generation cases.

## 7. Simplified FastAPI backend

Original docs specify separate modules for models, state, ledger, realtime, commerce, confirmations, agents, graphs, policies, tools, and eval. The current backend is intentionally compact in `backend/main.py`.

Implemented:

- In-memory state.
- Product listing.
- Price change.
- Flash sale creation.
- Order placement.
- Stock update.
- Announcement creation.
- Event ledger.
- Deterministic report endpoint.

Reason:

- The first backend integration goal was to prove host/viewer state synchronization and commerce panels.
- Keeping the backend compact reduced migration overhead while the state shape was still changing.

Follow-up:

- Split `backend/main.py` into the module layout from `livecrew-backend-design.md`.
- Introduce `CommerceService` as the only state writer.

## 8. Flash-sale order pricing correction

Original docs state that orders should use flash-sale price only when the sale is active and has enough remaining promotional stock. The initial backend reduced flash-sale remaining but still used SKU current price. This has been corrected.

Implemented:

- Matching flash-sale orders now use `flash_sale.sale_price`.
- Flash-sale remaining decreases only when remaining stock is enough for the full order quantity.
- Order payload records `flash_sale_applied`.

Reason:

- This aligns GMV and order history with the documented flash-sale rules.

Follow-up:

- Add expiry checks, `starts_at` / `ends_at`, and cancellation.

## 9. Deterministic report endpoint before ProducerAgent

Original docs specify a `ProducerAgent` for post-stream review. The current implementation adds a deterministic `GET /report` endpoint without LLM or narrative generation.

Implemented:

- Total units sold.
- Total GMV.
- Per-SKU units and GMV.
- Listed SKUs based on ledger evidence.
- Flash-sale sell-through summary.
- Risk-event slots.

Reason:

- The report can be built from exact backend numbers now, while narrative recommendations wait for ProducerAgent.

Follow-up:

- Surface the report in `/host`.
- Add `ProducerAgent` once ledger event types and workflow contracts are stable.

## 10. Current known gaps

Still missing from the original docs:

- Full runtime migration to `ProposedAction`, `PendingAction`, `GuardrailResult`, `WorkflowResponse`.
- `POST /events/host-transcript`.
- LangGraph orchestration.
- SSE realtime stream.
- Modular Python backend layout.
- Full guardrail policy layer.
- Price restore and discount parser.
- Flash-sale cancellation and expiry.
- Host override endpoints.
- Full producer report UI/export.
- Optional OpenAI structured-output integration.

## 11. Backend structure progress

The backend now has the first larger structural pieces from the original design.

Implemented:

- `backend/models.py` defines the shared Pydantic contracts for:
  - `CommerceState`
  - `ProposedAction`
  - `GuardrailResult`
  - `PendingAction`
  - `LedgerEntry`
  - `WorkflowResponse`
- `POST /events/viewer-message` provides a deterministic Concierge-style workflow response.
- Risky or ambiguous viewer messages create backend `pending_actions`.
- `POST /actions/{pending_action_id}/approve` resolves pending actions.
- `POST /actions/{pending_action_id}/reject` rejects pending actions.
- Confirmation lifecycle writes `host_confirmation_requested` and `host_confirmation_resolved` ledger events.

Current limitation:

- `main.py` still uses the legacy dictionary state internally. The new Pydantic contracts are ready, but the runtime has not fully migrated to model instances.
- `POST /events/viewer-message` is deterministic and backend-local, but it is not yet routed through LangGraph.
- `approve` only applies executable `create_order` actions when SKU and quantity are already clear. Other action types are marked approved and recorded, but not yet routed to a commerce executor.
