export type BackendSku = {
  id: string;
  name: string;
  aliases: string[];
  base_price_cents: number;
  current_price_cents: number;
  stock: number;
  facts: string[];
};

export type BackendFlashSale = {
  sku_id: string;
  original_price_cents: number;
  sale_price_cents: number;
  starting_stock: number;
  remaining_stock: number;
  starts_at: string;
  ends_at: string;
  active: boolean;
};

export type BackendOrder = {
  id: string;
  viewer: string;
  sku_id: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
  used_flash_sale: boolean;
  created_at: string;
};

export type BackendLedgerEntry = {
  id: string;
  type: string;
  actor: string;
  sku_id: string | null;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type BackendProposedAction = {
  type: string;
  sku_id: string | null;
  quantity: number | null;
  price_cents: number | null;
  sale_price_cents: number | null;
  duration_seconds: number | null;
  stock_limit: number | null;
  reply_text: string | null;
  announcement_text: string | null;
  source_text: string;
  confidence: number;
  reason: string | null;
  evidence: string[];
  requires_host_confirmation: boolean;
};

export type BackendPendingAction = {
  id: string;
  action: BackendProposedAction;
  guardrail_result: {
    decision: "allow" | "block" | "confirm";
    risk_level: "low" | "medium" | "high";
    message: string;
    reasons: string[];
  };
  requested_by: string;
  status: "pending" | "approved" | "rejected" | "overridden";
  created_at: string;
  resolved_at: string | null;
};

export type BackendCommerceState = {
  active_sku_id: string | null;
  skus: BackendSku[];
  flash_sale: BackendFlashSale | null;
  orders: BackendOrder[];
  announcements: Array<{ id: string; text: string; created_at: string }>;
  pending_actions: BackendPendingAction[];
  ledger: BackendLedgerEntry[];
  metrics: {
    total_units_sold: number;
    total_gmv_cents: number;
    questions_handled: number;
    risk_events: number;
  };
};

export type BackendReport = {
  listed_sku_ids: string[];
  total_units_sold: number;
  total_gmv_cents: number;
  per_product: Array<{
    sku_id: string;
    name: string;
    units_sold: number;
    gmv_cents: number;
    gmv: string;
  }>;
  flash_sale: Record<string, unknown> | null;
  questions_handled: number;
  risk_events: number;
  host_learning: string[];
  next_recommendations: string[];
};

export type BackendWorkflowResponse = {
  proposed_actions: BackendProposedAction[];
  pending_actions: BackendPendingAction[];
  applied_actions: Array<{ type: string; sku_id: string | null; message: string }>;
  ledger_entries: BackendLedgerEntry[];
  suggested_reply: string | null;
  report: BackendReport | null;
  state: BackendCommerceState;
};

export type EvalSuiteResult = {
  categories: Array<{
    category: string;
    passed: number;
    total: number;
    pass_rate: number;
  }>;
  results: Array<{
    id: string;
    category: string;
    input: string;
    expected: string;
    actual: string;
    passed: boolean;
    failure_reason: string;
  }>;
};

export const backendBaseUrl =
  process.env.NEXT_PUBLIC_LIVECREW_BACKEND_URL ?? "http://127.0.0.1:8000";

export function cents(centsValue: number) {
  return `$${(centsValue / 100).toFixed(2)}`;
}

async function requestBackend<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${backendBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Backend request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getBackendState() {
  return requestBackend<BackendCommerceState>("/state");
}

export function resetBackend() {
  return requestBackend<BackendWorkflowResponse>("/reset", { method: "POST" });
}

export function sendHostTranscript(text: string) {
  return requestBackend<BackendWorkflowResponse>("/events/host-transcript", {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export function sendViewerMessage(text: string, viewer: string) {
  return requestBackend<BackendWorkflowResponse>("/events/viewer-message", {
    method: "POST",
    body: JSON.stringify({ text, viewer }),
  });
}

export function approvePendingAction(id: string) {
  return requestBackend<BackendWorkflowResponse>(`/actions/${id}/approve`, {
    method: "POST",
  });
}

export function approvePendingActionWithEdit(id: string, replyText: string) {
  return requestBackend<BackendWorkflowResponse>(`/actions/${id}/approve-edited`, {
    method: "POST",
    body: JSON.stringify({ reply_text: replyText }),
  });
}

export function rejectPendingAction(id: string) {
  return requestBackend<BackendWorkflowResponse>(`/actions/${id}/reject`, {
    method: "POST",
  });
}

export function generateReport() {
  return requestBackend<BackendWorkflowResponse>("/report");
}

export function runEvalSuite() {
  return fetch("/api/eval/run-agent-suite", {
    method: "POST",
  }).then(async (response) => {
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "Evaluation suite failed.");
    }

    return response.json() as Promise<EvalSuiteResult>;
  });
}
