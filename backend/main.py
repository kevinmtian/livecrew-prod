from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from backend.commerce import approve_pending_action, reject_pending_action
from backend.graphs.livecrew_graph import run_cohost_workflow
from backend.media_signaling import media_store
from backend.models import (
    SessionCreateResponse,
    SignalPayload,
    MonitorResponse,
    MonitorSignalRequest,
    TextEventRequest,
    TranscriptionResponse,
    WorkflowResponse,
)
from backend.agents.monitor import analyze_monitor_signals
from backend.openai_client import transcribe_audio_file
from backend.state import commerce_store


app = FastAPI(title="LiveCrew Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/state")
def get_state():
    return commerce_store.get()


@app.post("/reset")
def reset_state():
    return commerce_store.reset()


@app.post("/actions/{pending_action_id}/approve", response_model=WorkflowResponse)
def approve_action(pending_action_id: str):
    state = commerce_store.get()
    result = approve_pending_action(pending_action_id, state)
    if not result:
        raise HTTPException(status_code=404, detail="Pending action not found.")

    applied_actions, guardrail_results, ledger_entries = result
    state.ledger = [*ledger_entries, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return WorkflowResponse(
        proposed_actions=[],
        guardrail_results=guardrail_results,
        pending_actions=updated_state.pending_actions,
        applied_actions=applied_actions,
        ledger_entries=ledger_entries,
        state=updated_state,
    )


@app.post("/actions/{pending_action_id}/reject", response_model=WorkflowResponse)
def reject_action(pending_action_id: str):
    state = commerce_store.get()
    result = reject_pending_action(pending_action_id, state)
    if not result:
        raise HTTPException(status_code=404, detail="Pending action not found.")

    guardrail_results, ledger_entries = result
    state.ledger = [*ledger_entries, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return WorkflowResponse(
        proposed_actions=[],
        guardrail_results=guardrail_results,
        pending_actions=updated_state.pending_actions,
        applied_actions=[],
        ledger_entries=ledger_entries,
        state=updated_state,
    )


@app.post("/events/host-command")
def host_command(request: TextEventRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Text command is required.")
    return run_cohost_workflow(request.text.strip(), "typed_command")


@app.post("/events/host-transcript")
def host_transcript(request: TextEventRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Transcript text is required.")
    return run_cohost_workflow(request.text.strip(), "speech_transcript")


@app.post("/events/monitor-signal", response_model=MonitorResponse)
def monitor_signal(request: MonitorSignalRequest):
    return analyze_monitor_signals(request)


@app.post("/events/transcribe-audio", response_model=TranscriptionResponse)
async def transcribe_audio(file: UploadFile = File(...)):
    suffix = Path(file.filename or "host-audio.webm").suffix or ".webm"
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = Path(temp_file.name)
            temp_file.write(await file.read())
        text = transcribe_audio_file(temp_path)
        return TranscriptionResponse(text=text, source="openai")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        if "temp_path" in locals():
            temp_path.unlink(missing_ok=True)


@app.get("/events/stream")
async def event_stream():
    async def generate():
        while True:
            state = commerce_store.get().model_dump(mode="json")
            yield f"data: {json.dumps({'type': 'state', 'state': state})}\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/media/session", response_model=SessionCreateResponse)
def create_media_session():
    session = media_store.create_session()
    return SessionCreateResponse(session_id=session.session_id)


@app.get("/media/session/latest")
def get_latest_media_session():
    session = media_store.get_latest_session()
    if not session:
        raise HTTPException(status_code=404, detail="No media session is available.")
    return session


@app.get("/media/session/{session_id}")
def get_media_session(session_id: str):
    session = media_store.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.post("/media/session/{session_id}/offer")
def set_media_offer(session_id: str, signal: SignalPayload):
    session = media_store.set_offer(session_id, signal.payload)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.post("/media/session/{session_id}/answer")
def set_media_answer(session_id: str, signal: SignalPayload):
    session = media_store.set_answer(session_id, signal.payload)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.post("/media/session/{session_id}/ice-candidate")
def add_media_candidate(session_id: str, signal: SignalPayload):
    session = media_store.add_candidate(session_id, signal.role, signal.payload)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.delete("/media/session/{session_id}")
def stop_media_session(session_id: str):
    session = media_store.stop_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session
