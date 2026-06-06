import json

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from backend.eval.runner import run_agent_suite
from backend.models import (
    AnnouncementRequest,
    FlashSaleRequest,
    HostOverrideRequest,
    HostTranscriptRequest,
    ProposedAction,
    ViewerMessageRequest,
)
from backend.realtime import broadcast, subscribe, unsubscribe
from backend.state import get_state
from backend.workflow import (
    approve_action,
    generate_producer_report,
    handle_direct_action,
    handle_host_transcript,
    handle_viewer_message,
    reject_action,
    reset_workflow,
    state_response,
)


app = FastAPI(title="LiveCrew Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"ok": True, "service": "livecrew-backend"}


@app.get("/state")
def state():
    return get_state()


@app.post("/reset")
async def reset():
    response = reset_workflow()
    await broadcast("reset", response)
    return response


@app.post("/events/host-transcript")
async def host_transcript(request: HostTranscriptRequest):
    response = handle_host_transcript(request.text)
    await broadcast("host_transcript", response)
    return response


@app.post("/events/viewer-message")
async def viewer_message(request: ViewerMessageRequest):
    response = handle_viewer_message(request.text, request.viewer)
    await broadcast("viewer_message", response)
    return response


@app.post("/commerce/flash-sale")
async def create_flash_sale(request: FlashSaleRequest):
    action = ProposedAction(
        type="create_flash_sale",
        sku_id=request.sku_id or get_state().active_sku_id,
        sale_price_cents=request.sale_price_cents,
        duration_seconds=request.duration_seconds,
        stock_limit=request.stock_limit,
        source_text="Host UI flash-sale action",
        confidence=0.95,
        reason="Host created flash sale from UI controls.",
    )
    response = handle_direct_action(action, actor="host")
    await broadcast("create_flash_sale", response)
    return response


@app.post("/commerce/announcement")
async def create_announcement(request: AnnouncementRequest):
    action = ProposedAction(
        type="add_announcement",
        sku_id=get_state().active_sku_id,
        announcement_text=request.text,
        source_text=request.text,
        confidence=0.95,
        reason="Host created announcement from UI controls.",
    )
    response = handle_direct_action(action, actor="host")
    await broadcast("announcement_created", response)
    return response


@app.post("/actions/{pending_action_id}/approve")
async def approve(pending_action_id: str):
    try:
        response = approve_action(pending_action_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error))
    await broadcast("host_confirmation_resolved", response)
    return response


@app.post("/actions/{pending_action_id}/reject")
async def reject(pending_action_id: str):
    try:
        response = reject_action(pending_action_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error))
    await broadcast("host_confirmation_resolved", response)
    return response


@app.post("/actions/host-override")
async def host_override(request: HostOverrideRequest):
    response = handle_direct_action(request.action, actor="host")
    await broadcast("host_override", response)
    return response


@app.get("/report")
async def report():
    response = generate_producer_report()
    await broadcast("report_generated", response)
    return response


@app.post("/eval/run-agent-suite")
def eval_suite():
    return run_agent_suite()


@app.get("/events/stream")
async def events_stream():
    queue = await subscribe()

    async def event_generator():
        try:
            while True:
                event = await queue.get()
                yield "data: " + json.dumps(event) + "\n\n"
        finally:
            unsubscribe(queue)

    return StreamingResponse(event_generator(), media_type="text/event-stream")
