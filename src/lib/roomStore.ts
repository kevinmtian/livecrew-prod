import { activeSkuId } from "@/lib/catalogue";
import {
  dedupeById,
  mergeViewerMessages,
  type RoomEvent,
  type RoomState,
} from "@/lib/roomChannel";

const defaultRoomState: RoomState = {
  activeSkuId,
  viewerMessages: [],
  hostReplies: [],
};

type RoomGlobal = typeof globalThis & {
  __livecrewRoomState?: RoomState;
};

export function getRoomState() {
  const roomGlobal = globalThis as RoomGlobal;

  if (!roomGlobal.__livecrewRoomState) {
    roomGlobal.__livecrewRoomState = defaultRoomState;
  }

  return roomGlobal.__livecrewRoomState;
}

export function applyRoomEvent(event: RoomEvent) {
  const roomGlobal = globalThis as RoomGlobal;
  const currentState = getRoomState();

  if (event.type === "viewer-message") {
    roomGlobal.__livecrewRoomState = {
      ...currentState,
      viewerMessages: mergeViewerMessages(currentState.viewerMessages, [
        event.message,
      ]),
    };
    return;
  }

  if (event.type === "host-reply") {
    roomGlobal.__livecrewRoomState = {
      ...currentState,
      hostReplies: dedupeById([...currentState.hostReplies, event.reply]),
    };
    return;
  }

  if (event.type === "active-sku") {
    roomGlobal.__livecrewRoomState = {
      ...currentState,
      activeSkuId: event.skuId,
    };
    return;
  }

  roomGlobal.__livecrewRoomState = defaultRoomState;
}
