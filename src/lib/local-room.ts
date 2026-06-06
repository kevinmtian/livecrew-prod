import {
  type SkuId,
  defaultActiveSkuId,
  resolveSkuById,
} from "@/lib/catalogue";

export type RoomMessage = {
  id: string;
  sender: "viewer" | "host" | "agent";
  name: string;
  text: string;
  createdAt: number;
};

export type LocalRoomState = {
  activeSkuId: SkuId;
  viewerMessages: RoomMessage[];
  replies: RoomMessage[];
  updatedAt: number;
};

const STORAGE_KEY = "livecrew.local-room.v1";
const ROOM_EVENT_NAME = "livecrew:local-room-updated";
const MAX_MESSAGES = 80;

export const defaultLocalRoomState: LocalRoomState = {
  activeSkuId: defaultActiveSkuId,
  viewerMessages: [],
  replies: [],
  updatedAt: 0,
};

function canUseBrowserStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeMessages(value: unknown): RoomMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((message): message is RoomMessage => {
      if (!message || typeof message !== "object") {
        return false;
      }

      const candidate = message as RoomMessage;

      return (
        typeof candidate.id === "string" &&
        typeof candidate.name === "string" &&
        typeof candidate.text === "string" &&
        typeof candidate.createdAt === "number" &&
        ["viewer", "host", "agent"].includes(candidate.sender)
      );
    })
    .slice(-MAX_MESSAGES);
}

export function readLocalRoomState(): LocalRoomState {
  if (!canUseBrowserStorage()) {
    return defaultLocalRoomState;
  }

  const rawState = window.localStorage.getItem(STORAGE_KEY);

  if (!rawState) {
    return defaultLocalRoomState;
  }

  try {
    const parsedState = JSON.parse(rawState) as Partial<LocalRoomState>;
    const activeSku = resolveSkuById(parsedState.activeSkuId);

    return {
      activeSkuId: activeSku?.id ?? defaultActiveSkuId,
      viewerMessages: normalizeMessages(parsedState.viewerMessages),
      replies: normalizeMessages(parsedState.replies),
      updatedAt:
        typeof parsedState.updatedAt === "number" ? parsedState.updatedAt : 0,
    };
  } catch {
    return defaultLocalRoomState;
  }
}

export function writeLocalRoomState(
  updater: (currentState: LocalRoomState) => LocalRoomState,
): LocalRoomState {
  const nextState = {
    ...updater(readLocalRoomState()),
    updatedAt: Date.now(),
  };

  if (!canUseBrowserStorage()) {
    return nextState;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  window.dispatchEvent(new CustomEvent(ROOM_EVENT_NAME, { detail: nextState }));

  return nextState;
}

export function subscribeToLocalRoom(onChange: () => void) {
  if (!canUseBrowserStorage()) {
    return () => {};
  }

  function handleStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) {
      onChange();
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(ROOM_EVENT_NAME, onChange);

  const intervalId = window.setInterval(onChange, 750);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(ROOM_EVENT_NAME, onChange);
    window.clearInterval(intervalId);
  };
}

export function setRoomActiveSku(activeSkuId: SkuId) {
  writeLocalRoomState((currentState) => ({
    ...currentState,
    activeSkuId,
  }));
}

export function appendViewerMessage(text: string, name = "Viewer") {
  const message: RoomMessage = {
    id: createId("viewer-message"),
    sender: "viewer",
    name,
    text,
    createdAt: Date.now(),
  };

  writeLocalRoomState((currentState) => ({
    ...currentState,
    viewerMessages: [...currentState.viewerMessages, message].slice(
      -MAX_MESSAGES,
    ),
  }));

  return message;
}

export function appendHostReply(text: string) {
  const reply: RoomMessage = {
    id: createId("host-reply"),
    sender: "host",
    name: "Host",
    text,
    createdAt: Date.now(),
  };

  writeLocalRoomState((currentState) => ({
    ...currentState,
    replies: [...currentState.replies, reply].slice(-MAX_MESSAGES),
  }));

  return reply;
}

export function appendAgentReply(text: string) {
  const reply: RoomMessage = {
    id: createId("agent-reply"),
    sender: "agent",
    name: "LiveCrew Agent",
    text,
    createdAt: Date.now(),
  };

  writeLocalRoomState((currentState) => ({
    ...currentState,
    replies: [...currentState.replies, reply].slice(-MAX_MESSAGES),
  }));

  return reply;
}

export function resetLocalRoomState() {
  writeLocalRoomState(() => defaultLocalRoomState);
}
