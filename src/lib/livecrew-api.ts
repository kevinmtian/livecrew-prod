export type BackendSku = {
  id: string;
  name: string;
  aliases: string[];
  price_cents: number;
  stock: number;
  facts: string[];
  base_price_cents: number | null;
};

export type ProposedAction = {
  type: string;
  sku_id: string | null;
  source_text: string;
  input_source: string;
  price_cents: number | null;
  stock: number | null;
  sale_price_cents: number | null;
  duration_seconds: number | null;
  stock_limit: number | null;
  reply_text: string | null;
  confidence: number;
  reason: string | null;
  evidence: string[];
  requires_host_confirmation: boolean;
};

export type GuardrailResult = {
  action_type: string;
  allowed: boolean;
  status: string;
  reason: string;
};

export type PendingAction = {
  id: string;
  action: ProposedAction;
  guardrail_result: GuardrailResult;
  status: "pending" | "approved" | "rejected" | "overridden";
  created_at: string;
};

export type ViewerComment = {
  id: string;
  viewer: string;
  text: string;
  sku_id: string | null;
  suggested_reply: string | null;
  reply_status: "suggested" | "needs_host" | "blocked" | "none";
  intent: string | null;
  created_at: string;
};

export type WordCloudTerm = {
  text: string;
  weight: number;
  count: number;
};

export type ViewerInsightSnapshot = {
  id: string;
  window_started_at: string;
  window_ended_at: string;
  active_sku_id: string | null;
  comment_count: number;
  terms: WordCloudTerm[];
  summary: string;
  suggested_replies: string[];
  source_comment_ids: string[];
  created_at: string;
};

export type CheckoutIntent = {
  id: string;
  viewer: string;
  sku_id: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
  status: "pending" | "confirmed" | "cancelled";
  created_at: string;
  updated_at: string;
};

export type Order = {
  id: string;
  viewer: string;
  sku_id: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
  checkout_intent_id: string | null;
  created_at: string;
};

export type BackendState = {
  active_sku_id: string | null;
  skus: BackendSku[];
  flash_sale: {
    sku_id: string;
    sale_price_cents: number;
    stock_limit: number;
    remaining_stock: number;
    duration_seconds: number;
    created_at: string;
  } | null;
  viewer_comments: ViewerComment[];
  viewer_insights: ViewerInsightSnapshot[];
  checkout_intents: CheckoutIntent[];
  orders: Order[];
  pending_actions: PendingAction[];
  ledger: Array<{
    id: string;
    type: string;
    detail: string;
    source_text: string | null;
    payload?: Record<string, unknown>;
    created_at: string;
  }>;
  updated_at: string;
};

export type WorkflowResponse = {
  agent_decisions: Array<{
    id: string;
    agent: string;
    summary: string;
    confidence: number;
    source_text: string;
    created_at: string;
  }>;
  proposed_actions: ProposedAction[];
  guardrail_results: GuardrailResult[];
  pending_actions: PendingAction[];
  applied_actions: Array<{
    type: string;
    sku_id: string | null;
    detail: string;
  }>;
  ledger_entries: BackendState["ledger"];
  state: BackendState;
};

export type MediaSession = {
  session_id: string;
  status: "waiting" | "offer_ready" | "answer_ready" | "live" | "stopped";
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  host_candidates: RTCIceCandidateInit[];
  viewer_candidates: RTCIceCandidateInit[];
};

export type CheckoutIntentResponse = {
  checkout_intent: CheckoutIntent;
  state: BackendState;
};

export type OrderResponse = {
  order: Order;
  state: BackendState;
};

const DEFAULT_BACKEND_URL = "http://localhost:8000";

export function getBackendUrl() {
  return process.env.NEXT_PUBLIC_BACKEND_URL ?? DEFAULT_BACKEND_URL;
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${getBackendUrl()}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Backend request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchBackendState() {
  return requestJson<BackendState>("/state");
}

export function resetBackendState() {
  return requestJson<BackendState>("/reset", { method: "POST" });
}

export function sendHostCommand(text: string) {
  return requestJson<WorkflowResponse>("/events/host-command", {
    method: "POST",
    body: JSON.stringify({ text, source: "typed_command" }),
  });
}

export function sendHostTranscript(text: string) {
  return requestJson<WorkflowResponse>("/events/host-transcript", {
    method: "POST",
    body: JSON.stringify({ text, source: "speech_transcript" }),
  });
}

export function sendViewerMessage(text: string, viewer = "You") {
  return requestJson<WorkflowResponse>("/events/viewer-message", {
    method: "POST",
    body: JSON.stringify({ text, viewer }),
  });
}

export function generateViewerWordCloud(windowSeconds = 180) {
  return requestJson<ViewerInsightSnapshot>("/viewer-insights/word-cloud", {
    method: "POST",
    body: JSON.stringify({ window_seconds: windowSeconds }),
  });
}

export function startCheckoutIntent(
  skuId: string,
  quantity: number,
  viewer = "You",
) {
  return requestJson<CheckoutIntentResponse>("/checkout-intents", {
    method: "POST",
    body: JSON.stringify({ sku_id: skuId, quantity, viewer }),
  });
}

export function confirmCheckoutIntent(checkoutIntentId: string) {
  return requestJson<OrderResponse>(
    `/checkout-intents/${checkoutIntentId}/confirm`,
    {
      method: "POST",
    },
  );
}

export function cancelCheckoutIntent(checkoutIntentId: string) {
  return requestJson<CheckoutIntentResponse>(
    `/checkout-intents/${checkoutIntentId}/cancel`,
    {
      method: "POST",
    },
  );
}

export function approvePendingAction(pendingActionId: string) {
  return requestJson<WorkflowResponse>(`/actions/${pendingActionId}/approve`, {
    method: "POST",
  });
}

export function rejectPendingAction(pendingActionId: string) {
  return requestJson<WorkflowResponse>(`/actions/${pendingActionId}/reject`, {
    method: "POST",
  });
}

export function createMediaSession() {
  return requestJson<{ session_id: string }>("/media/session", { method: "POST" });
}

export function fetchMediaSession(sessionId: string) {
  return requestJson<MediaSession>(`/media/session/${sessionId}`);
}

export function fetchLatestMediaSession() {
  return requestJson<MediaSession>("/media/session/latest");
}

export function postMediaOffer(sessionId: string, offer: RTCSessionDescriptionInit) {
  return requestJson<MediaSession>(`/media/session/${sessionId}/offer`, {
    method: "POST",
    body: JSON.stringify({ role: "host", payload: offer }),
  });
}

export function postMediaAnswer(sessionId: string, answer: RTCSessionDescriptionInit) {
  return requestJson<MediaSession>(`/media/session/${sessionId}/answer`, {
    method: "POST",
    body: JSON.stringify({ role: "viewer", payload: answer }),
  });
}

export function postIceCandidate(
  sessionId: string,
  role: "host" | "viewer",
  candidate: RTCIceCandidateInit,
) {
  return requestJson<MediaSession>(`/media/session/${sessionId}/ice-candidate`, {
    method: "POST",
    body: JSON.stringify({ role, payload: candidate }),
  });
}

export function stopMediaSession(sessionId: string) {
  return requestJson<MediaSession>(`/media/session/${sessionId}`, {
    method: "DELETE",
  });
}
