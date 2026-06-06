"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  type BackendCommerceState,
  type BackendLedgerEntry,
  backendBaseUrl,
  cents,
  getBackendState,
  sendViewerMessage,
} from "@/lib/backend-client";
import { type FormEvent, useEffect, useMemo, useState } from "react";

type RoomReply = {
  id: string;
  sender: "Viewer" | "LiveCrew Agent" | "System";
  message: string;
  tone: "viewer" | "agent" | "system";
};

type BackendStreamPayload = {
  state: BackendCommerceState;
  ledger_entries?: BackendLedgerEntry[];
};

function findSku(state: BackendCommerceState | null, skuId: string | null) {
  return state?.skus.find((sku) => sku.id === skuId) ?? null;
}

function hostApprovedReply(entry: BackendLedgerEntry) {
  if (entry.type !== "answer_suggested" || entry.actor !== "host") {
    return null;
  }
  const replyText = entry.payload.reply_text;
  return typeof replyText === "string" && replyText.trim()
    ? replyText
    : entry.message;
}

export default function ViewerPage() {
  const [state, setState] = useState<BackendCommerceState | null>(null);
  const [messageInput, setMessageInput] = useState(
    "How big is this one?",
  );
  const [replies, setReplies] = useState<RoomReply[]>([]);
  const [status, setStatus] = useState<"connected" | "offline" | "working">(
    "working",
  );

  const activeSku = useMemo(
    () => findSku(state, state?.active_sku_id ?? null),
    [state],
  );

  useEffect(() => {
    void getBackendState()
      .then((nextState) => {
        setState(nextState);
        setStatus("connected");
      })
      .catch(() => {
        setStatus("offline");
      });
    const events = new EventSource(`${backendBaseUrl}/events/stream`);
    events.onmessage = (event) => {
      const payload = JSON.parse(event.data) as BackendStreamPayload;
      setState(payload.state);
      const approvedReplies: RoomReply[] = [];
      for (const entry of payload.ledger_entries ?? []) {
        const message = hostApprovedReply(entry);
        if (message) {
          approvedReplies.push({
            id: entry.id,
            sender: "LiveCrew Agent" as const,
            message,
            tone: "agent" as const,
          });
        }
      }
      if (approvedReplies.length) {
        setReplies((current) => {
          const existingIds = new Set(current.map((reply) => reply.id));
          const newReplies = approvedReplies.filter(
            (reply) => !existingIds.has(reply.id),
          );
          return [...newReplies, ...current].slice(0, 30);
        });
      }
      setStatus("connected");
    };
    events.onerror = () => {
      events.close();
    };
    return () => events.close();
  }, []);

  async function handleSubmitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = messageInput.trim();
    if (!text) {
      return;
    }

    setStatus("working");
    setReplies((current) => [
      {
        id: `viewer-${Date.now()}`,
        sender: "Viewer",
        message: text,
        tone: "viewer",
      },
      ...current,
    ]);

    try {
      const response = await sendViewerMessage(text, "viewer_demo");
      setState(response.state);
      const agentMessages: RoomReply[] = [];
      if (response.suggested_reply) {
        agentMessages.push({
          id: `agent-${Date.now()}`,
          sender: "LiveCrew Agent",
          message: response.suggested_reply,
          tone: "agent",
        });
      }
      for (const pending of response.pending_actions) {
        agentMessages.push({
          id: pending.id,
          sender: "System",
          message: `Host confirmation needed: ${pending.guardrail_result.message}`,
          tone: "system",
        });
      }
      for (const applied of response.applied_actions.filter(
        (action) => action.type === "create_order",
      )) {
        agentMessages.push({
          id: `order-${Date.now()}-${applied.sku_id}`,
          sender: "System",
          message: applied.message,
          tone: "system",
        });
      }
      setReplies((current) => [...agentMessages, ...current].slice(0, 30));
      setMessageInput("");
      setStatus("connected");
    } catch {
      setStatus("offline");
      setReplies((current) => [
        {
          id: `offline-${Date.now()}`,
          sender: "System",
          message: "Backend is not available. Start the FastAPI server to process viewer messages.",
          tone: "system",
        },
        ...current,
      ]);
    }
  }

  return (
    <AppShell
      eyebrow="Viewer"
      title="Customer livestream room"
      description="Viewer-facing product context and chat powered by backend SKU, price, stock, promo, and order state."
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <StatusPill
          tone={
            status === "connected"
              ? "good"
              : status === "working"
                ? "neutral"
                : "warning"
          }
        >
          {status}
        </StatusPill>
        <StatusPill>{backendBaseUrl}</StatusPill>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <Panel title="Active Product" eyebrow="Pinned by host">
          {activeSku ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">
                    {activeSku.name}
                  </h2>
                  <p className="mt-2 text-2xl font-semibold text-teal-800">
                    {cents(activeSku.current_price_cents)}
                  </p>
                </div>
                <StatusPill tone="good">{activeSku.stock} left</StatusPill>
              </div>
              <ul className="mt-5 space-y-2 text-sm leading-6 text-slate-700">
                {activeSku.facts.map((fact) => (
                  <li key={fact}>- {fact}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              The host has not pinned a product yet.
            </p>
          )}

          {state?.flash_sale ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-semibold text-amber-900">
                  Limited-time offer
                </p>
                <StatusPill tone={state.flash_sale.active ? "warning" : "neutral"}>
                  {state.flash_sale.active ? "active" : "inactive"}
                </StatusPill>
              </div>
              <p className="mt-2 text-sm leading-6 text-amber-800">
                {cents(state.flash_sale.sale_price_cents)} ·{" "}
                {state.flash_sale.remaining_stock}/
                {state.flash_sale.starting_stock} promo units left
              </p>
            </div>
          ) : null}
        </Panel>

        <div className="grid gap-4">
          <Panel title="Viewer Chat" eyebrow="Concierge workflow">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={handleSubmitMessage}
            >
              <label className="sr-only" htmlFor="viewer-message">
                Viewer message
              </label>
              <input
                className="min-h-11 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                id="viewer-message"
                onChange={(event) => setMessageInput(event.target.value)}
                placeholder="Ask about the active product or order naturally"
                value={messageInput}
              />
              <button
                className="min-h-11 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
                type="submit"
              >
                Send
              </button>
            </form>
            <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">
              {replies.length ? (
                replies.map((reply) => (
                  <div
                    className={`rounded-md border p-3 ${
                      reply.tone === "agent"
                        ? "border-teal-200 bg-teal-50"
                        : reply.tone === "system"
                          ? "border-amber-200 bg-amber-50"
                          : "border-slate-200 bg-slate-50"
                    }`}
                    key={reply.id}
                  >
                    <p
                      className={`text-xs font-semibold ${
                        reply.tone === "agent"
                          ? "text-teal-700"
                          : reply.tone === "system"
                            ? "text-amber-700"
                            : "text-slate-500"
                      }`}
                    >
                      {reply.sender}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-slate-800">
                      {reply.message}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm leading-6 text-slate-600">
                  Ask a product question, request a promo, or try “get me two of it”.
                </p>
              )}
            </div>
          </Panel>

          <Panel title="Recent Orders" eyebrow="Backend state">
            <div className="space-y-2">
              {[...(state?.orders ?? [])].reverse().slice(0, 5).map((order) => {
                const sku = findSku(state, order.sku_id);
                return (
                  <div
                    className="rounded-md border border-slate-200 bg-slate-50 p-3"
                    key={order.id}
                  >
                    <p className="text-sm font-semibold text-slate-900">
                      {order.quantity} x {sku?.name ?? order.sku_id}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {cents(order.total_price_cents)}
                      {order.used_flash_sale ? " · flash-sale price" : ""}
                    </p>
                  </div>
                );
              })}
              {state?.orders.length ? null : (
                <p className="text-sm leading-6 text-slate-600">
                  No orders recorded yet.
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
