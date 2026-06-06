import { activeSkuId } from "@/lib/catalogue";

export type RoomViewerMessage = {
  id: string;
  user: string;
  text: string;
  intent?: string;
  priority?: "High" | "Medium" | "Low" | "Live";
  createdAt?: number;
};

export type RoomHostReply = {
  id: string;
  source: "Host" | "Agent";
  text: string;
};

export type RoomState = {
  activeSkuId: string;
  viewerMessages: RoomViewerMessage[];
  hostReplies: RoomHostReply[];
};

export type RoomEvent =
  | {
      type: "viewer-message";
      message: RoomViewerMessage;
    }
  | {
      type: "host-reply";
      reply: RoomHostReply;
    }
  | {
      type: "active-sku";
      skuId: string;
    }
  | {
      type: "reset-room";
    };

const channelName = "livecrew-local-room";
const stateKey = "livecrew-local-room-state";
const eventKey = "livecrew-local-room-event";

const defaultRoomState: RoomState = {
  activeSkuId,
  viewerMessages: [],
  hostReplies: [],
};

const priorityRank = {
  High: 0,
  Medium: 1,
  Low: 2,
  Live: 3,
};

function canUseBrowserStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function dedupeById<T extends { id: string }>(items: T[]) {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

export function createViewerMessageId() {
  return `viewer-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createRoomTimestamp() {
  return Date.now();
}

export function classifyViewerPriority(
  text: string,
  priority?: RoomViewerMessage["priority"],
) {
  if (priority && priority in priorityRank) {
    return priority;
  }

  const normalizedText = text.toLowerCase();
  const highIntentTerms = [
    "ship",
    "shipping",
    "deliver",
    "delivery",
    "singapore",
    "stock",
    "price",
    "glowfix",
    "spf",
    "product",
  ];

  return highIntentTerms.some((term) => normalizedText.includes(term))
    ? "High"
    : "Live";
}

export function normalizeViewerMessage(message: RoomViewerMessage) {
  return {
    ...message,
    priority: classifyViewerPriority(message.text, message.priority),
    createdAt: message.createdAt ?? 0,
  };
}

export function sortViewerMessages(messages: RoomViewerMessage[]) {
  return [...messages].sort((first, second) => {
    const firstPriority = priorityRank[classifyViewerPriority(first.text, first.priority)];
    const secondPriority = priorityRank[classifyViewerPriority(second.text, second.priority)];

    if (firstPriority !== secondPriority) {
      return firstPriority - secondPriority;
    }

    return (second.createdAt ?? 0) - (first.createdAt ?? 0);
  });
}

export function mergeViewerMessages(
  currentMessages: RoomViewerMessage[],
  incomingMessages: RoomViewerMessage[],
) {
  const mergedMessages = new Map<string, RoomViewerMessage>();

  currentMessages.forEach((message) => {
    mergedMessages.set(message.id, normalizeViewerMessage(message));
  });

  incomingMessages.forEach((message) => {
    mergedMessages.set(message.id, normalizeViewerMessage(message));
  });

  return sortViewerMessages(Array.from(mergedMessages.values()));
}

export function readRoomState(): RoomState {
  if (!canUseBrowserStorage()) {
    return defaultRoomState;
  }

  const storedState = window.localStorage.getItem(stateKey);

  if (!storedState) {
    return defaultRoomState;
  }

  try {
    return {
      ...defaultRoomState,
      ...JSON.parse(storedState),
    };
  } catch {
    return defaultRoomState;
  }
}

function writeRoomState(state: RoomState) {
  if (!canUseBrowserStorage()) {
    return;
  }

  window.localStorage.setItem(stateKey, JSON.stringify(state));
}

function applyEventToState(event: RoomEvent) {
  const currentState = readRoomState();

  if (event.type === "viewer-message") {
    writeRoomState({
      ...currentState,
      viewerMessages: mergeViewerMessages(currentState.viewerMessages, [
        event.message,
      ]),
    });
    return;
  }

  if (event.type === "host-reply") {
    writeRoomState({
      ...currentState,
      hostReplies: dedupeById([...currentState.hostReplies, event.reply]),
    });
    return;
  }

  if (event.type === "active-sku") {
    writeRoomState({
      ...currentState,
      activeSkuId: event.skuId,
    });
    return;
  }

  writeRoomState(defaultRoomState);
}

export function publishRoomEvent(event: RoomEvent) {
  if (!canUseBrowserStorage()) {
    return;
  }

  applyEventToState(event);

  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(event);
    channel.close();
  }

  window.localStorage.setItem(
    eventKey,
    JSON.stringify({
      event,
      emittedAt: Date.now(),
    }),
  );

  void fetch("/api/live/message", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  }).catch(() => {
    // BroadcastChannel/localStorage still carry the demo if the API is unavailable.
  });
}

export async function fetchRoomState() {
  const response = await fetch("/api/live/state", {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Unable to fetch room state");
  }

  return (await response.json()) as RoomState;
}

export function subscribeRoomEvents(onEvent: (event: RoomEvent) => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const channel =
    "BroadcastChannel" in window ? new BroadcastChannel(channelName) : null;

  if (channel) {
    channel.onmessage = (message) => onEvent(message.data as RoomEvent);
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== eventKey || !event.newValue) {
      return;
    }

    try {
      const payload = JSON.parse(event.newValue) as { event: RoomEvent };
      onEvent(payload.event);
    } catch {
      // Ignore malformed local demo events.
    }
  }

  window.addEventListener("storage", onStorage);

  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
  };
}
