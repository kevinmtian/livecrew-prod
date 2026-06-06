"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  type BackendCommerceState,
  fetchBackendState,
  formatMoney,
  getBackendActiveSkuId,
} from "@/lib/backend-commerce";
import { defaultActiveSkuId, getActiveSkuDisplay } from "@/lib/catalogue";
import {
  appendViewerMessage,
  defaultLocalRoomState,
  type LocalRoomState,
  readLocalRoomState,
  subscribeToLocalRoom,
} from "@/lib/local-room";
import { mockChat } from "@/lib/mock-data";
import { type FormEvent, useEffect, useState } from "react";

type RoomReply = {
  id: string;
  sender: "Host" | "LiveCrew Agent";
  message: string;
  tone: "host" | "agent";
};

const initialReplies: RoomReply[] = [
  {
    id: "reply-host-001",
    sender: "Host",
    message:
      "We are featuring GlowFix first. I will keep the product card updated as we move through the shelf.",
    tone: "host",
  },
  {
    id: "reply-agent-001",
    sender: "LiveCrew Agent",
    message:
      "GlowFix Vitamin C Serum is a 30 ml brightening serum designed for morning skincare routines.",
    tone: "agent",
  },
  {
    id: "reply-agent-002",
    sender: "LiveCrew Agent",
    message:
      "Unverified discounts need host confirmation before they are shared in chat.",
    tone: "agent",
  },
];

const flashSale = {
  sold: 12,
  total: 20,
  secondsLeft: 90,
};

export default function ViewerPage() {
  const [roomState, setRoomState] =
    useState<LocalRoomState>(defaultLocalRoomState);
  const [backendState, setBackendState] = useState<BackendCommerceState | null>(
    null,
  );
  const [backendError, setBackendError] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const backendActiveSkuId = getBackendActiveSkuId(backendState);
  const activeProduct = getActiveSkuDisplay(
    backendActiveSkuId ?? roomState.activeSkuId ?? defaultActiveSkuId,
  );
  const activeBackendSku = backendState?.skus[activeProduct.id];
  const activeFlashSale =
    backendState?.flash_sale?.sku_id === activeProduct.id
      ? backendState.flash_sale
      : null;
  const displayedPrice = activeFlashSale
    ? formatMoney(activeFlashSale.sale_price)
    : activeBackendSku
      ? formatMoney(activeBackendSku.current_price)
      : activeProduct.price;
  const displayedStock = activeBackendSku?.stock ?? activeProduct.stock;

  useEffect(() => {
    function syncRoomState() {
      setRoomState(readLocalRoomState());
    }

    syncRoomState();

    return subscribeToLocalRoom(syncRoomState);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function pollBackendState() {
      const controller = new AbortController();

      try {
        const state = await fetchBackendState(controller.signal);

        if (!cancelled) {
          setBackendState(state);
          setBackendError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setBackendError(
            error instanceof Error ? error.message : "Backend unavailable",
          );
        }
      }
    }

    pollBackendState();
    const intervalId = window.setInterval(pollBackendState, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  function handleSubmitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = messageInput.trim();

    if (!trimmedMessage) {
      return;
    }

    appendViewerMessage(trimmedMessage, "You");
    setRoomState(readLocalRoomState());
    setMessageInput("");
  }

  return (
    <AppShell
      eyebrow="Viewer"
      title="Customer livestream room"
      description="A local mock viewer surface with the active product, offer state, and chat preview."
    >
      <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <Panel title="Active Product" eyebrow="Now featured">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-950">
                  {activeProduct.name}
                </h2>
                <p className="mt-2 text-2xl font-semibold text-teal-800">
                  {displayedPrice}
                </p>
              </div>
              <StatusPill tone="good">{displayedStock} left</StatusPill>
            </div>
            <ul className="mt-5 space-y-2 text-sm leading-6 text-slate-700">
              {activeProduct.facts.map((fact) => (
                <li key={fact}>- {fact}</li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <StatusPill tone={backendState ? "good" : "warning"}>
                {backendState ? "Backend synced" : "Local fallback"}
              </StatusPill>
              {backendError ? <StatusPill tone="warning">Backend offline</StatusPill> : null}
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-amber-900">
                Limited-time offer
              </p>
              <StatusPill tone="warning">
                ends in{" "}
                {activeFlashSale
                  ? activeFlashSale.ends_in_seconds
                  : flashSale.secondsLeft}
                s
              </StatusPill>
            </div>
            <p className="mt-2 text-sm text-amber-800">
              {activeFlashSale
                ? `${activeFlashSale.sold}/${activeFlashSale.quantity} left`
                : `${flashSale.sold}/${flashSale.total} left`}
            </p>
            {activeFlashSale ? (
              <p className="mt-2 text-sm font-semibold text-amber-900">
                Backend flash sale: {formatMoney(activeFlashSale.sale_price)}
              </p>
            ) : null}
          </div>
        </Panel>
        <div className="grid gap-4">
          <Panel title="Host and Agent Replies" eyebrow="Room replies">
            <div className="space-y-3">
              {initialReplies.map((reply) => (
                <div
                  className={`rounded-md border p-3 ${
                    reply.tone === "agent"
                      ? "border-teal-200 bg-teal-50"
                      : "border-slate-200 bg-slate-50"
                  }`}
                  key={reply.id}
                >
                  <p
                    className={`text-xs font-semibold ${
                      reply.tone === "agent"
                        ? "text-teal-700"
                        : "text-slate-500"
                    }`}
                  >
                    {reply.sender}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {reply.message}
                  </p>
                </div>
              ))}
              {roomState.replies.map((reply) => (
                <div
                  className="rounded-md border border-teal-200 bg-teal-50 p-3"
                  key={reply.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-teal-700">
                      {reply.name}
                    </p>
                    <StatusPill tone="good">Synced</StatusPill>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {reply.text}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Viewer Chat" eyebrow="Local messages">
            <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
              {mockChat.map((chat) => (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  key={`${chat.viewer}-${chat.message}`}
                >
                  <p className="text-xs font-semibold text-slate-500">
                    {chat.viewer}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {chat.message}
                  </p>
                </div>
              ))}
              {roomState.viewerMessages.map((chat) => (
                <div
                  className="rounded-md border border-teal-200 bg-teal-50 p-3"
                  key={chat.id}
                >
                  <p className="text-xs font-semibold text-teal-700">
                    {chat.name}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {chat.text}
                  </p>
                </div>
              ))}
            </div>
            <form
              className="mt-4 flex flex-col gap-2 sm:flex-row"
              onSubmit={handleSubmitMessage}
            >
              <label className="sr-only" htmlFor="viewer-message">
                Viewer message
              </label>
              <input
                className="min-h-11 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                id="viewer-message"
                onChange={(event) => setMessageInput(event.target.value)}
                placeholder="Ask about the active product"
                value={messageInput}
              />
              <button
                className="min-h-11 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
                type="submit"
              >
                Send
              </button>
            </form>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
