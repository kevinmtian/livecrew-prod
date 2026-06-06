# LiveCrew Commerce Backend

Simple in-memory FastAPI service for demo commerce state.

Structure:

- `main.py` owns FastAPI request models, routes, and deterministic viewer-message workflow.
- `state.py` owns the in-memory commerce state and reset helpers.
- `ledger.py` owns event ledger writes.
- `commerce.py` owns SKU, pricing, flash sale, order, announcement, and report behavior.
- `confirmations.py` owns pending action creation plus approve/reject resolution.
- `agents/concierge.py` owns viewer-facing message analysis, reply suggestions, order proposals, and escalations.
- `agents/guardrails.py` owns deterministic guardrail decisions used by agents.
- `agents/producer.py` owns report generation workflow wiring.
- `agents/cohost.py` owns the early host-transcript parser entry point for future host commands.
- `agents/text.py` and `agents/actions.py` hold shared parsing and workflow object helpers.

Current route wiring:

- `POST /events/viewer-message` uses `agents/concierge.py`.
- `GET /report` uses `agents/producer.py`.
- `agents/cohost.py` is intentionally separate and ready for a future `POST /events/host-transcript` route.

Run:

```bash
cd backend
python3 -m pip install -r requirements.txt
python3 -m uvicorn main:app --reload --port 8000
```

Routes:

- `GET /live/state`
- `GET /report`
- `POST /events/viewer-message`
- `POST /actions/{pending_action_id}/approve`
- `POST /actions/{pending_action_id}/reject`
- `POST /live/order`
- `POST /live/reset`
- `POST /tools/list_product`
- `POST /tools/change_price`
- `POST /tools/create_flash_sale`
- `POST /tools/update_stock`
- `POST /tools/send_announcement`
