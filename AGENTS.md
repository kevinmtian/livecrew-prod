# LiveCrew Hackathon Instructions

We are building LiveCrew, a one-day hackathon demo for Sea x OpenAI Regional Codex Hackathon.

LiveCrew is an AI operations crew for livestream commerce. It helps a solo host run a live commerce booth by:
1. listening to the host transcript,
2. matching product mentions to a seeded SKU catalogue,
3. updating the on-screen product shelf,
4. answering viewer questions with grounded product facts,
5. applying commerce guardrails,
6. recording all actions in an event ledger,
7. generating a post-stream report.

## Demo Path

The demo path is more important than feature completeness:

1. Host transcript mentions a product.
2. Co-Host Agent selects the matching SKU and updates the product shelf.
3. Viewer asks a product question.
4. Concierge Agent retrieves product facts and drafts a grounded reply.
5. Viewer asks for an unverified discount or unsupported claim.
6. Guardrail blocks hallucinated claims and escalates to host.
7. Host overrides one wrong SKU or answer.
8. Viewer orders with messy natural language.
9. Backend commerce state records the order, stock, flash sale, and ledger event.
10. Producer Agent generates a post-stream report from the event ledger and backend numbers.

## Tech Stack

Use the simplest stable stack:
- Next.js App Router
- TypeScript
- Tailwind CSS
- Local mock data first
- Python FastAPI backend under `backend/`
- LangGraph for backend agent orchestration
- OpenAI API for realtime host transcription and structured agent behavior, behind deterministic contracts and guardrails

Avoid unnecessary dependencies or external services. Do not use RTMP, Qdrant, real Shopee APIs, complex databases, or production-scale realtime infrastructure for the MVP unless explicitly requested. Browser-native media capture and lightweight WebRTC signaling are in scope for the host-to-viewer demo stream.

## Document-Driven Development

All development is document-driven.

- Update `docs/livecrew-feature-requirements.md` before changing user-visible product behavior.
- Update `docs/livecrew-backend-design.md` before changing backend routes, models, graph flow, module boundaries, action types, ledger events, OpenAI integration, or media signaling.
- Implement only after the relevant requirement and backend contract are documented.
- If code needs to diverge from the documents, update the documents first.
- The Python backend is the source of truth for agent decisions, commerce state, guardrails, ledger events, OpenAI calls, and report metrics.
- Next.js should render UI, capture browser media, call the Python backend, and subscribe to backend updates. It should not implement parallel backend truth in API routes or local storage once the Python backend contract exists.

## Routes

The intended app routes are:
- `/` home page linking to the demo surfaces
- `/host` operator cockpit
- `/viewer` customer-facing livestream room
- `/agent_evaluation` reliability dashboard
- `/api/eval/run-agent-suite` deterministic evaluation API when requested

## Product Components

Prioritize these components:
- Live room shell
- Host transcript panel
- Product shelf / highlighted SKU
- Viewer chat panel
- AI suggested replies / agent queue
- Agent event timeline / commerce ledger
- Guardrail status
- Host override control
- Backend commerce panel
- Flash-sale panel
- Orders and KPI panel
- Post-stream report panel
- Agent evaluation category cards and inspectable result table

## Domain Data

Use a shared local catalogue across frontend, backend, agent analyzer, and evaluation suite. The seeded SKUs are:
1. GlowFix Vitamin C Serum
2. HydraMist Cushion SPF
3. Bamboo Thermal Tumbler
4. Satin Cloud Sleep Mask

Each SKU should include `id`, `name`, `aliases`, `price`, `stock`, and grounded `facts`.

Keep shared helpers reusable across host, viewer, agent analyzer, and evaluation suite:
- product name and alias resolution
- active SKU display
- deterministic SKU grounding
- order quantity extraction
- grounded reply generation

## Engineering Rules

- Prefer simple, readable, stable code over clever abstractions.
- Use mock data before API integration.
- Keep temporary UI state local only until the documented Python backend contract exists for that state.
- Keep components small and easy to edit.
- Do not add new production dependencies without explaining why.
- OpenAI integration has been requested for realtime host transcription and agent reasoning, but must remain server-side and behind deterministic validation.
- Do not let model output override deterministic commerce guardrails, SKU resolution, order quantity, backend KPI numbers, or listed SKU calculation.
- After major changes, run the requested checks and fix errors.
- If something is risky for a one-day hackathon, propose and implement a simpler fallback when possible.

## Frontend Rules

- Use a quiet operational dashboard style, not a marketing landing page.
- Build the actual usable workflow as the first screen for each route.
- Keep layouts readable on mobile and desktop.
- Avoid overlapping text and unstable panel sizing.
- Use clear panels for host operations, viewer room state, commerce state, and evaluation details.
- Keep visible copy in English unless explicitly requested otherwise.
- Use cards for repeated items or bounded tool panels, not for nested decorative layouts.

## Commerce Backend Rules

The Python FastAPI backend has been requested. Keep it simple and in-memory for the demo, and orchestrate agent flow with LangGraph.

Backend state should include:
- `active_sku_id`
- SKUs with current price and stock
- flash sale
- orders
- announcements
- event ledger

Every commerce action must append to the event ledger. Orders must record SKU id, quantity, price, and viewer. Reset must clear orders, flash sale, active SKU, and ledger.

Host and viewer should treat Python backend commerce state as the source of truth as soon as the corresponding backend contract is implemented.

## Agent Analyzer Rules

The deterministic analyzer and guardrail layer remain the safety source of truth. OpenAI may classify intent and draft structured actions, but its output must pass deterministic validation before execution.

It should classify viewer messages into the requested commerce and safety intents, including:
- product facts
- promo requests
- price objections and price-change complaints
- product clarification
- orders
- skin safety
- comparisons
- malicious, off-topic, and ambiguous messages

Resolve SKU using explicit product mentions first, then active SKU for contextual references. Infer order quantity from natural language, including numeric and word quantities, and default to 1 only when order intent is clear and quantity is missing.

Do not invent discounts, delivery promises, authenticity claims, medical guarantees, or unsupported product claims.

## Producer Report Rules

Producer reports must cite backend commerce numbers exactly.

Include:
- all SKUs ever listed by host from `list_product` and `create_flash_sale` ledger events
- total units sold and total GMV
- per-product units sold and GMV
- flash-sale sell-through
- questions handled
- risk events
- host learning
- next recommendations

Do not use the latest active SKU as a proxy for top or listed SKU.

## Evaluation Rules

The agent evaluation suite should be deterministic and representative.

Evaluation categories:
- SKU Grounding
- Missing Context
- Grounded Product Facts
- Commerce Intent
- Safety Guardrails
- Judge Free-Form Stress

Each category should have at least 10 cases when the eval suite is requested. The evaluation page should show category cards and expandable spreadsheet-like details without relying on raw ambiguous metric cards.

## Reliability Principle

In commerce, a confident wrong action is worse than no action.

The system should prefer:
- precision over recall,
- grounded answers over fluent guesses,
- host confirmation over risky automation,
- graceful fallback over broken magic.

## Build Commands

Use the package manager already present in the project.

For npm projects:
- `npm run lint`
- `npm run build`
- `npm run dev`

For pnpm projects:
- `pnpm lint`
- `pnpm build`
- `pnpm dev`

Run only the checks requested for the current step, plus any checks needed to verify the files changed in that step.
