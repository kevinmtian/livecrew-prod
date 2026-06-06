from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from backend.agents.monitor import analyze_monitor_signals
from backend.commerce import apply_action, approve_pending_action, reject_pending_action
from backend.graphs.livecrew_graph import run_cohost_workflow, run_concierge_workflow
from backend.media_signaling import media_store
from backend.models import (
    AgentDecision,
    AppliedAction,
    LedgerEntry,
    PendingReplyRequest,
    RealtimeTranscriptionTokenResponse,
    SessionCreateResponse,
    SignalPayload,
    MonitorResponse,
    MonitorSignalRequest,
    TextEventRequest,
    TranscriptionResponse,
    ViewerLoginRequest,
    ViewerLoginResponse,
    ViewerMessageRequest,
    ViewerSession,
    WorkflowResponse,
)
from backend.openai_client import (
    create_realtime_transcription_token,
    transcribe_audio_file,
)
from backend.policies.guardrails import validate_action
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


@app.post("/viewer-login", response_model=ViewerLoginResponse)
def viewer_login(request: ViewerLoginRequest):
    username = request.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required.")

    state = commerce_store.get()
    username_key = username.casefold()
    if any(session.username.casefold() == username_key for session in state.viewer_sessions):
        raise HTTPException(status_code=409, detail="Username is already logged in.")

    session = ViewerSession(username=username)
    ledger_entry = LedgerEntry(
        type="viewer_logged_in",
        detail=f"{username} logged in to the viewer room.",
        payload={"session_id": session.id, "username": username},
    )
    state.viewer_sessions = [session, *state.viewer_sessions][:200]
    state.ledger = [ledger_entry, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return ViewerLoginResponse(session=session, state=updated_state)


@app.get("/viewer-login/{session_id}", response_model=ViewerLoginResponse)
def get_viewer_login(session_id: str):
    state = commerce_store.get()
    session = next(
        (viewer_session for viewer_session in state.viewer_sessions if viewer_session.id == session_id),
        None,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Viewer session not found.")
    return ViewerLoginResponse(session=session, state=state)


@app.post("/viewer-login/{session_id}/logout", response_model=ViewerLoginResponse)
def viewer_logout(session_id: str):
    state = commerce_store.get()
    session = next(
        (viewer_session for viewer_session in state.viewer_sessions if viewer_session.id == session_id),
        None,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Viewer session not found.")

    state.viewer_sessions = [
        viewer_session
        for viewer_session in state.viewer_sessions
        if viewer_session.id != session_id
    ]
    ledger_entry = LedgerEntry(
        type="viewer_logged_out",
        detail=f"{session.username} logged out of the viewer room.",
        payload={"session_id": session.id, "username": session.username},
    )
    state.ledger = [ledger_entry, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return ViewerLoginResponse(session=session, state=updated_state)


@app.post("/actions/{pending_action_id}/approve", response_model=WorkflowResponse)
def approve_action(pending_action_id: str):
    state = commerce_store.get()
    result = approve_pending_action(pending_action_id, state)
    if not result:
        raise HTTPException(status_code=404, detail="Pending action not found.")

    applied_actions, guardrail_results, ledger_entries = result
    state.ledger = [*ledger_entries, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    suggested_reply = next(
        (
            action.detail
            for action in applied_actions
            if action.type == "suggest_reply"
        ),
        None,
    )
    return WorkflowResponse(
        proposed_actions=[],
        guardrail_results=guardrail_results,
        pending_actions=updated_state.pending_actions,
        applied_actions=applied_actions,
        ledger_entries=ledger_entries,
        suggested_reply=suggested_reply,
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


@app.post("/events/viewer-message")
def viewer_message(request: ViewerMessageRequest):
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Viewer message is required.")
    return run_concierge_workflow(request.text.strip(), request.viewer.strip() or "viewer")


def _send_edited_pending_reply(
    pending_action_id: str,
    request: PendingReplyRequest,
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

    reply_text = (request.reply_text or pending.action.reply_text or "").strip()
    if not reply_text:
        raise HTTPException(status_code=400, detail="Reply text is required.")

    state.pending_actions = [
        action for action in state.pending_actions if action.id != pending_action_id
    ]
    action = pending.action.model_copy(
        update={
            "reply_text": reply_text,
            "requires_host_confirmation": False,
            "reason": "Host edited concierge reply draft.",
        }
    )
    guardrail = validate_action(action, state)
    applied, ledger_entry = apply_action(action, guardrail, state)
    resolution_entry = LedgerEntry(
        type="host_confirmation_resolved",
        detail="Host sent edited concierge reply draft."
        if guardrail.allowed
        else "Host reply draft failed guardrail validation.",
        source_text=action.source_text,
        payload={
            "pending_action_id": pending_action_id,
            "status": "edited" if guardrail.allowed else "blocked",
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


@app.post("/actions/{pending_action_id}/reply")
def reply_to_pending_action(pending_action_id: str, request: PendingReplyRequest):
    return _send_edited_pending_reply(pending_action_id, request)


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


@app.post(
    "/events/realtime-transcription-token",
    response_model=RealtimeTranscriptionTokenResponse,
)
def realtime_transcription_token():
    try:
        return create_realtime_transcription_token()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


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


@app.post("/media/session/{session_id}/viewer/{viewer_id}")
def join_media_session(session_id: str, viewer_id: str):
    session = media_store.add_viewer(session_id, viewer_id)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.post("/media/session/{session_id}/offer")
def set_media_offer(session_id: str, signal: SignalPayload):
    if signal.viewer_id:
        session = media_store.set_viewer_offer(
            session_id,
            signal.viewer_id,
            signal.payload,
        )
    else:
        session = media_store.set_offer(session_id, signal.payload)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.post("/media/session/{session_id}/answer")
def set_media_answer(session_id: str, signal: SignalPayload):
    if signal.viewer_id:
        session = media_store.set_viewer_answer(
            session_id,
            signal.viewer_id,
            signal.payload,
        )
    else:
        session = media_store.set_answer(session_id, signal.payload)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.post("/media/session/{session_id}/ice-candidate")
def add_media_candidate(session_id: str, signal: SignalPayload):
    session = media_store.add_candidate(
        session_id,
        signal.role,
        signal.payload,
        signal.viewer_id,
    )
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session


@app.delete("/media/session/{session_id}")
def stop_media_session(session_id: str):
    session = media_store.stop_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Media session not found.")
    return session
