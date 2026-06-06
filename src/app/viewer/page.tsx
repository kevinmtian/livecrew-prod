"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import { defaultActiveSkuId, getActiveSkuDisplay } from "@/lib/catalogue";
import { mockChat } from "@/lib/mock-data";
import { FormEvent, useState } from "react";

type ViewerMessage = {
  id: string;
  viewer: string;
  message: string;
};

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
  const activeProduct = getActiveSkuDisplay(defaultActiveSkuId);
  const [messageInput, setMessageInput] = useState("");
  const [viewerMessages, setViewerMessages] = useState<ViewerMessage[]>(
    mockChat.map((chat, index) => ({
      id: `mock-chat-${index}`,
      viewer: chat.viewer,
      message: chat.message,
    })),
  );

  function handleSubmitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = messageInput.trim();

    if (!trimmedMessage) {
      return;
    }

    setViewerMessages((currentMessages) => [
      ...currentMessages,
      {
        id: `viewer-message-${Date.now()}`,
        viewer: "You",
        message: trimmedMessage,
      },
    ]);
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
                  {activeProduct.price}
                </p>
              </div>
              <StatusPill tone="good">{activeProduct.stock} left</StatusPill>
            </div>
            <ul className="mt-5 space-y-2 text-sm leading-6 text-slate-700">
              {activeProduct.facts.map((fact) => (
                <li key={fact}>- {fact}</li>
              ))}
            </ul>
          </div>
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-amber-900">
                Limited-time offer
              </p>
              <StatusPill tone="warning">
                ends in {flashSale.secondsLeft}s
              </StatusPill>
            </div>
            <p className="mt-2 text-sm text-amber-800">
              {flashSale.sold}/{flashSale.total} left
            </p>
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
            </div>
          </Panel>
          <Panel title="Viewer Chat" eyebrow="Local messages">
            <div className="max-h-[28rem] space-y-3 overflow-y-auto pr-1">
              {viewerMessages.map((chat) => (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  key={chat.id}
                >
                  <p className="text-xs font-semibold text-slate-500">
                    {chat.viewer}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {chat.message}
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
