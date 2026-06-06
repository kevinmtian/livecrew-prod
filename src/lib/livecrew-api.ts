export type BackendSku = {
  id: string;
  name: string;
  aliases: string[];
  price_cents: number;
  stock: number;
  facts: string[];
  base_price_cents: number | null;
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
  ledger: Array<{
    id: string;
    type: string;
    detail: string;
    source_text: string | null;
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
  proposed_actions: Array<{
    type: string;
    sku_id: string | null;
    source_text: string;
    input_source: string;
    confidence: number;
    reason: string | null;
    evidence: string[];
  }>;
  guardrail_results: Array<{
    action_type: string;
    allowed: boolean;
    status: string;
    reason: string;
  }>;
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
