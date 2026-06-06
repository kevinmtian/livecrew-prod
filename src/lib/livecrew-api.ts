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
  quantity: number | null;
  source_text: string;
  input_source: string;
  price_cents: number | null;
  stock: number | null;
  sale_price_cents: number | null;
  duration_seconds: number | null;
  stock_limit: number | null;
  reply_text: string | null;
  viewer: string | null;
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
  requested_by: string;
  status: "pending" | "approved" | "rejected" | "overridden";
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
  viewer_sessions: ViewerSession[];
  orders: Array<{
    id: string;
    sku_id: string;
    quantity: number;
    unit_price_cents: number;
    viewer: string;
    created_at: string;
  }>;
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

export type ViewerSession = {
  id: string;
  username: string;
  created_at: string;
};

export type ViewerLoginResponse = {
  session: ViewerSession;
  state: BackendState;
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
  suggested_reply: string | null;
  state: BackendState;
};

export type MonitorSignalPayload = {
  online_viewers: number;
  online_viewers_delta: number;
  gpm_cents: number;
  gpm_delta: number;
  conversion_rate: number;
  conversion_rate_delta: number;
  comment_sentiment: number;
  interaction_rate: number;
};

export type MonitorResponse = {
  agent: "MonitorAgent";
  scenario: {
    id: "hesitation" | "spike_push" | "warm_retention" | "cold_warning" | "steady";
    label: string;
    reason: string;
    urgency: "low" | "medium" | "high";
  };
  hook: {
    id: "suspense" | "order_push" | "benefit" | "interaction";
    label: string;
    script: string;
  };
  signals: Record<string, string>;
  created_at: string;
};

export type MediaSession = {
  session_id: string;
  status: "waiting" | "offer_ready" | "answer_ready" | "live" | "stopped";
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
  host_candidates: RTCIceCandidateInit[];
  viewer_candidates: RTCIceCandidateInit[];
  viewer_offers: Record<string, RTCSessionDescriptionInit>;
  viewer_answers: Record<string, RTCSessionDescriptionInit>;
  viewer_host_candidates: Record<string, RTCIceCandidateInit[]>;
  viewer_ice_candidates: Record<string, RTCIceCandidateInit[]>;
  viewer_ids: string[];
};

export type RealtimeTranscriptionToken = {
  value: string;
  expires_at: number | null;
  session_id: string | null;
  model: string;
};

export type RealtimeTranscriptionOfferResponse = {
  answer_sdp: string;
  model: string;
  session_id: string | null;
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

export function sendViewerMessage(text: string, viewer = "viewer") {
  return requestJson<WorkflowResponse>("/events/viewer-message", {
    method: "POST",
    body: JSON.stringify({ text, viewer }),
  });
}

export function loginViewer(username: string) {
  return requestJson<ViewerLoginResponse>("/viewer-login", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export function fetchViewerLogin(sessionId: string) {
  return requestJson<ViewerLoginResponse>(`/viewer-login/${sessionId}`);
}

export function logoutViewer(sessionId: string) {
  return requestJson<ViewerLoginResponse>(`/viewer-login/${sessionId}/logout`, {
    method: "POST",
  });
}

export function sendEditedPendingReply(pendingActionId: string, replyText: string) {
  return requestJson<WorkflowResponse>(`/actions/${pendingActionId}/reply`, {
    method: "POST",
    body: JSON.stringify({ reply_text: replyText }),
  });
}

export function createRealtimeTranscriptionToken() {
  return requestJson<RealtimeTranscriptionToken>("/events/realtime-transcription-token", {
    method: "POST",
  });
}

export function exchangeRealtimeTranscriptionOffer(sdp: string) {
  return requestJson<RealtimeTranscriptionOfferResponse>(
    "/events/realtime-transcription-offer",
    {
      method: "POST",
      body: JSON.stringify({ sdp }),
    },
  );
}

export function approvePendingAction(pendingActionId: string) {
  return requestJson<WorkflowResponse>(`/actions/${pendingActionId}/approve`, {
    method: "POST",
  });
}

export function sendMonitorSignal(payload: MonitorSignalPayload) {
  return requestJson<MonitorResponse>("/events/monitor-signal", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function transcribeAudio(blob: Blob) {
  const formData = new FormData();
  formData.append("file", blob, "host-audio.webm");

  const response = await fetch(`${getBackendUrl()}/events/transcribe-audio`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Transcription failed with ${response.status}`);
  }

  return response.json() as Promise<{ text: string; source: string }>;
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

export function joinMediaSession(sessionId: string, viewerId: string) {
  return requestJson<MediaSession>(
    `/media/session/${sessionId}/viewer/${viewerId}`,
    {
      method: "POST",
    },
  );
}

export function fetchLatestMediaSession() {
  return requestJson<MediaSession>("/media/session/latest");
}

export function postMediaOffer(
  sessionId: string,
  offer: RTCSessionDescriptionInit,
  viewerId?: string,
) {
  return requestJson<MediaSession>(`/media/session/${sessionId}/offer`, {
    method: "POST",
    body: JSON.stringify({ role: "host", payload: offer, viewer_id: viewerId }),
  });
}

export function postMediaAnswer(
  sessionId: string,
  answer: RTCSessionDescriptionInit,
  viewerId?: string,
) {
  return requestJson<MediaSession>(`/media/session/${sessionId}/answer`, {
    method: "POST",
    body: JSON.stringify({ role: "viewer", payload: answer, viewer_id: viewerId }),
  });
}

export function postIceCandidate(
  sessionId: string,
  role: "host" | "viewer",
  candidate: RTCIceCandidateInit,
  viewerId?: string,
) {
  return requestJson<MediaSession>(`/media/session/${sessionId}/ice-candidate`, {
    method: "POST",
    body: JSON.stringify({ role, payload: candidate, viewer_id: viewerId }),
  });
}

export function stopMediaSession(sessionId: string) {
  return requestJson<MediaSession>(`/media/session/${sessionId}`, {
    method: "DELETE",
  });
}
