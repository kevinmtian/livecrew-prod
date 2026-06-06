"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  Clock3,
  MessageSquare,
  PackageCheck,
  Send,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { Panel } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import { activeSkuId, getActiveSkuDisplay } from "@/lib/catalogue";
import { chatMessages, liveSession, viewerActions } from "@/lib/mockData";
import {
  createRoomTimestamp,
  createViewerMessageId,
  fetchRoomState,
  mergeViewerMessages,
  publishRoomEvent,
  readRoomState,
  subscribeRoomEvents,
  type RoomHostReply,
  type RoomViewerMessage,
} from "@/lib/roomChannel";

type ViewerMessage = RoomViewerMessage;
type ReplyItem = RoomHostReply;

const initialReplies: ReplyItem[] = [
  {
    id: "reply-1",
    source: "Host",
    text: "GlowFix goes on before moisturizer and SPF. Start with a thin layer.",
  },
  {
    id: "reply-2",
    source: "Agent",
    text: "The active product is in stock and pinned in the offer card.",
  },
  {
    id: "reply-3",
    source: "Host",
    text: "I will show the texture again before we move to the next product.",
  },
];

const initialViewerMessages: ViewerMessage[] = chatMessages.map((message, index) => ({
  id: message.id,
  user: message.user,
  text: message.text,
  priority: message.priority as ViewerMessage["priority"],
  createdAt: index + 1,
}));

export default function ViewerPage() {
  const [activeProductId, setActiveProductId] = useState(activeSkuId);
  const featuredProduct = getActiveSkuDisplay(activeProductId);
  const [messageText, setMessageText] = useState("");
  const [messages, setMessages] = useState<ViewerMessage[]>(
    mergeViewerMessages([], initialViewerMessages),
  );
  const [replies, setReplies] = useState(initialReplies);
  const [remainingSeconds, setRemainingSeconds] = useState(45);
  const [remainingUnits, setRemainingUnits] = useState(32);

  function syncRoomState(roomState: Awaited<ReturnType<typeof readRoomState>>) {
    setActiveProductId(roomState.activeSkuId);
    setMessages((current) =>
      mergeViewerMessages(current, roomState.viewerMessages),
    );
    setReplies((current) =>
      Array.from(
        new Map(
          [...current, ...roomState.hostReplies].map((reply) => [reply.id, reply]),
        ).values(),
      ),
    );
  }

  useEffect(() => {
    window.setTimeout(() => {
      syncRoomState(readRoomState());
      void fetchRoomState().then(syncRoomState).catch(() => {});
    }, 0);

    const poll = window.setInterval(() => {
      void fetchRoomState().then(syncRoomState).catch(() => {});
    }, 1000);

    const unsubscribe = subscribeRoomEvents((event) => {
      if (event.type === "viewer-message") {
        setMessages((current) => mergeViewerMessages(current, [event.message]));
      }

      if (event.type === "host-reply") {
        setReplies((current) =>
          Array.from(
            new Map([...current, event.reply].map((reply) => [reply.id, reply])).values(),
          ),
        );
      }

      if (event.type === "active-sku") {
        setActiveProductId(event.skuId);
      }

      if (event.type === "reset-room") {
        setActiveProductId(activeSkuId);
        setMessages(mergeViewerMessages([], initialViewerMessages));
        setReplies(initialReplies);
        setRemainingSeconds(45);
        setRemainingUnits(32);
      }
    });

    return () => {
      window.clearInterval(poll);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemainingSeconds((current) => (current > 0 ? current - 1 : 0));
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = messageText.trim();
    if (!trimmedMessage) {
      return;
    }

    const nextMessage = {
      id: createViewerMessageId(),
      user: "you",
      text: trimmedMessage,
      createdAt: createRoomTimestamp(),
    };

    setMessages((current) => mergeViewerMessages(current, [nextMessage]));
    publishRoomEvent({ type: "viewer-message", message: nextMessage });
    setRemainingUnits((current) => Math.max(current - 1, 0));
    setMessageText("");
  }

  return (
    <AppShell
      active="viewer"
      title="Viewer Livestream Room"
      subtitle="Customer-facing shopping room with local chat, replies, and flash-sale state."
    >
      <div className="grid gap-4 md:grid-cols-3">
        {viewerActions.map((action) => (
          <MetricCard
            key={action.label}
            label={action.label}
            value={action.value}
            detail={action.change}
          />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <Panel
          title="Live Stream"
          action={<StatusPill tone="live">{liveSession.status}</StatusPill>}
        >
          <div className="flex aspect-video min-h-[240px] items-center justify-center rounded-md border border-slate-800 bg-slate-950 p-6 text-center text-white">
            <div>
              <p className="text-sm font-semibold uppercase text-slate-300">
                {liveSession.title}
              </p>
              <p className="mt-3 text-3xl font-semibold">{liveSession.host}</p>
              <p className="mt-2 text-sm text-slate-300">
                {liveSession.audience.toLocaleString()} watching
              </p>
            </div>
          </div>
        </Panel>

        <Panel
          title="Active Product"
          action={<StatusPill tone="good">{featuredProduct.aliasLabel}</StatusPill>}
        >
          <article className="rounded-md border border-line bg-panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">
                  Active product
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-ink">
                  {featuredProduct.name}
                </h2>
              </div>
              <span className="text-2xl font-semibold text-ink">
                {featuredProduct.price}
              </span>
            </div>

            <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-rose-900">
                  <Clock3 className="h-4 w-4" aria-hidden="true" />
                  Limited-time offer
                </span>
                <StatusPill tone="live">Live</StatusPill>
              </div>
              <p className="mt-4 text-2xl font-semibold text-rose-950">
                {remainingUnits}/{featuredProduct.stock} left
              </p>
              <p className="mt-2 text-sm font-medium text-rose-900">
                ends in {remainingSeconds}s
              </p>
              <button
                className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white"
                type="button"
                onClick={() => setRemainingUnits((current) => Math.max(current - 1, 0))}
              >
                <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                Claim offer
              </button>
            </div>

            <div className="mt-4 grid gap-2">
              {featuredProduct.facts.map((fact) => (
                <div
                  key={fact}
                  className="flex items-start gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm leading-6 text-slate-700"
                >
                  <PackageCheck className="mt-1 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                  <span>{fact}</span>
                </div>
              ))}
            </div>
            <button
              className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white"
              type="button"
            >
              <ShoppingBag className="h-4 w-4" aria-hidden="true" />
              Add to cart
            </button>
          </article>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Panel title="Viewer Chat">
          <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
            {messages.map((message) => (
              <article
                key={message.id}
                className="flex items-start gap-3 rounded-md border border-line bg-panel p-3"
              >
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{message.user}</p>
                  <p className="mt-1 break-words text-sm leading-6 text-slate-700">
                    {message.text}
                  </p>
                </div>
              </article>
            ))}
          </div>

          <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={submitMessage}>
            <input
              className="h-11 min-w-0 flex-1 rounded-md border border-line bg-panel px-3 text-sm text-ink outline-none focus:border-slate-500"
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              placeholder="Ask about the active product"
              aria-label="Viewer chat message"
            />
            <button
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-ink px-4 text-sm font-semibold text-white"
              type="submit"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              Send
            </button>
          </form>
        </Panel>

        <Panel title="Host / Agent Replies">
          <div className="max-h-[430px] space-y-3 overflow-y-auto pr-1">
            {replies.map((reply) => (
              <article
                key={reply.id}
                className="rounded-md border border-line bg-panel p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
                    <Sparkles className="h-4 w-4 text-slate-500" aria-hidden="true" />
                    {reply.source}
                  </span>
                  <StatusPill tone={reply.source === "Host" ? "live" : "neutral"}>
                    Reply
                  </StatusPill>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-700">{reply.text}</p>
              </article>
            ))}
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
