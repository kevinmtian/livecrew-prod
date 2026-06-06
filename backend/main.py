from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from backend.agents.concierge import analyze_viewer_message
from backend.agents.viewer_insights import generate_viewer_word_cloud
from backend.commerce import (
    apply_action,
    approve_pending_action,
    cancel_checkout_intent,
    confirm_checkout_intent,
    create_checkout_intent,
    reject_pending_action,
)
from backend.graphs.livecrew_graph import run_cohost_workflow
from backend.media_signaling import media_store
from backend.models import (
    CheckoutIntentRequest,
    CheckoutIntentResponse,
    LedgerEntry,
    OrderResponse,
    SessionCreateResponse,
    SignalPayload,
    TextEventRequest,
    TranscriptionResponse,
    ViewerComment,
    ViewerInsightRequest,
    ViewerInsightSnapshot,
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


@app.post("/events/viewer-message", response_model=WorkflowResponse)
def viewer_message(request: ViewerMessageRequest):
    text = request.text.strip()
    viewer = request.viewer.strip() or "viewer"
    if not text:
        raise HTTPException(status_code=400, detail="Viewer message is required.")

    state = commerce_store.get()
    decision, proposed_actions, intent = analyze_viewer_message(text, viewer, state)
    guardrail_results = [validate_action(action, state) for action in proposed_actions]
    viewer_comment = ViewerComment(
        viewer=viewer,
        text=text,
        sku_id=proposed_actions[0].sku_id if proposed_actions else None,
        suggested_reply=proposed_actions[0].reply_text if proposed_actions else None,
        intent=intent,
    )

    applied_actions = []
    ledger_entries = [
        LedgerEntry(
            type="viewer_message_received",
            detail=f"{viewer} commented: {text}",
            source_text=text,
            payload={
                "viewer": viewer,
                "comment_id": viewer_comment.id,
                "sku_id": viewer_comment.sku_id,
                "intent": intent,
            },
        )
    ]

    for action, guardrail in zip(proposed_actions, guardrail_results, strict=False):
        applied, ledger_entry = apply_action(action, guardrail, state)
        if applied:
            applied_actions.append(applied)
        ledger_entries.append(ledger_entry)

        if action.type == "suggest_reply":
            viewer_comment.suggested_reply = action.reply_text
            if guardrail.status == "allowed":
                viewer_comment.reply_status = "suggested"
            elif guardrail.status == "needs_host_confirmation":
                viewer_comment.reply_status = "needs_host"
            else:
                viewer_comment.reply_status = "blocked"

    state.viewer_comments = [viewer_comment, *state.viewer_comments][:200]
    state.ledger = [*ledger_entries, *state.ledger][:200]
    updated_state = commerce_store.replace(state)

    return WorkflowResponse(
        agent_decisions=[decision],
        proposed_actions=proposed_actions,
        guardrail_results=guardrail_results,
        pending_actions=updated_state.pending_actions,
        applied_actions=applied_actions,
        ledger_entries=ledger_entries,
        state=updated_state,
    )


@app.post("/viewer-insights/word-cloud", response_model=ViewerInsightSnapshot)
def viewer_word_cloud(request: ViewerInsightRequest):
    state = commerce_store.get()
    snapshot = generate_viewer_word_cloud(state, request.window_seconds)
    state.viewer_insights = [snapshot, *state.viewer_insights][:10]
    state.ledger = [
        LedgerEntry(
            type="viewer_word_cloud_generated",
            detail=f"Generated viewer word cloud from {snapshot.comment_count} recent comment(s).",
            payload={
                "snapshot_id": snapshot.id,
                "window_seconds": request.window_seconds,
                "comment_count": snapshot.comment_count,
                "terms": [term.model_dump(mode="json") for term in snapshot.terms],
            },
        ),
        *state.ledger,
    ][:200]
    commerce_store.replace(state)
    return snapshot


@app.post("/checkout-intents", response_model=CheckoutIntentResponse)
def start_checkout(request: CheckoutIntentRequest):
    viewer = request.viewer.strip() or "viewer"
    state = commerce_store.get()
    try:
        intent, ledger_entry = create_checkout_intent(
            state,
            viewer=viewer,
            sku_id=request.sku_id,
            quantity=request.quantity,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    state.ledger = [ledger_entry, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return CheckoutIntentResponse(checkout_intent=intent, state=updated_state)


@app.post("/checkout-intents/{checkout_intent_id}/confirm", response_model=OrderResponse)
def confirm_checkout(checkout_intent_id: str):
    state = commerce_store.get()
    try:
        order, ledger_entries = confirm_checkout_intent(state, checkout_intent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    state.ledger = [*ledger_entries, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return OrderResponse(order=order, state=updated_state)


@app.post(
    "/checkout-intents/{checkout_intent_id}/cancel",
    response_model=CheckoutIntentResponse,
)
def cancel_checkout(checkout_intent_id: str):
    state = commerce_store.get()
    try:
        intent, ledger_entry = cancel_checkout_intent(state, checkout_intent_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    state.ledger = [ledger_entry, *state.ledger][:200]
    updated_state = commerce_store.replace(state)
    return CheckoutIntentResponse(checkout_intent=intent, state=updated_state)


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
