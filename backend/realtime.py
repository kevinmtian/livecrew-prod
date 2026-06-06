import asyncio
from typing import Set

from backend.models import WorkflowResponse


_subscribers: Set[asyncio.Queue] = set()
_sequence = 0


async def subscribe() -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=20)
    _subscribers.add(queue)
    return queue


def unsubscribe(queue: asyncio.Queue) -> None:
    _subscribers.discard(queue)


async def broadcast(event_type: str, response: WorkflowResponse) -> None:
    global _sequence
    _sequence += 1
    payload = {
        "sequence": _sequence,
        "type": event_type,
        "state": response.state.model_dump(mode="json"),
        "decisions": [decision.model_dump(mode="json") for decision in response.agent_decisions],
        "ledger_entries": [entry.model_dump(mode="json") for entry in response.ledger_entries],
    }
    stale = []
    for queue in _subscribers:
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            stale.append(queue)
    for queue in stale:
        unsubscribe(queue)
