from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from backend.commerce import apply_action
from backend.graphs.livecrew_graph import run_cohost_workflow, run_concierge_workflow
from backend.media_signaling import media_store
from backend.models import (
    AgentDecision,
    AppliedAction,
    LedgerEntry,
    PendingReplyRequest,
    SessionCreateResponse,
    SignalPayload,
    TextEventRequest,
    TranscriptionResponse,
    ViewerMessageRequest,
    WorkflowResponse,
)
from backend.openai_client import transcribe_audio_file
from backend.policies.guardrails import validate_action
from backend.state import commerce_store


app = FastAPI(title="LiveCrew Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
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


@app.post("/events/viewer-message")
def viewer_message(request: ViewerMessageRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Viewer message is required.")
    return run_concierge_workflow(request.text.strip(), request.viewer.strip() or "viewer")


def _resolve_pending_reply(
    pending_action_id: str,
    request: PendingReplyRequest,
    reject: bool = False,
) -> WorkflowResponse:
    state = commerce_store.get()
    pending = next(
        (action for action in state.pending_actions if action.id == pending_action_id),
        None,
    )
    if not pending:
        raise HTTPException(status_code=404, detail="Pending action not found.")
    if pending.action.type != "suggest_reply":
        raise HTTPException(status_code=400, detail="Pending action is not a reply draft.")

    state.pending_actions = [
        action for action in state.pending_actions if action.id != pending_action_id
    ]

    if reject:
        ledger_entry = LedgerEntry(
            type="host_confirmation_resolved",
            detail="Host discarded concierge reply draft without sending a viewer reply.",
            source_text=pending.action.source_text,
            payload={
                "pending_action_id": pending_action_id,
                "status": "rejected",
                "viewer": pending.action.viewer,
            },
        )
        state.ledger = [ledger_entry, *state.ledger][:200]
        updated_state = commerce_store.replace(state)
        decision = AgentDecision(
            agent="ConciergeAgent",
            summary="Host discarded concierge reply draft.",
            confidence=1,
            source_text=pending.action.source_text,
        )
        return WorkflowResponse(
            agent_decisions=[decision],
            proposed_actions=[],
            guardrail_results=[],
            pending_actions=updated_state.pending_actions,
            applied_actions=[],
            ledger_entries=[ledger_entry],
            suggested_reply=None,
            state=updated_state,
        )

    reply_text = (request.reply_text or pending.action.reply_text or "").strip()
    if not reply_text:
        raise HTTPException(status_code=400, detail="Reply text is required.")

    action = pending.action.model_copy(
        update={
            "reply_text": reply_text,
            "requires_host_confirmation": False,
            "reason": "Host approved concierge reply draft.",
        }
    )
    guardrail = validate_action(action, state)
    applied, ledger_entry = apply_action(action, guardrail, state)
    resolution_entry = LedgerEntry(
        type="host_confirmation_resolved",
        detail="Host approved concierge reply draft."
        if guardrail.allowed
        else "Host reply draft failed guardrail validation.",
        source_text=action.source_text,
        payload={
            "pending_action_id": pending_action_id,
            "status": "approved" if guardrail.allowed else "blocked",
            "viewer": action.viewer,
        },
    )
    state.ledger = [resolution_entry, ledger_entry, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    decision = AgentDecision(
        agent="ConciergeAgent",
        summary="Host resolved concierge reply draft.",
        confidence=1,
        source_text=action.source_text,
    )
    applied_actions: list[AppliedAction] = [applied] if applied else []
    return WorkflowResponse(
        agent_decisions=[decision],
        proposed_actions=[action],
        guardrail_results=[guardrail],
        pending_actions=updated_state.pending_actions,
        applied_actions=applied_actions,
        ledger_entries=[resolution_entry, ledger_entry],
        suggested_reply=reply_text if guardrail.allowed else None,
        state=updated_state,
    )


@app.post("/actions/{pending_action_id}/approve")
def approve_pending_reply(pending_action_id: str):
    return _resolve_pending_reply(pending_action_id, PendingReplyRequest())


@app.post("/actions/{pending_action_id}/reply")
def reply_to_pending_action(pending_action_id: str, request: PendingReplyRequest):
    return _resolve_pending_reply(pending_action_id, request)


@app.post("/actions/{pending_action_id}/reject")
def reject_pending_reply(pending_action_id: str):
    return _resolve_pending_reply(pending_action_id, PendingReplyRequest(), reject=True)


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
