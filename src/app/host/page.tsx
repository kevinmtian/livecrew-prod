"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ClipboardList,
  Database,
  MessageSquare,
  PackageCheck,
  Play,
  Radio,
  RefreshCcw,
  Send,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { MetricCard } from "@/components/MetricCard";
import { Panel } from "@/components/Panel";
import { StatusPill } from "@/components/StatusPill";
import {
  activeSkuId,
  getActiveSkuDisplay,
  productCatalogue,
  resolveSkuFromText,
} from "@/lib/catalogue";
import { chatMessages, liveSession } from "@/lib/mockData";
import {
  fetchRoomState,
  mergeViewerMessages,
  publishRoomEvent,
  readRoomState,
  subscribeRoomEvents,
  type RoomHostReply,
  type RoomViewerMessage,
} from "@/lib/roomChannel";

type ViewerMessage = RoomViewerMessage;

type LedgerEvent = {
  id: string;
  time: string;
  event: string;
  detail: string;
  status: "Done" | "Queued" | "Review";
};

const scriptedTranscript = [
  "Opening with GlowFix Vitamin C Serum. I am explaining when to use it and how it layers before SPF.",
  "Switching to HydraMist Cushion SPF for touch-ups and shade questions from chat.",
  "Moving to Bamboo Thermal Tumbler and answering insulation questions before the bundle.",
  "Closing with Satin Cloud Sleep Mask as the cart add-on for tonight's bundle.",
];

const starterLedger: LedgerEvent[] = [
  {
    id: "ledger-1",
    time: "00:41",
    event: "SKU activated",
    detail: "GlowFix Vitamin C Serum moved to on-air shelf.",
    status: "Done",
  },
  {
    id: "ledger-2",
    time: "01:08",
    event: "Cart signal",
    detail: "24 viewers added the active SKU after first demo callout.",
    status: "Done",
  },
  {
    id: "ledger-3",
    time: "02:15",
    event: "Agent queue",
    detail: "Layering question routed to suggested replies.",
    status: "Queued",
  },
];

const replyTemplates = [
  "Yes, use a thin layer before moisturizer and SPF. Patch test first if you are sensitive.",
  "The active SKU is in stock and pinned on the shelf. I can repeat the key product facts now.",
  "Bundle note ready: confirm the item in cart, then mention stock and the current demo use case.",
];

function getClockLabel(index: number) {
  return `0${Math.floor((index + 3) / 2)}:${index % 2 === 0 ? "20" : "45"}`;
}

const initialViewerMessages: ViewerMessage[] = chatMessages.map((message, index) => ({
  id: message.id,
  user: message.user,
  text: message.text,
  intent: message.intent,
  priority: message.priority as ViewerMessage["priority"],
  createdAt: index + 1,
}));

export default function HostPage() {
  const [transcript, setTranscript] = useState(scriptedTranscript[0]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [viewerChat, setViewerChat] = useState<ViewerMessage[]>(
    mergeViewerMessages([], initialViewerMessages),
  );
  const [suggestedReplies, setSuggestedReplies] = useState(replyTemplates);
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEvent[]>(starterLedger);
  const seenViewerMessageIds = useRef(
    new Set(initialViewerMessages.map((message) => message.id)),
  );

  const activeProduct = getActiveSkuDisplay(
    productCatalogue[activeIndex]?.id ?? activeSkuId,
  );

  const detectedProduct = useMemo(
    () => resolveSkuFromText(transcript),
    [transcript],
  );

  function syncRoomState(roomState: Awaited<ReturnType<typeof readRoomState>>) {
    const syncedSkuIndex = productCatalogue.findIndex(
      (product) => product.id === roomState.activeSkuId,
    );

    if (syncedSkuIndex >= 0) {
      setActiveIndex(syncedSkuIndex);
    }

    if (roomState.viewerMessages.length > 0) {
      roomState.viewerMessages.forEach((message) => {
        seenViewerMessageIds.current.add(message.id);
      });
      setViewerChat((current) => mergeViewerMessages(current, roomState.viewerMessages));
    }
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
        if (seenViewerMessageIds.current.has(event.message.id)) {
          return;
        }

        seenViewerMessageIds.current.add(event.message.id);
        setViewerChat((current) => mergeViewerMessages(current, [event.message]));
        setLedgerEvents((current) => [
          {
            id: `ledger-${current.length + 1}`,
            time: getClockLabel(current.length),
            event: "Viewer message",
            detail: `${event.message.user} sent a message from the viewer room.`,
            status: "Queued",
          },
          ...current,
        ]);
      }

      if (event.type === "active-sku") {
        const nextIndex = productCatalogue.findIndex(
          (product) => product.id === event.skuId,
        );

        if (nextIndex >= 0) {
          setActiveIndex(nextIndex);
        }
      }
    });

    return () => {
      window.clearInterval(poll);
      unsubscribe();
    };
  }, []);

  function addLedgerEvent(event: string, detail: string, status: LedgerEvent["status"]) {
    setLedgerEvents((current) => [
      {
        id: `ledger-${current.length + 1}`,
        time: getClockLabel(current.length),
        event,
        detail,
        status,
      },
      ...current,
    ]);
  }

  function advanceFlow() {
    const nextIndex = (activeIndex + 1) % productCatalogue.length;
    const nextProduct = productCatalogue[nextIndex];

    setActiveIndex(nextIndex);
    setTranscript(scriptedTranscript[nextIndex]);
    setSuggestedReplies([
      `Bring up ${nextProduct.name}: ${nextProduct.facts[0].toLowerCase()}.`,
      `If chat asks for stock, say ${nextProduct.stock} units are available in this mock room.`,
      `Use alias coverage: ${nextProduct.aliases.slice(0, 2).join(", ")}.`,
    ]);
    addLedgerEvent(
      "Flow advanced",
      `${nextProduct.name} is now the active shelf SKU.`,
      "Done",
    );
    publishRoomEvent({ type: "active-sku", skuId: nextProduct.id });
  }

  function addSampleChat() {
    const product = productCatalogue[activeIndex];
    const nextMessage: ViewerMessage = {
      id: `msg-${viewerChat.length + 1}`,
      user: `viewer_${viewerChat.length + 11}`,
      text: `Can you repeat the main benefit of ${product.aliases[0]}?`,
      intent: "Product detail",
      priority: viewerChat.length % 2 === 0 ? "High" : "Medium",
      createdAt: viewerChat.length + 1,
    };

    setViewerChat((current) => mergeViewerMessages(current, [nextMessage]));
    addLedgerEvent(
      "Viewer question",
      `${nextMessage.user} asked about ${product.name}.`,
      "Queued",
    );
  }

  function detectSkuFromTranscript() {
    if (!detectedProduct) {
      addLedgerEvent(
        "Transcript scan",
        "No catalogue SKU detected in the current transcript.",
        "Review",
      );
      return;
    }

    const detectedIndex = productCatalogue.findIndex(
      (product) => product.id === detectedProduct.id,
    );

    setActiveIndex(detectedIndex);
    addLedgerEvent(
      "Transcript scan",
      `${detectedProduct.name} detected and promoted to active SKU.`,
      "Done",
    );
    publishRoomEvent({ type: "active-sku", skuId: detectedProduct.id });
  }

  function sendHostReply(reply: string, index: number) {
    const hostReply: RoomHostReply = {
      id: `host-reply-${ledgerEvents.length + 1}-${index}`,
      source: "Host",
      text: reply,
    };

    publishRoomEvent({ type: "host-reply", reply: hostReply });
    addLedgerEvent(
      "Reply sent",
      `Suggested reply ${index + 1} sent to the viewer room.`,
      "Done",
    );
  }

  function resetDemo() {
    setTranscript(scriptedTranscript[0]);
    setActiveIndex(0);
    setViewerChat(mergeViewerMessages([], initialViewerMessages));
    setSuggestedReplies(replyTemplates);
    setLedgerEvents(starterLedger);
    publishRoomEvent({ type: "reset-room" });
  }

  return (
    <AppShell
      active="host"
      title="Host Operator Cockpit"
      subtitle="Run the livestream with local transcript, product, chat, agent, and commerce state."
    >
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard label="Runtime" value={liveSession.runtime} detail={liveSession.host} />
        <MetricCard label="Live viewers" value={liveSession.audience.toLocaleString()} detail="Mock active audience" />
        <MetricCard label="Active SKU" value={activeProduct.aliasLabel} detail={activeProduct.name} />
        <MetricCard label="Ledger events" value={String(ledgerEvents.length)} detail="Local sample feed" />
      </div>

      <div className="flex flex-wrap gap-2 rounded-md border border-line bg-white p-3 shadow-soft">
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-ink px-3 text-sm font-semibold text-white"
          type="button"
          onClick={advanceFlow}
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          Advance flow
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-panel px-3 text-sm font-semibold text-slate-700"
          type="button"
          onClick={addSampleChat}
        >
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Add chat
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-panel px-3 text-sm font-semibold text-slate-700"
          type="button"
          onClick={detectSkuFromTranscript}
        >
          <PackageCheck className="h-4 w-4" aria-hidden="true" />
          Detect SKU
        </button>
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-panel px-3 text-sm font-semibold text-slate-700"
          type="button"
          onClick={resetDemo}
        >
          <RefreshCcw className="h-4 w-4" aria-hidden="true" />
          Reset
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.9fr]">
        <Panel
          title="Host Transcript Input"
          action={
            detectedProduct ? (
              <StatusPill tone="good">{detectedProduct.name}</StatusPill>
            ) : (
              <StatusPill>Listening</StatusPill>
            )
          }
        >
          <textarea
            className="min-h-44 w-full resize-y rounded-md border border-line bg-panel p-3 text-sm leading-6 text-ink outline-none focus:border-slate-500"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
            aria-label="Host transcript"
          />
          <p className="mt-3 text-xs text-slate-500">
            Local transcript state only. SKU detection scans names and aliases from the shared catalogue.
          </p>
        </Panel>

        <Panel
          title="Product Shelf / Active SKU"
          action={<StatusPill tone="live">Pinned</StatusPill>}
        >
          <div className="rounded-md border border-line bg-panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-slate-500">
                  {activeProduct.id}
                </p>
                <h2 className="mt-2 text-xl font-semibold text-ink">
                  {activeProduct.name}
                </h2>
                <p className="mt-2 text-sm text-slate-600">
                  {activeProduct.price} - {activeProduct.stock} in stock
                </p>
              </div>
              <StatusPill tone="good">{activeProduct.aliasLabel}</StatusPill>
            </div>
            <div className="mt-4 grid gap-2">
              {activeProduct.facts.map((fact) => (
                <div
                  key={fact}
                  className="rounded-md border border-line bg-white px-3 py-2 text-sm text-slate-700"
                >
                  {fact}
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {productCatalogue.map((product, index) => (
              <button
                key={product.id}
                className={`min-h-12 rounded-md border px-3 py-2 text-left text-xs font-semibold ${
                  product.id === activeProduct.id
                    ? "border-ink bg-ink text-white"
                    : "border-line bg-panel text-slate-700"
                }`}
                type="button"
                onClick={() => {
                  setActiveIndex(index);
                  addLedgerEvent("SKU selected", `${product.name} selected from shelf.`, "Done");
                  publishRoomEvent({ type: "active-sku", skuId: product.id });
                }}
              >
                {product.name}
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Viewer Chat">
          <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
            {viewerChat.map((message) => (
              <article
                key={message.id}
                className="rounded-md border border-line bg-panel p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                    <Radio className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                    <span className="truncate">{message.user}</span>
                  </span>
                <StatusPill tone={message.priority === "High" ? "warn" : "neutral"}>
                    {message.priority ?? "Live"}
                  </StatusPill>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-700">{message.text}</p>
                <p className="mt-2 text-xs font-semibold uppercase text-slate-500">
                  {message.intent ?? "Viewer message"}
                </p>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Panel
          title="AI Suggested Replies / Agent Queue"
          action={<StatusPill>Placeholder</StatusPill>}
        >
          <div className="space-y-3">
            {suggestedReplies.map((reply, index) => (
              <div
                key={reply}
                className="rounded-md border border-line bg-panel p-3"
              >
                <div className="flex items-start gap-3">
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-slate-600" aria-hidden="true" />
                  <p className="text-sm leading-6 text-slate-700">{reply}</p>
                </div>
                <button
                  className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-xs font-semibold text-slate-700"
                  type="button"
                  onClick={() => sendHostReply(reply, index)}
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" />
                  Send reply
                </button>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Agent Event Timeline / Commerce Ledger"
          action={<StatusPill tone="good">{ledgerEvents.length} events</StatusPill>}
        >
          <div className="space-y-3">
            {ledgerEvents.map((item) => (
              <article
                key={item.id}
                className="grid gap-3 rounded-md border border-line bg-panel p-3 sm:grid-cols-[64px_1fr_auto]"
              >
                <span className="text-xs font-semibold text-slate-500">{item.time}</span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">{item.event}</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-600">{item.detail}</p>
                </div>
                <StatusPill
                  tone={
                    item.status === "Done"
                      ? "good"
                      : item.status === "Review"
                        ? "warn"
                        : "neutral"
                  }
                >
                  {item.status}
                </StatusPill>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Backend Commerce Placeholder"
          action={<StatusPill>Local only</StatusPill>}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Cart API", "Not connected"],
              ["Inventory sync", "Mock stock"],
              ["Checkout", "Disabled"],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-md border border-line bg-panel p-4"
              >
                <Database className="h-5 w-5 text-slate-600" aria-hidden="true" />
                <p className="mt-3 text-xs font-semibold uppercase text-slate-500">
                  {label}
                </p>
                <p className="mt-1 text-sm font-semibold text-ink">{value}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Producer Report Placeholder"
          action={<StatusPill>Draft</StatusPill>}
        >
          <div className="rounded-md border border-line bg-panel p-4">
            <div className="flex items-start gap-3">
              <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-slate-600" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold text-ink">Post-stream report</h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Placeholder for highlights, missed questions, agent decisions,
                  product conversion notes, and handoff items for the next run.
                </p>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
