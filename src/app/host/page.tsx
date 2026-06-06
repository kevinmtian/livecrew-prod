"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  type SkuId,
  commerceCatalogue,
  defaultActiveSkuId,
  getActiveSkuDisplay,
  resolveSkuFromText,
} from "@/lib/catalogue";
import { mockChat } from "@/lib/mock-data";
import { useMemo, useState } from "react";

type LedgerEvent = {
  id: string;
  label: string;
  detail: string;
  status: "complete" | "watching" | "blocked" | "pending";
};

type QueueItem = {
  id: string;
  title: string;
  detail: string;
  status: "Draft" | "Review" | "Blocked";
};

const initialTranscript =
  "Today we are starting with GlowFix Vitamin C Serum. It is a brightening serum in a 30 ml bottle.";

const scriptedSteps: Array<{
  label: string;
  transcript: string;
  activeSkuId: SkuId;
  queueItem: QueueItem;
  ledgerEvent: LedgerEvent;
}> = [
  {
    label: "Mention GlowFix",
    transcript:
      "Host: We are opening with GlowFix Vitamin C Serum for morning routines.",
    activeSkuId: "glowfix-vitamin-c-serum",
    queueItem: {
      id: "queue-glowfix-fact",
      title: "Draft grounded serum reply",
      detail:
        "Use catalogue facts only: 30 ml bottle, morning routine, before moisturizer and sunscreen.",
      status: "Draft",
    },
    ledgerEvent: {
      id: "evt-script-001",
      label: "SKU selected",
      detail: "Co-Host matched transcript mention to GlowFix Vitamin C Serum.",
      status: "complete",
    },
  },
  {
    label: "Viewer asks fact",
    transcript:
      "Host: GlowFix is still active. Viewer asks if it fits a morning routine.",
    activeSkuId: "glowfix-vitamin-c-serum",
    queueItem: {
      id: "queue-morning-routine",
      title: "Answer product fact",
      detail:
        "Grounded answer allowed: GlowFix is designed for morning routines and should be used before moisturizer and sunscreen.",
      status: "Draft",
    },
    ledgerEvent: {
      id: "evt-script-002",
      label: "Viewer question handled",
      detail: "Concierge prepared a grounded product-fact reply for GlowFix.",
      status: "complete",
    },
  },
  {
    label: "Guardrail check",
    transcript:
      "Host: A viewer asks for an unverified discount. Do not invent a promo.",
    activeSkuId: "glowfix-vitamin-c-serum",
    queueItem: {
      id: "queue-discount-review",
      title: "Escalate unverified promo",
      detail:
        "No catalogue or backend promo exists yet, so the agent should ask the host to confirm.",
      status: "Review",
    },
    ledgerEvent: {
      id: "evt-script-003",
      label: "Guardrail escalation",
      detail: "Blocked unverified discount claim and escalated to host review.",
      status: "blocked",
    },
  },
  {
    label: "Switch to Tumbler",
    transcript:
      "Host: Next on the shelf is the Bamboo Thermal Tumbler, our 500 ml reusable cup.",
    activeSkuId: "bamboo-thermal-tumbler",
    queueItem: {
      id: "queue-tumbler-fact",
      title: "Prepare tumbler facts",
      detail:
        "Active SKU changed to Bamboo Thermal Tumbler with 500 ml capacity and thermal insulation.",
      status: "Draft",
    },
    ledgerEvent: {
      id: "evt-script-004",
      label: "Active SKU changed",
      detail: "Product shelf now highlights Bamboo Thermal Tumbler.",
      status: "complete",
    },
  },
];

const initialLedger: LedgerEvent[] = [
  {
    id: "evt-initial-001",
    label: "Cockpit ready",
    detail: "Local host shell loaded with mock catalogue and no backend dependency.",
    status: "complete",
  },
  {
    id: "evt-initial-002",
    label: "Guardrail ready",
    detail: "Unverified discounts and unsupported claims require host review.",
    status: "watching",
  },
];

export default function HostPage() {
  const [transcript, setTranscript] = useState(initialTranscript);
  const [activeSkuId, setActiveSkuId] = useState<SkuId>(defaultActiveSkuId);
  const [scriptIndex, setScriptIndex] = useState(0);
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEvent[]>(initialLedger);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([
    {
      id: "queue-initial",
      title: "Waiting for viewer message",
      detail:
        "Agent queue is local-only for this step. Later prompts will wire deterministic analysis.",
      status: "Review",
    },
  ]);

  const activeProduct = getActiveSkuDisplay(activeSkuId);
  const transcriptMention = useMemo(
    () => resolveSkuFromText(transcript),
    [transcript],
  );

  function appendLedger(event: LedgerEvent) {
    setLedgerEvents((currentEvents) => [
      {
        ...event,
        id: `${event.id}-${Date.now()}`,
      },
      ...currentEvents,
    ]);
  }

  function handleUseTranscriptMatch() {
    if (!transcriptMention) {
      appendLedger({
        id: "evt-no-sku",
        label: "Transcript scanned",
        detail: "No catalogue SKU was found in the current transcript.",
        status: "pending",
      });
      return;
    }

    setActiveSkuId(transcriptMention.id);
    appendLedger({
      id: "evt-transcript-match",
      label: "Transcript scanned",
      detail: `Matched transcript mention to ${transcriptMention.name}.`,
      status: "complete",
    });
  }

  function handleAdvanceScript() {
    const step = scriptedSteps[scriptIndex];

    setTranscript(step.transcript);
    setActiveSkuId(step.activeSkuId);
    setQueueItems((currentItems) => [
      {
        ...step.queueItem,
        id: `${step.queueItem.id}-${Date.now()}`,
      },
      ...currentItems,
    ]);
    appendLedger(step.ledgerEvent);
    setScriptIndex((scriptIndex + 1) % scriptedSteps.length);
  }

  function handleResetDemo() {
    setTranscript(initialTranscript);
    setActiveSkuId(defaultActiveSkuId);
    setScriptIndex(0);
    setLedgerEvents(initialLedger);
    setQueueItems([
      {
        id: "queue-initial",
        title: "Waiting for viewer message",
        detail:
          "Agent queue is local-only for this step. Later prompts will wire deterministic analysis.",
        status: "Review",
      },
    ]);
  }

  return (
    <AppShell
      eyebrow="Host"
      title="Operator cockpit"
      description="Monitor transcript context, active products, viewer chat, agent suggestions, and the commerce ledger."
    >
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Script controls
          </p>
          <p className="mt-1 text-sm text-slate-700">
            Next step: {scriptedSteps[scriptIndex].label}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
            onClick={handleAdvanceScript}
            type="button"
          >
            Advance demo
          </button>
          <button
            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
            onClick={handleUseTranscriptMatch}
            type="button"
          >
            Match transcript SKU
          </button>
          <button
            className="min-h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:bg-white"
            onClick={handleResetDemo}
            type="button"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.85fr]">
        <div className="grid gap-4">
          <Panel title="Host Transcript" eyebrow="Input">
            <label className="sr-only" htmlFor="transcript">
              Host transcript
            </label>
            <textarea
              className="min-h-36 w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-teal-500 focus:bg-white"
              id="transcript"
              onChange={(event) => setTranscript(event.target.value)}
              value={transcript}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusPill tone={transcriptMention ? "good" : "warning"}>
                {transcriptMention
                  ? `Detected ${transcriptMention.name}`
                  : "No SKU detected"}
              </StatusPill>
              <StatusPill>Local state only</StatusPill>
            </div>
          </Panel>
          <Panel title="Viewer Chat" eyebrow="Live messages">
            <div className="space-y-3">
              {mockChat.map((chat) => (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-3"
                  key={`${chat.viewer}-${chat.message}`}
                >
                  <p className="text-xs font-semibold text-slate-500">
                    {chat.viewer}
                  </p>
                  <p className="mt-1 text-sm text-slate-800">{chat.message}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="grid gap-4">
          <Panel title="Product Shelf" eyebrow="Active SKU">
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    {activeProduct.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {activeProduct.price} · {activeProduct.stockLabel}
                  </p>
                </div>
                <StatusPill tone="good">Highlighted</StatusPill>
              </div>
              <ul className="mt-4 space-y-2 text-sm text-slate-700">
                {activeProduct.facts.map((fact) => (
                  <li key={fact}>- {fact}</li>
                ))}
              </ul>
              <p className="mt-4 text-xs text-teal-800">
                Resolved from transcript: {transcriptMention?.name ?? "No SKU"}
              </p>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {commerceCatalogue.map((sku) => (
                <button
                  className={`rounded-md border p-3 text-left text-sm transition ${
                    sku.id === activeProduct.id
                      ? "border-teal-300 bg-teal-50 text-teal-900"
                      : "border-slate-200 bg-slate-50 text-slate-700 hover:border-teal-300 hover:bg-white"
                  }`}
                  key={sku.id}
                  onClick={() => {
                    setActiveSkuId(sku.id);
                    appendLedger({
                      id: "evt-manual-sku",
                      label: "Host override",
                      detail: `Host manually selected ${sku.name} as active SKU.`,
                      status: "complete",
                    });
                  }}
                  type="button"
                >
                  <span className="block font-semibold">{sku.name}</span>
                  <span className="mt-1 block text-xs">
                    {sku.price} · {sku.stock} in stock
                  </span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title="AI Suggested Replies" eyebrow="Agent queue">
            <div className="space-y-3">
              {queueItems.map((item) => (
                <div
                  className="rounded-md border border-amber-200 bg-amber-50 p-3"
                  key={item.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      {item.title}
                    </p>
                    <StatusPill
                      tone={item.status === "Draft" ? "good" : "warning"}
                    >
                      {item.status}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    {item.detail}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="grid gap-4">
          <Panel title="Agent Event Timeline" eyebrow="Commerce ledger">
            <div className="space-y-3">
              {ledgerEvents.map((event) => {
                const borderClass =
                  event.status === "blocked"
                    ? "border-amber-500"
                    : event.status === "pending"
                      ? "border-slate-300"
                      : "border-teal-500";

                return (
                  <div className={`border-l-2 pl-3 ${borderClass}`} key={event.id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {event.label}
                      </p>
                      <StatusPill
                        tone={
                          event.status === "complete"
                            ? "good"
                            : event.status === "blocked"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {event.status}
                      </StatusPill>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {event.detail}
                    </p>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel title="Backend Commerce" eyebrow="Placeholder">
            <p className="text-sm leading-6 text-slate-600">
              Backend state, orders, flash sales, and SKU KPIs will connect in a
              later prompt.
            </p>
          </Panel>
          <Panel title="Producer Report" eyebrow="Placeholder">
            <p className="text-sm leading-6 text-slate-600">
              The final report will cite ledger events and backend commerce
              numbers after those systems exist.
            </p>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
