# LiveCrew

LiveCrew is a hackathon demo for livestream commerce operations. The current implementation follows the project documents:

- Product requirements: `docs/livecrew-feature-requirements.md`
- Backend design: `docs/livecrew-backend-design.md`
- Repo instructions: `AGENTS.md`

The frontend is a Next.js app. The backend is a Python FastAPI service with a LangGraph workflow.

## What Works

- `/host` operator cockpit
  - Sends typed text commands to the Python CoHostAgent workflow.
  - Runs transcript text through the same CoHostAgent path.
  - Starts local camera and microphone capture.
  - Creates a WebRTC media session for the viewer page.
  - Uses an OpenAI Realtime transcription session for live host microphone captions.
- `/viewer` livestream room
  - Connects to the latest host WebRTC media session.
  - Shows host audio/video when the host stream is live.
  - Uses a phone-style layout with the livestream in the upper two-thirds and chat in the lower one-third.
  - Overlays active product name, price, stock, and short facts on the livestream area.
- Python backend
  - FastAPI routes for state, host command, host transcript, transcription, and media signaling.
  - LangGraph workflow for CoHostAgent -> guardrails -> commerce state.
  - In-memory SKU catalogue, active SKU, flash sale, pending actions, and ledger.

## Setup

Install frontend dependencies:

```bash
npm install
```

Create and install backend dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

Create `.env` in the repo root when using OpenAI transcription:

```bash
OPENAI_API_KEY=your_api_key_here
# Optional:
OPENAI_REALTIME_TRANSCRIPTION_MODEL=gpt-4o-transcribe
OPENAI_REALTIME_TRANSCRIPTION_LANGUAGE=en
```

The `.env` file is git-ignored.

## Run

Terminal 1, start the Python backend:

```bash
source .venv/bin/activate
uvicorn backend.main:app --reload --port 8000
```

Terminal 2, start the Next.js frontend:

```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000 npm run dev
```

Open:

- Host: `http://localhost:3000/host`
- Viewer: `http://localhost:3000/viewer`
- Backend health: `http://localhost:8000/health`

## Debug The CoHostAgent

Use the text box in `/host` under `CoHost Text Command`.

Good commands to try:

```text
Switch to the Bamboo Thermal Tumbler.
Drop the tumbler to 22 dollars.
First 20 orders for the serum are 19 dollars for five minutes.
Cancel the flash deal.
Restore the cushion to original price.
```

The Python backend returns structured proposed actions, guardrail results, applied actions, and ledger entries. The host page updates the product shelf and event timeline from that response.

You can also call the backend directly:

```bash
curl -X POST http://localhost:8000/events/host-command \
  -H "Content-Type: application/json" \
  -d '{"text":"Switch to the sleep mask.","source":"typed_command"}'
```

## Debug Host Audio Transcription

1. Start the Python backend with `OPENAI_API_KEY` in `.env`.
2. Open `/host`.
3. Click `Start stream` and allow camera/microphone permissions.
4. The host page requests a short-lived Realtime transcription token from `POST /events/realtime-transcription-token`.
5. The browser sends microphone audio to OpenAI Realtime over WebRTC.
6. Interim transcript deltas appear in the live transcript panel.
7. Completed transcript turns are sent through `POST /events/host-transcript`.

If `OPENAI_API_KEY` is missing, transcription returns a clear backend error and the rest of the demo still works.

## Debug Host To Viewer Stream

1. Start backend and frontend.
2. Open `/viewer` in one browser tab.
3. Open `/host` in another browser tab.
4. Click `Start stream` on `/host` and grant camera/microphone permission.
5. `/viewer` will try to connect automatically. Click `Connect` if it does not attach immediately.
6. Send a product command from `/host`; `/viewer` should update the product overlay in the livestream area.

The stream uses browser `getUserMedia` and WebRTC. FastAPI only stores temporary signaling data: session id, offer, answer, and ICE candidates. Raw audio/video is not stored in backend state or the ledger.

## Useful Backend Endpoints

```text
GET    /health
GET    /state
POST   /reset
POST   /events/host-command
POST   /events/host-transcript
POST   /events/realtime-transcription-token
POST   /events/transcribe-audio
GET    /events/stream
POST   /media/session
GET    /media/session/latest
GET    /media/session/{session_id}
POST   /media/session/{session_id}/offer
POST   /media/session/{session_id}/answer
POST   /media/session/{session_id}/ice-candidate
DELETE /media/session/{session_id}
```

## Checks

Frontend:

```bash
npm run lint
npm run build
```

Backend syntax:

```bash
python3 -m py_compile $(find backend -name '*.py' -print)
```

Backend smoke test:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/events/host-command \
  -H "Content-Type: application/json" \
  -d '{"text":"Switch to the tumbler.","source":"typed_command"}'
```

## Troubleshooting

- `eslint: command not found`: run `npm install`.
- Host page says backend offline: start `uvicorn backend.main:app --reload --port 8000`.
- Browser blocks camera/mic: use `localhost`, grant browser permissions, then restart the host stream.
- Viewer does not show video: keep `/host` streaming, refresh `/viewer`, then click `Connect`.
- OpenAI transcription fails: confirm `.env` has `OPENAI_API_KEY` and restart the backend.
