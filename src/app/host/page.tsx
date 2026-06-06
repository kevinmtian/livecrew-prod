"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  deterministicAnalyzeViewerMessage,
  type ViewerMessageAnalysis,
} from "@/lib/agent-analyzer";
import {
  type BackendCommerceState,
  createBackendFlashSale,
  fetchBackendState,
  formatMoney,
  getBackendActiveSkuId,
  getBackendBaseUrl,
  getBackendSkuName,
  groupOrdersBySku,
  listBackendProduct,
  placeBackendOrder,
  resetBackendCommerce,
} from "@/lib/backend-commerce";
import {
  type SkuId,
  commerceCatalogue,
  defaultActiveSkuId,
  getActiveSkuDisplay,
  resolveSkuFromText,
} from "@/lib/catalogue";
import {
  appendAgentReply,
  appendHostReply,
  defaultLocalRoomState,
  type LocalRoomState,
  readLocalRoomState,
  resetLocalRoomState,
  setRoomActiveSku,
  subscribeToLocalRoom,
} from "@/lib/local-room";
import { mockChat } from "@/lib/mock-data";
import { buildProducerReport } from "@/lib/producer-report";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  analysis?: Pick<
    ViewerMessageAnalysis,
    | "intent"
    | "decision"
    | "risk"
    | "confidence"
    | "skuId"
    | "orderQuantity"
    | "reason"
  >;
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
  const processedMessageIds = useRef(new Set<string>());
  const [transcript, setTranscript] = useState(initialTranscript);
  const [activeSkuId, setActiveSkuId] = useState<SkuId>(defaultActiveSkuId);
  const [scriptIndex, setScriptIndex] = useState(0);
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEvent[]>(initialLedger);
  const [roomState, setRoomState] =
    useState<LocalRoomState>(defaultLocalRoomState);
  const [replyInput, setReplyInput] = useState("");
  const [backendState, setBackendState] = useState<BackendCommerceState | null>(
    null,
  );
  const [backendError, setBackendError] = useState<string | null>(null);
  const [backendBusy, setBackendBusy] = useState(false);
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
  const activeBackendSku = backendState?.skus[activeProduct.id];
  const activeShelfPrice = activeBackendSku
    ? formatMoney(activeBackendSku.current_price)
    : activeProduct.price;
  const activeShelfStock = activeBackendSku?.stock ?? activeProduct.stock;
  const transcriptMention = useMemo(
    () => resolveSkuFromText(transcript),
    [transcript],
  );
  const backendOrderGroups = useMemo(
    () => groupOrdersBySku(backendState),
    [backendState],
  );
  const producerReport = useMemo(
    () =>
      buildProducerReport({
        backendState,
        queueItems,
        localLedgerEvents: ledgerEvents,
      }),
    [backendState, ledgerEvents, queueItems],
  );

  useEffect(() => {
    function syncRoomState() {
      const nextRoomState = readLocalRoomState();

      setRoomState(nextRoomState);
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

        if (cancelled) {
          return;
        }

        const backendActiveSkuId = getBackendActiveSkuId(state);

        setBackendState(state);
        setBackendError(null);

        if (backendActiveSkuId) {
          setActiveSkuId(backendActiveSkuId);
          setRoomActiveSku(backendActiveSkuId);
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

  const appendQueueStatus = useCallback((item: QueueItem) => {
    setQueueItems((currentItems) => [item, ...currentItems]);
  }, []);

  const processOrderMessage = useCallback(
    async (
      messageId: string,
      viewerName: string,
      analysis: ViewerMessageAnalysis,
    ) => {
      if (!analysis.skuId || !analysis.orderQuantity) {
        appendQueueStatus({
          id: `queue-order-clarify-${messageId}`,
          title: "Order needs host review",
          detail:
            "Order intent was detected, but SKU or quantity is unresolved.",
          status: "Review",
          analysis: {
            intent: analysis.intent,
            decision: "clarify",
            risk: analysis.risk,
            confidence: analysis.confidence,
            skuId: analysis.skuId,
            orderQuantity: analysis.orderQuantity,
            reason: analysis.reason,
          },
        });
        return;
      }

      try {
        const state = backendState ?? (await fetchBackendState());
        const skuState = state.skus[analysis.skuId];

        if (!skuState || skuState.stock < analysis.orderQuantity) {
          appendQueueStatus({
            id: `queue-order-blocked-${messageId}`,
            title: "Order blocked",
            detail: `${analysis.sku?.name ?? analysis.skuId} has ${
              skuState?.stock ?? 0
            } in stock, requested ${analysis.orderQuantity}.`,
            status: "Blocked",
            analysis: {
              intent: analysis.intent,
              decision: "block",
              risk: "medium",
              confidence: analysis.confidence,
              skuId: analysis.skuId,
              orderQuantity: analysis.orderQuantity,
              reason: "Insufficient backend stock for requested order.",
            },
          });
          appendAgentReply(
            `${analysis.sku?.name ?? "This product"} does not have enough stock for ${analysis.orderQuantity} units. The host has been notified.`,
          );
          setRoomState(readLocalRoomState());
          setLedgerEvents((currentEvents) => [
            {
              id: `evt-order-blocked-${messageId}`,
              label: "Order blocked",
              detail: `Requested ${analysis.orderQuantity}, available ${skuState?.stock ?? 0}.`,
              status: "blocked",
            },
            ...currentEvents,
          ]);
          return;
        }

        const orderResponse = await placeBackendOrder(
          analysis.skuId,
          analysis.orderQuantity,
          viewerName,
        );

        setBackendState(orderResponse.state);
        setBackendError(null);
        appendAgentReply(
          `Order received for ${analysis.orderQuantity} ${analysis.sku?.name ?? analysis.skuId}.`,
        );
        setRoomState(readLocalRoomState());
        setLedgerEvents((currentEvents) => [
          {
            id: `evt-order-placed-${messageId}`,
            label: "Backend order placed",
            detail: `${viewerName} ordered ${analysis.orderQuantity} ${analysis.sku?.name ?? analysis.skuId}.`,
            status: "complete",
          },
          ...currentEvents,
        ]);
      } catch (error) {
        setBackendError(
          error instanceof Error ? error.message : "Backend unavailable",
        );
        appendQueueStatus({
          id: `queue-order-review-${messageId}`,
          title: "Order needs backend review",
          detail:
            "Order intent was detected, but the backend was unavailable or rejected the order.",
          status: "Review",
          analysis: {
            intent: analysis.intent,
            decision: "host_review",
            risk: analysis.risk,
            confidence: analysis.confidence,
            skuId: analysis.skuId,
            orderQuantity: analysis.orderQuantity,
            reason: analysis.reason,
          },
        });
        setLedgerEvents((currentEvents) => [
          {
            id: `evt-order-review-${messageId}`,
            label: "Order requires review",
            detail:
              error instanceof Error ? error.message : "Backend unavailable",
            status: "pending",
          },
          ...currentEvents,
        ]);
      }
    },
    [appendQueueStatus, backendState],
  );

  useEffect(() => {
    for (const message of roomState.viewerMessages) {
      if (processedMessageIds.current.has(message.id)) {
        continue;
      }

      processedMessageIds.current.add(message.id);

      const analysis = deterministicAnalyzeViewerMessage({
        message: message.text,
        activeSkuId,
      });
      const queueItem = createQueueItemFromAnalysis(message.id, message.text, analysis);

      setQueueItems((currentItems) => [queueItem, ...currentItems]);
      setLedgerEvents((currentEvents) => [
        {
          id: `evt-agent-analysis-${message.id}`,
          label: "Viewer message analyzed",
          detail: `${message.name}: ${analysis.reason}`,
          status: analysis.decision === "block" ? "blocked" : "complete",
        },
        ...currentEvents,
      ]);

      if (
        analysis.intent === "product_fact" &&
        analysis.decision === "auto_reply" &&
        analysis.reply
      ) {
        appendAgentReply(analysis.reply);
        setRoomState(readLocalRoomState());
        setLedgerEvents((currentEvents) => [
          {
            id: `evt-agent-reply-${message.id}`,
            label: "Grounded reply sent",
            detail: `Auto-sent grounded facts for ${analysis.sku?.name}.`,
            status: "complete",
          },
          ...currentEvents,
        ]);
        continue;
      }

      if (analysis.intent === "order") {
        processOrderMessage(message.id, message.name, analysis);
        continue;
      }

      if (
        ["promo_request", "skin_safety", "price_change_complaint"].includes(
          analysis.intent,
        )
      ) {
        setLedgerEvents((currentEvents) => [
          {
            id: `evt-host-review-${message.id}`,
            label: "Host review required",
            detail: `${analysis.intent} cannot be auto-sent. ${analysis.reason}`,
            status: "pending",
          },
          ...currentEvents,
        ]);
      }
    }
  }, [activeSkuId, processOrderMessage, roomState.viewerMessages]);

  function appendLedger(event: LedgerEvent) {
    setLedgerEvents((currentEvents) => [
      {
        ...event,
        id: `${event.id}-${Date.now()}`,
      },
      ...currentEvents,
    ]);
  }

  async function refreshBackendState() {
    const state = await fetchBackendState();
    const backendActiveSkuId = getBackendActiveSkuId(state);

    setBackendState(state);
    setBackendError(null);

    if (backendActiveSkuId) {
      setActiveSkuId(backendActiveSkuId);
      setRoomActiveSku(backendActiveSkuId);
    }

    return state;
  }

  function updateActiveSku(nextSkuId: SkuId, syncBackend = true) {
    setActiveSkuId(nextSkuId);
    setRoomActiveSku(nextSkuId);
    setRoomState(readLocalRoomState());

    if (syncBackend) {
      setBackendBusy(true);
      listBackendProduct(nextSkuId)
        .then((state) => {
          setBackendState(state);
          setBackendError(null);
        })
        .catch((error) => {
          setBackendError(
            error instanceof Error ? error.message : "Backend unavailable",
          );
        })
        .finally(() => setBackendBusy(false));
    }
  }

  function createQueueItemFromAnalysis(
    messageId: string,
    messageText: string,
    analysis: ViewerMessageAnalysis,
  ): QueueItem {
    const status =
      analysis.decision === "block"
        ? "Blocked"
        : analysis.decision === "auto_reply"
          ? "Draft"
          : "Review";
    const skuLabel = analysis.sku?.name ?? "No SKU";
    const quantityLabel = analysis.orderQuantity
      ? ` · qty ${analysis.orderQuantity}`
      : "";

    return {
      id: `queue-analysis-${messageId}`,
      title: `${analysis.intent} · ${skuLabel}${quantityLabel}`,
      detail: messageText,
      status,
      analysis: {
        intent: analysis.intent,
        decision: analysis.decision,
        risk: analysis.risk,
        confidence: analysis.confidence,
        skuId: analysis.skuId,
        orderQuantity: analysis.orderQuantity,
        reason: analysis.reason,
      },
    };
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

    updateActiveSku(transcriptMention.id);
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
    updateActiveSku(step.activeSkuId);
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
    updateActiveSku(defaultActiveSkuId, false);
    resetLocalRoomState();
    setRoomState(readLocalRoomState());
    setScriptIndex(0);
    setLedgerEvents(initialLedger);
    setReplyInput("");
    setQueueItems([
      {
        id: "queue-initial",
        title: "Waiting for viewer message",
        detail:
          "Agent queue is local-only for this step. Later prompts will wire deterministic analysis.",
        status: "Review",
      },
    ]);
    setBackendBusy(true);
    resetBackendCommerce()
      .then((state) => {
        setBackendState(state);
        setBackendError(null);
      })
      .catch((error) => {
        setBackendError(
          error instanceof Error ? error.message : "Backend unavailable",
        );
      })
      .finally(() => setBackendBusy(false));
  }

  function handleSendHostReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedReply = replyInput.trim();

    if (!trimmedReply) {
      return;
    }

    appendHostReply(trimmedReply);
    setRoomState(readLocalRoomState());
    setReplyInput("");
    appendLedger({
      id: "evt-host-reply",
      label: "Host reply sent",
      detail: `Host sent reply to viewer room: ${trimmedReply}`,
      status: "complete",
    });
  }

  function handleRefreshBackend() {
    setBackendBusy(true);
    refreshBackendState()
      .catch((error) => {
        setBackendError(
          error instanceof Error ? error.message : "Backend unavailable",
        );
      })
      .finally(() => setBackendBusy(false));
  }

  function handleCreateFlashSale() {
    const currentPrice = activeBackendSku?.current_price ?? 24;
    const salePrice = Math.max(1, Math.round(currentPrice * 0.85 * 100) / 100);

    setBackendBusy(true);
    createBackendFlashSale(activeProduct.id, salePrice)
      .then((state) => {
        const backendActiveSkuId = getBackendActiveSkuId(state);

        setBackendState(state);
        setBackendError(null);

        if (backendActiveSkuId) {
          setActiveSkuId(backendActiveSkuId);
          setRoomActiveSku(backendActiveSkuId);
        }
      })
      .catch((error) => {
        setBackendError(
          error instanceof Error ? error.message : "Backend unavailable",
        );
      })
      .finally(() => setBackendBusy(false));
  }

  function formatBackendPayload(payload: Record<string, unknown>) {
    const entries = Object.entries(payload).map(([key, value]) => {
      if (typeof value === "number") {
        return `${key}: ${Number.isInteger(value) ? value : formatMoney(value)}`;
      }

      return `${key}: ${String(value)}`;
    });

    return entries.join(" · ");
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
              <StatusPill>
                Backend {backendState ? "connected" : "optional"}
              </StatusPill>
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
              {roomState.viewerMessages.map((chat) => (
                <div
                  className="rounded-md border border-teal-200 bg-teal-50 p-3"
                  key={chat.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-teal-700">
                      {chat.name}
                    </p>
                    <StatusPill tone="good">Synced</StatusPill>
                  </div>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {chat.text}
                  </p>
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
                    {activeShelfPrice} · {activeShelfStock} in stock
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
                    updateActiveSku(sku.id);
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
                    {backendState?.skus[sku.id]
                      ? `${formatMoney(backendState.skus[sku.id].current_price)} · ${
                          backendState.skus[sku.id].stock
                        } in stock`
                      : `${sku.price} · ${sku.stock} in stock`}
                  </span>
                </button>
              ))}
            </div>
          </Panel>
          <Panel title="AI Suggested Replies" eyebrow="Agent queue">
            <form
              className="mb-3 rounded-md border border-slate-200 bg-slate-50 p-3"
              onSubmit={handleSendHostReply}
            >
              <label
                className="text-xs font-semibold uppercase tracking-wide text-slate-500"
                htmlFor="host-reply"
              >
                Host reply
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  className="min-h-10 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                  id="host-reply"
                  onChange={(event) => setReplyInput(event.target.value)}
                  placeholder="Send a host reply to viewer"
                  value={replyInput}
                />
                <button
                  className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                  type="submit"
                >
                  Send reply
                </button>
              </div>
            </form>
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
                  {item.analysis ? (
                    <div className="mt-3 grid gap-2 rounded-md border border-amber-200 bg-white/70 p-3 text-xs text-slate-700">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <p>
                          <span className="font-semibold">Intent:</span>{" "}
                          {item.analysis.intent}
                        </p>
                        <p>
                          <span className="font-semibold">Decision:</span>{" "}
                          {item.analysis.decision}
                        </p>
                        <p>
                          <span className="font-semibold">Risk:</span>{" "}
                          {item.analysis.risk}
                        </p>
                        <p>
                          <span className="font-semibold">Confidence:</span>{" "}
                          {Math.round(item.analysis.confidence * 100)}%
                        </p>
                        <p>
                          <span className="font-semibold">SKU:</span>{" "}
                          {item.analysis.skuId ?? "Unresolved"}
                        </p>
                        <p>
                          <span className="font-semibold">Qty:</span>{" "}
                          {item.analysis.orderQuantity ?? "n/a"}
                        </p>
                      </div>
                      <p className="leading-5">
                        <span className="font-semibold">Reason:</span>{" "}
                        {item.analysis.reason}
                      </p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>
        </div>
        <div className="grid gap-4">
          <Panel title="Agent Event Timeline" eyebrow="Commerce ledger">
            <div className="space-y-3">
              {backendState?.event_ledger
                .slice()
                .reverse()
                .map((event) => (
                  <div
                    className="border-l-2 border-sky-500 pl-3"
                    key={event.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        Backend: {event.type}
                      </p>
                      <StatusPill tone="good">Backend</StatusPill>
                    </div>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      {formatBackendPayload(event.payload)}
                    </p>
                  </div>
                ))}
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
          <Panel title="Backend Commerce" eyebrow={getBackendBaseUrl()}>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusPill tone={backendState ? "good" : "warning"}>
                  {backendState ? "Connected" : "Waiting for backend"}
                </StatusPill>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
                    disabled={backendBusy}
                    onClick={handleRefreshBackend}
                    type="button"
                  >
                    Refresh
                  </button>
                  <button
                    className="min-h-9 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                    disabled={backendBusy}
                    onClick={handleCreateFlashSale}
                    type="button"
                  >
                    Create flash sale
                  </button>
                </div>
              </div>
              {backendError ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
                  {backendError}. Start FastAPI on port 8000 to enable backend
                  state.
                </p>
              ) : null}
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Active backend SKU
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {backendState?.active_sku_id
                    ? getBackendSkuName(backendState, backendState.active_sku_id)
                    : "No backend SKU listed"}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Current prices and stock
                </p>
                {backendState ? (
                  Object.values(backendState.skus).map((sku) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 p-3"
                      key={sku.id}
                    >
                      <p className="text-sm font-semibold text-slate-900">
                        {sku.name}
                      </p>
                      <p className="text-sm text-slate-600">
                        {formatMoney(sku.current_price)} · {sku.stock} in stock
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-600">No backend state yet.</p>
                )}
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                  Flash sale
                </p>
                {backendState?.flash_sale ? (
                  <div className="mt-2 text-sm leading-6 text-amber-900">
                    <p className="font-semibold">
                      {backendState.flash_sale.name} ·{" "}
                      {formatMoney(backendState.flash_sale.sale_price)}
                    </p>
                    <p>
                      {backendState.flash_sale.sold}/
                      {backendState.flash_sale.quantity} sold · ends in{" "}
                      {backendState.flash_sale.ends_in_seconds}s
                    </p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-amber-900">
                    No active backend flash sale.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Orders by SKU
                </p>
                {backendOrderGroups.length > 0 ? (
                  backendOrderGroups.map((group) => (
                    <div
                      className="grid gap-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-[1fr_auto_auto]"
                      key={group.skuId}
                    >
                      <p className="font-semibold text-slate-900">
                        {group.name}
                      </p>
                      <p className="text-slate-600">{group.units} units</p>
                      <p className="font-semibold text-slate-900">
                        {formatMoney(group.gmv)} GMV
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-600">
                    No backend orders yet.
                  </p>
                )}
              </div>
            </div>
          </Panel>
          <Panel title="Producer Report" eyebrow="Generated">
            <div className="space-y-4">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Listed SKUs
                </p>
                {producerReport.listedSkus.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {producerReport.listedSkus.map((sku) => (
                      <div
                        className="rounded-md border border-slate-200 bg-white p-2 text-sm"
                        key={sku.skuId}
                      >
                        <p className="font-semibold text-slate-900">
                          {sku.name}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          Evidence: {sku.sourceEvents.join(", ")}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-600">
                    No backend list_product or create_flash_sale events yet.
                  </p>
                )}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Units sold
                  </p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">
                    {producerReport.totalUnitsSold}
                  </p>
                </div>
                <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Total GMV
                  </p>
                  <p className="mt-1 text-lg font-semibold text-slate-900">
                    {formatMoney(producerReport.totalGmv)}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Per-product KPI
                </p>
                {producerReport.perProduct.length > 0 ? (
                  producerReport.perProduct.map((item) => (
                    <div
                      className="grid gap-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-[1fr_auto_auto]"
                      key={item.skuId}
                    >
                      <p className="font-semibold text-slate-900">
                        {item.name}
                      </p>
                      <p className="text-slate-600">{item.units} units</p>
                      <p className="font-semibold text-slate-900">
                        {formatMoney(item.gmv)} GMV
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-600">
                    No backend order KPIs yet.
                  </p>
                )}
              </div>

              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                  Flash-sale sell-through
                </p>
                {producerReport.flashSaleSellThrough ? (
                  <p className="mt-2 text-sm leading-6 text-amber-900">
                    {producerReport.flashSaleSellThrough.label}:{" "}
                    {producerReport.flashSaleSellThrough.sold}/
                    {producerReport.flashSaleSellThrough.quantity} sold (
                    {producerReport.flashSaleSellThrough.percent}%)
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-amber-900">
                    No active backend flash sale.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Questions handled
                </p>
                {producerReport.questionsHandled.length > 0 ? (
                  producerReport.questionsHandled.slice(0, 5).map((question) => (
                    <p
                      className="rounded-md border border-slate-200 bg-slate-50 p-2 text-sm leading-6 text-slate-700"
                      key={question}
                    >
                      {question}
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-slate-600">
                    No product questions handled yet.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Risk events
                </p>
                {producerReport.riskEvents.length > 0 ? (
                  producerReport.riskEvents.slice(0, 5).map((event) => (
                    <p
                      className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm leading-6 text-amber-900"
                      key={event}
                    >
                      {event}
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-slate-600">
                    No risk events recorded yet.
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Host learning
                </p>
                {producerReport.hostLearning.map((item) => (
                  <p
                    className="rounded-md border border-slate-200 bg-slate-50 p-2 text-sm leading-6 text-slate-700"
                    key={item}
                  >
                    {item}
                  </p>
                ))}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Next recommendations
                </p>
                {producerReport.nextRecommendations.map((item) => (
                  <p
                    className="rounded-md border border-slate-200 bg-slate-50 p-2 text-sm leading-6 text-slate-700"
                    key={item}
                  >
                    {item}
                  </p>
                ))}
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}
