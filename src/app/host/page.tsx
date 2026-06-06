"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  type SkuId,
  commerceCatalogue,
  defaultActiveSkuId,
  getActiveSkuDisplay,
  resolveSkuById,
  resolveSkuFromText,
} from "@/lib/catalogue";
import {
  appendAgentReply,
  appendHostReply,
  defaultLocalRoomState,
  type LocalRoomState,
  readLocalRoomState,
  resetLocalRoomState,
  setHostMediaSession,
  setRoomActiveSku,
  subscribeToLocalRoom,
} from "@/lib/local-room";
import {
  type BackendState,
  type CoHostDebugMessage,
  type MonitorSignalPayload,
  type PendingAction,
  type ViewerComment,
  type ViewerInsightSnapshot,
  type WorkflowResponse,
  approvePendingAction,
  assessViewerQuestionAnswered,
  createMediaSession,
  exchangeRealtimeTranscriptionOffer,
  fetchBackendState,
  fetchCoHostDebugMessages,
  fetchLiveMetrics,
  fetchMediaSession,
  generateViewerWordCloud,
  getBackendUrl,
  postIceCandidate,
  postMediaOffer,
  rejectPendingAction,
  resetBackendState,
  sendEditedPendingReply,
  sendHostCommand,
  sendHostTranscript,
  stopMediaSession,
} from "@/lib/livecrew-api";
import { type FormEvent, useEffect, useRef, useState } from "react";

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

type HostInputTrace = {
  id: string;
  timestamp: number;
  text: string;
  source: "speech_transcript" | "typed_command";
  matchedEntity: string | null;
};

type LiveTranscriptLine = {
  id: string;
  text: string;
  status: "final" | "error";
};

type RealtimeTranscriptionEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  event_id?: string;
  error?: {
    message?: string;
  };
};

type AgentRole =
  | "Input"
  | "Co-Host"
  | "Concierge"
  | "Guardrail"
  | "Commerce"
  | "System";

type AgentFlowStepKind =
  | "input"
  | "intent"
  | "routing"
  | "tool"
  | "decision"
  | "action"
  | "reflection";

type AgentFlowNodeState = "done" | "active" | "waiting";

type AgentFlowNode = {
  id: string;
  role: AgentRole;
  stepKind: AgentFlowStepKind;
  label: string;
  detail: string;
  metric?: string;
  state: AgentFlowNodeState;
};

type AgentFlowModel = {
  title: string;
  summary: string;
  modeLabel: string;
  nodes: AgentFlowNode[];
};

type AgentFlowNodeDraft = Omit<AgentFlowNode, "state">;

type QueuedViewerComment = ViewerComment & {
  frequency: number;
  groupedCommentIds: string[];
  isProductRelated: boolean;
};

const initialLedger: LedgerEvent[] = [
  {
    id: "evt-initial-001",
    label: "Backend expected",
    detail: "Start the Python backend on port 8000 before running CoHost Agent flows.",
    status: "watching",
  },
];

const boundedScrollAreaClass =
  "max-h-96 space-y-3 overflow-y-scroll pr-2 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300";
const ledgerScrollAreaClass =
  "min-h-72 max-h-96 space-y-3 overflow-y-auto pr-2 [scrollbar-gutter:stable] xl:min-h-0 xl:max-h-none xl:flex-1 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300";

function formatPrice(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function getValidSkuId(value: string | null | undefined): SkuId {
  return (resolveSkuById(value)?.id ?? defaultActiveSkuId) as SkuId;
}

function getActiveStockInputValue(state: BackendState) {
  const sku = state.skus.find((stateSku) => stateSku.id === state.active_sku_id);
  return sku ? String(sku.stock) : "";
}

function splitTopChatIntents(value: string | undefined) {
  if (!value || value === "none") {
    return [];
  }

  return value
    .split(",")
    .map((intent) => intent.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function topChatIntentsFromMetrics(metrics: MonitorSignalPayload | null) {
  if (!metrics?.intent_distribution) {
    return [];
  }

  return Object.entries(metrics.intent_distribution)
    .filter(([, count]) => count > 0)
    .sort((first, second) => second[1] - first[1])
    .slice(0, 3)
    .map(([intent, count], index) => `Top${index + 1} ${intent.replaceAll("_", " ")} (${count})`);
}

function summarizeLiveMonitor(metrics: MonitorSignalPayload | null) {
  if (!metrics) {
    return null;
  }

  const purchaseIntentCount = metrics.intent_distribution?.purchase_intent ?? 0;
  if (
    metrics.gpm_cents > 0 ||
    metrics.conversion_rate > 0 ||
    purchaseIntentCount > 0
  ) {
    return {
      scenarioLabel: "Order momentum",
      hookLabel: "Order push",
      urgency: "high" as const,
      reason:
        "Live orders or purchase intent are visible in the last minute; keep checkout and inventory cues clear.",
      script:
        "Orders are coming in now. If you want this item, use the product card and check out while the current stock is still available.",
      hostCue:
        "Viewer purchase activity is active. Reinforce the buying path and current inventory.",
    };
  }

  return null;
}

const monitorMetricHelp: Record<string, string> = {
  Viewers: "Active viewers seen recently.",
  GPM: "Gross merchandise value from recent backend orders.",
  Conversion: "Recent orders divided by active viewers.",
  "High intent": "Buying-intent chat or order events per minute.",
  Backlog: "Most repeated product or buying question.",
  Interaction: "Recent chat and like activity per active viewer.",
  Source: "Whether Monitor used rules or OpenAI.",
};

function formatHostLiveMetric(
  metrics: MonitorSignalPayload | null,
  key:
    | "online_viewers"
    | "gpm"
    | "conversion_rate"
    | "high_intent_density"
    | "question_backlog"
    | "interaction_rate",
  fallback: string | undefined,
) {
  if (!metrics) {
    return fallback ?? "-";
  }

  if (key === "online_viewers") {
    return `${metrics.online_viewers.toLocaleString()} (${metrics.online_viewers_delta.toFixed(1)}%)`;
  }
  if (key === "gpm") {
    return `$${Math.round(metrics.gpm_cents / 100)} (${metrics.gpm_delta.toFixed(1)}%)`;
  }
  if (key === "conversion_rate") {
    return `${metrics.conversion_rate.toFixed(1)}% (${metrics.conversion_rate_delta.toFixed(1)}%)`;
  }
  if (key === "high_intent_density") {
    return `${metrics.high_intent_density.toFixed(0)}/min`;
  }
  if (key === "question_backlog") {
    return metrics.top_question && metrics.top_question_count > 0
      ? `${metrics.top_question_count}x ${metrics.top_question}`
      : "none";
  }
  return `${metrics.interaction_rate.toFixed(1)}%`;
}

function normalizeChatText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function getCommentCreatedAt(comment: ViewerComment) {
  const createdAt = new Date(comment.created_at).getTime();
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

function dedupeViewerComments(
  comments: ViewerComment[],
  activeSkuId: string | null | undefined,
  activeSkuName: string,
  activeSkuAliases: string[],
) {
  const productTerms = [activeSkuName, ...activeSkuAliases]
    .map(normalizeChatText)
    .filter((term) => term.length >= 3);
  const normalizedActiveSkuId = activeSkuId ?? null;
  const groupedComments = comments.reduce<Record<string, QueuedViewerComment>>(
    (groups, comment) => {
      const key = normalizeChatText(comment.text);
      const existingComment = groups[key];
      const matchedSku = resolveSkuFromText(comment.text);
      const isProductRelated =
        (normalizedActiveSkuId !== null && comment.sku_id === normalizedActiveSkuId) ||
        (normalizedActiveSkuId !== null && matchedSku?.id === normalizedActiveSkuId) ||
        productTerms.some((term) => key.includes(term));

      if (!existingComment) {
        groups[key] = {
          ...comment,
          frequency: 1,
          groupedCommentIds: [comment.id],
          isProductRelated,
        };
        return groups;
      }

      const commentIsNewer =
        getCommentCreatedAt(comment) > getCommentCreatedAt(existingComment);
      groups[key] = {
        ...(commentIsNewer ? comment : existingComment),
        frequency: existingComment.frequency + 1,
        groupedCommentIds: [...existingComment.groupedCommentIds, comment.id],
        isProductRelated: existingComment.isProductRelated || isProductRelated,
      };
      return groups;
    },
    {},
  );

  return Object.values(groupedComments).sort((first, second) => {
    if (first.isProductRelated !== second.isProductRelated) {
      return first.isProductRelated ? -1 : 1;
    }
    if (first.frequency !== second.frequency) {
      return second.frequency - first.frequency;
    }
    return getCommentCreatedAt(second) - getCommentCreatedAt(first);
  });
}

function fallbackHostCueForQuestion(comment: QueuedViewerComment) {
  if (comment.intent === "create_order") {
    return "Host cue: this looks like an order request. Confirm the SKU, quantity, and checkout path before treating it as handled.";
  }
  if (comment.intent === "suggest_reply" || comment.intent === "product_facts") {
    return "Suggested line: Let me answer that from what we have confirmed today, then I will point you to the product card if it is available.";
  }
  return "Suggested line: I see this question. Let me answer it live based on confirmed product information; if we do not have it today, I will suggest the closest available option or ask viewers to follow for restock updates.";
}

function ledgerFromWorkflow(response: WorkflowResponse): LedgerEvent[] {
  return response.ledger_entries
    .filter((entry) => entry.type !== "noop")
    .map((entry) => ({
      id: entry.id,
      label: entry.type.replaceAll("_", " "),
      detail: entry.detail,
      status: entry.type.includes("block")
        ? "blocked"
        : entry.type === "host_confirmation_requested"
          ? "pending"
          : "complete",
    }));
}

function formatActionName(type: string) {
  return type.replaceAll("_", " ");
}

function describePendingAction(pending: PendingAction, state: BackendState | null) {
  const { action } = pending;
  const skuName =
    state?.skus.find((sku) => sku.id === action.sku_id)?.name ?? action.sku_id;
  const details = [
    pending.guardrail_result.reason,
    skuName ? `SKU: ${skuName}` : null,
    action.price_cents ? `Price: ${formatPrice(action.price_cents)}` : null,
    action.stock !== null && action.stock !== undefined
      ? `Stock: ${action.stock}`
      : null,
    action.sale_price_cents
      ? `Flash sale: ${formatPrice(action.sale_price_cents)}`
      : null,
    action.stock_limit ? `Limit: ${action.stock_limit}` : null,
    action.duration_seconds ? `Duration: ${action.duration_seconds}s` : null,
  ].filter(Boolean);

  return details.join(" · ");
}

function clampText(value: string | null | undefined, fallback = "No detail") {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function inferMatchedSkuName(text: string, state: BackendState | null) {
  const normalized = text.toLowerCase();
  return (
    state?.skus.find((sku) =>
      [sku.name, ...sku.aliases].some((name) =>
        normalized.includes(name.toLowerCase()),
      ),
    )?.name ?? null
  );
}

function actionLabel(actionType: string | null | undefined) {
  if (!actionType || actionType === "noop") {
    return "No action";
  }
  return actionType.replaceAll("_", " ");
}

function toolLabelForAction(actionType: string | null | undefined) {
  if (actionType === "create_order") {
    return "check_stock + place_order";
  }
  if (actionType === "suggest_reply") {
    return "get_product_facts";
  }
  if (
    actionType === "set_active_sku" ||
    actionType === "update_price" ||
    actionType === "update_stock"
  ) {
    return actionType;
  }
  if (actionType === "create_flash_sale") {
    return "create_flash_sale";
  }
  if (actionType === "request_host_confirmation") {
    return "validate_claims";
  }
  return "resolve_context";
}

function withFlowStates(
  nodesWithoutState: AgentFlowNodeDraft[],
  activeIndex: number,
): AgentFlowNode[] {
  return nodesWithoutState.map((node, index) => ({
    ...node,
    state:
      index < activeIndex ? "done" : index === activeIndex ? "active" : "waiting",
  }));
}

function buildViewerEscalationFlow(
  pending: PendingAction,
  state: BackendState | null,
): AgentFlowModel {
  const skuName =
    state?.skus.find((sku) => sku.id === pending.action.sku_id)?.name ??
    pending.action.sku_id ??
    "No resolved context";
  const nodes = withFlowStates(
    [
      {
        id: "viewer-input",
        role: "Input",
        stepKind: "input",
        label: pending.action.viewer ?? "viewer",
        detail: clampText(pending.action.source_text),
      },
      {
        id: "viewer-intent",
        role: "Concierge",
        stepKind: "intent",
        label: "Risk request",
        detail: clampText(pending.action.reason, "Needs host review"),
        metric: `${Math.round(pending.action.confidence * 100)}%`,
      },
      {
        id: "viewer-routing",
        role: "Guardrail",
        stepKind: "routing",
        label: "Escalate",
        detail: `Context: ${skuName}`,
      },
      {
        id: "viewer-tool",
        role: "Guardrail",
        stepKind: "tool",
        label: "validate_claims",
        detail: "Discount, safety, and unsupported claims checked.",
      },
      {
        id: "viewer-decision",
        role: "Guardrail",
        stepKind: "decision",
        label: "Host review",
        detail: pending.guardrail_result.reason,
      },
      {
        id: "viewer-action",
        role: "Concierge",
        stepKind: "action",
        label: "Draft reply",
        detail: clampText(pending.action.reply_text, "Waiting for host action"),
      },
      {
        id: "viewer-reflection",
        role: "System",
        stepKind: "reflection",
        label: "Trace",
        detail: "Pending action is stored in backend state.",
      },
    ],
    5,
  );

  return {
    title: "Viewer escalation flow",
    summary: "Concierge drafted a guarded reply and routed it to host review.",
    modeLabel: "Live state",
    nodes,
  };
}

function buildViewerMessageFlow(
  roomState: LocalRoomState,
  state: BackendState | null,
): AgentFlowModel | null {
  const latestMessage = roomState.viewerMessages.at(-1);
  if (!latestMessage) {
    return null;
  }
  const relatedReply = [...roomState.replies]
    .reverse()
    .find((reply) => reply.createdAt >= latestMessage.createdAt);
  const skuName =
    inferMatchedSkuName(latestMessage.text, state) ??
    (state?.active_sku_id
      ? state.skus.find((sku) => sku.id === state.active_sku_id)?.name
      : null);
  const hasReply = Boolean(relatedReply);
  const looksRisky = /\b(discount|promo|allergy|heart|skin|health|rash)\b/i.test(
    latestMessage.text,
  );
  const nodes = withFlowStates(
    [
      {
        id: "viewer-input",
        role: "Input",
        stepKind: "input",
        label: latestMessage.name,
        detail: clampText(latestMessage.text),
      },
      {
        id: "viewer-intent",
        role: "Concierge",
        stepKind: "intent",
        label: looksRisky ? "Risk sensitive" : "Viewer question",
        detail: looksRisky ? "Policy-sensitive wording detected." : "Message ready for reply analysis.",
      },
      {
        id: "viewer-context",
        role: "Concierge",
        stepKind: "routing",
        label: skuName ? "SKU context" : "No context",
        detail: skuName ?? "No resolved product context",
      },
      {
        id: "viewer-tool",
        role: looksRisky ? "Guardrail" : "Concierge",
        stepKind: "tool",
        label: looksRisky ? "validate_claims" : "get_product_facts",
        detail: looksRisky ? "Guardrail checks claim risk." : "Catalogue facts are the source.",
      },
      {
        id: "viewer-decision",
        role: looksRisky ? "Guardrail" : "Concierge",
        stepKind: "decision",
        label: hasReply ? "Reply ready" : "Awaiting result",
        detail: hasReply
          ? clampText(relatedReply?.text)
          : "No reply or escalation has been recorded yet.",
      },
      {
        id: "viewer-action",
        role: hasReply ? "Concierge" : "System",
        stepKind: "action",
        label: hasReply ? "Reply sent" : "No action yet",
        detail: hasReply ? "Viewer room received agent reply." : "Waiting for backend response.",
      },
      {
        id: "viewer-reflection",
        role: "System",
        stepKind: "reflection",
        label: "Trace",
        detail: "Derived from viewer room messages and backend state.",
      },
    ],
    hasReply ? 6 : 4,
  );

  return {
    title: "Viewer message flow",
    summary: "Latest viewer message is mapped through Concierge and guardrails.",
    modeLabel: "Live state",
    nodes,
  };
}

function buildHostInputFlow(
  trace: HostInputTrace,
  queueItems: QueueItem[],
  state: BackendState | null,
): AgentFlowModel {
  const latestQueue = queueItems[0];
  const latestLedger = state?.ledger[0];
  const matchedSku = trace.matchedEntity ?? inferMatchedSkuName(trace.text, state);
  const actionType = latestLedger?.payload?.action;
  const ledgerActionType =
    typeof actionType === "object" && actionType && "type" in actionType
      ? String(actionType.type)
      : latestQueue?.title;
  const activeIndex = latestLedger ? 6 : latestQueue ? 5 : 3;

  return {
    title: "Host input flow",
    summary:
      trace.source === "speech_transcript"
        ? "Final transcript entered the CoHost Agent workflow."
        : "Typed command entered the CoHost Agent workflow.",
    modeLabel: trace.source === "speech_transcript" ? "Transcript" : "Command",
    nodes: withFlowStates(
      [
        {
          id: "host-input",
          role: "Input",
          stepKind: "input",
          label: trace.source === "speech_transcript" ? "Speech" : "Typed command",
          detail: clampText(trace.text),
        },
        {
          id: "host-intent",
          role: "Co-Host",
          stepKind: "intent",
          label: matchedSku ? "Product command" : "Host command",
          detail: matchedSku ? `Matched ${matchedSku}` : "Intent parsed from host input.",
        },
        {
          id: "host-routing",
          role: "Co-Host",
          stepKind: "routing",
          label: "Route to CoHost",
          detail: "Host operations route owns shelf and promo actions.",
        },
        {
          id: "host-tool",
          role: "Commerce",
          stepKind: "tool",
          label: toolLabelForAction(ledgerActionType),
          detail: matchedSku ? `Context: ${matchedSku}` : "Use current backend state.",
        },
        {
          id: "host-decision",
          role: "Guardrail",
          stepKind: "decision",
          label: latestQueue?.status ?? "Decision ready",
          detail: latestQueue?.detail ?? "Waiting for structured action.",
        },
        {
          id: "host-action",
          role: "Commerce",
          stepKind: "action",
          label: latestLedger ? actionLabel(latestLedger.type) : "Pending action",
          detail: latestLedger?.detail ?? "No visible state update yet.",
        },
        {
          id: "host-reflection",
          role: "System",
          stepKind: "reflection",
          label: "Ledger",
          detail: latestLedger ? "Backend ledger recorded the result." : "Awaiting ledger event.",
        },
      ],
      activeIndex,
    ),
  };
}

function buildFlashSaleFlow(state: BackendState): AgentFlowModel | null {
  if (!state.flash_sale) {
    return null;
  }
  const sku = state.skus.find((item) => item.id === state.flash_sale?.sku_id);
  return {
    title: "Flash sale flow",
    summary: "Active backend campaign state is being tracked by commerce.",
    modeLabel: "Commerce",
    nodes: withFlowStates(
      [
        {
          id: "flash-input",
          role: "Input",
          stepKind: "input",
          label: "Campaign state",
          detail: sku?.name ?? state.flash_sale.sku_id,
        },
        {
          id: "flash-intent",
          role: "Co-Host",
          stepKind: "intent",
          label: "Promo active",
          detail: `${formatPrice(state.flash_sale.sale_price_cents)} flash price`,
        },
        {
          id: "flash-route",
          role: "Commerce",
          stepKind: "routing",
          label: "Commerce state",
          detail: "Flash sale is stored in backend state.",
        },
        {
          id: "flash-tool",
          role: "Commerce",
          stepKind: "tool",
          label: "create_flash_sale",
          detail: `${state.flash_sale.remaining_stock}/${state.flash_sale.stock_limit} sale units left`,
        },
        {
          id: "flash-action",
          role: "Commerce",
          stepKind: "action",
          label: "Shelf updated",
          detail: `Duration ${state.flash_sale.duration_seconds}s`,
        },
        {
          id: "flash-reflection",
          role: "System",
          stepKind: "reflection",
          label: "Ledger",
          detail: "Producer report will read flash-sale ledger events.",
        },
      ],
      4,
    ),
  };
}

function buildIdleFlow(
  backendStatus: "checking" | "online" | "offline",
  streamStatus: "offline" | "starting" | "live",
): AgentFlowModel {
  return {
    title: "Idle workflow",
    summary: "No recent agent event is active. The system is ready for input.",
    modeLabel: "Idle",
    nodes: withFlowStates(
      [
        {
          id: "idle-input",
          role: "Input",
          stepKind: "input",
          label: streamStatus === "live" ? "Listening" : "Ready",
          detail: `Backend ${backendStatus}; stream ${streamStatus}.`,
        },
        {
          id: "idle-intent",
          role: "System",
          stepKind: "intent",
          label: "Intent ready",
          detail: "Waiting for viewer message, host transcript, or command.",
        },
        {
          id: "idle-route",
          role: "System",
          stepKind: "routing",
          label: "Routing ready",
          detail: "Next input will route to the matching agent.",
        },
        {
          id: "idle-tool",
          role: "System",
          stepKind: "tool",
          label: "Tools ready",
          detail: "Catalogue, guardrails, and commerce state are available.",
        },
        {
          id: "idle-decision",
          role: "System",
          stepKind: "decision",
          label: "Decision ready",
          detail: "No action proposed.",
        },
      ],
      0,
    ),
  };
}

function buildAgentFlow({
  backendState,
  roomState,
  hostInputTrace,
  queueItems,
  backendStatus,
  streamStatus,
}: {
  backendState: BackendState | null;
  roomState: LocalRoomState;
  hostInputTrace: HostInputTrace | null;
  queueItems: QueueItem[];
  backendStatus: "checking" | "online" | "offline";
  streamStatus: "offline" | "starting" | "live";
}): AgentFlowModel {
  const pendingConciergeEscalation = backendState?.pending_actions.find(
    (pending) =>
      pending.status === "pending" &&
      pending.requested_by === "concierge" &&
      pending.action.type === "suggest_reply",
  );
  if (pendingConciergeEscalation) {
    return buildViewerEscalationFlow(pendingConciergeEscalation, backendState);
  }

  const latestViewerMessage = roomState.viewerMessages.at(-1);
  const latestViewerTime = latestViewerMessage?.createdAt ?? 0;
  const latestHostTime = hostInputTrace?.timestamp ?? 0;
  if (latestViewerMessage && latestViewerTime >= latestHostTime) {
    const viewerFlow = buildViewerMessageFlow(roomState, backendState);
    if (viewerFlow) {
      return viewerFlow;
    }
  }

  if (hostInputTrace) {
    return buildHostInputFlow(hostInputTrace, queueItems, backendState);
  }

  if (backendState) {
    const flashSaleFlow = buildFlashSaleFlow(backendState);
    if (flashSaleFlow) {
      return flashSaleFlow;
    }
  }

  return buildIdleFlow(backendStatus, streamStatus);
}

const roleToneClass: Record<AgentRole, string> = {
  Input: "border-slate-200 bg-slate-50 text-slate-700",
  "Co-Host": "border-teal-200 bg-teal-50 text-teal-800",
  Concierge: "border-indigo-200 bg-indigo-50 text-indigo-800",
  Guardrail: "border-amber-200 bg-amber-50 text-amber-800",
  Commerce: "border-emerald-200 bg-emerald-50 text-emerald-800",
  System: "border-slate-200 bg-white text-slate-600",
};

const stepMarkerClass: Record<AgentFlowStepKind, string> = {
  input: "rounded-md",
  intent: "rotate-45 rounded-sm",
  routing: "rounded-full",
  tool: "[clip-path:polygon(25%_0%,75%_0%,100%_50%,75%_100%,25%_100%,0%_50%)]",
  decision: "rotate-45 rounded-sm",
  action: "rounded-md",
  reflection: "rounded-full px-4",
};

function AgentFlowPanel({ flow }: { flow: AgentFlowModel }) {
  const activeNode =
    flow.nodes.find((node) => node.state === "active") ??
    flow.nodes[flow.nodes.length - 1];
  const completedCount = flow.nodes.filter((node) => node.state === "done").length;
  const roles = Array.from(new Set(flow.nodes.map((node) => node.role)));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-950">{flow.title}</p>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-slate-600">
            {flow.summary}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {roles.map((role) => (
            <span
              className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${roleToneClass[role]}`}
              key={role}
            >
              {role}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="flex h-full min-w-max items-stretch gap-3">
          {flow.nodes.map((node, index) => {
            const stateClass =
              node.state === "active"
                ? "border-teal-400 bg-white shadow-sm ring-2 ring-teal-100"
                : node.state === "done"
                  ? "border-slate-200 bg-white"
                  : "border-slate-200 bg-white/60 opacity-60";
            const markerClass = stepMarkerClass[node.stepKind];

            return (
              <div className="flex items-center gap-3" key={node.id}>
                <div
                  className={`flex h-full w-44 shrink-0 flex-col rounded-md border p-3 ${stateClass}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${roleToneClass[node.role]}`}
                    >
                      {node.role}
                    </span>
                    <span className="text-[11px] font-semibold uppercase text-slate-400">
                      {node.state}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <span
                      className={`flex h-8 min-w-8 items-center justify-center border border-slate-300 bg-slate-100 text-[10px] font-bold uppercase text-slate-600 ${markerClass}`}
                    >
                      <span
                        className={
                          node.stepKind === "intent" || node.stepKind === "decision"
                            ? "-rotate-45"
                            : ""
                        }
                      >
                        {node.stepKind.slice(0, 2)}
                      </span>
                    </span>
                    <p className="truncate text-xs font-semibold uppercase text-slate-500">
                      {node.stepKind}
                    </p>
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm font-semibold leading-5 text-slate-950">
                    {node.label}
                  </p>
                  <p className="mt-2 line-clamp-4 text-xs leading-5 text-slate-600">
                    {node.detail}
                  </p>
                  {node.metric ? (
                    <p className="mt-auto pt-2 text-xs font-semibold text-teal-700">
                      {node.metric}
                    </p>
                  ) : null}
                </div>
                {index < flow.nodes.length - 1 ? (
                  <span className="text-xl font-semibold text-slate-300">-&gt;</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-4">
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <span className="block font-semibold text-slate-500">Current flow</span>
          <span className="mt-1 block truncate text-slate-950">{flow.modeLabel}</span>
        </div>
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <span className="block font-semibold text-slate-500">Active node</span>
          <span className="mt-1 block truncate text-slate-950">
            {activeNode?.label ?? "None"}
          </span>
        </div>
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <span className="block font-semibold text-slate-500">Completed</span>
          <span className="mt-1 block text-slate-950">
            {completedCount}/{flow.nodes.length}
          </span>
        </div>
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <span className="block font-semibold text-slate-500">Trace source</span>
          <span className="mt-1 block truncate text-slate-950">Live state</span>
        </div>
      </div>
    </div>
  );
}

export default function HostPage() {
  const [commandInput, setCommandInput] = useState(
    "Switch to the Bamboo Thermal Tumbler.",
  );
  const [activeSkuId, setActiveSkuId] = useState<SkuId>(defaultActiveSkuId);
  const [backendState, setBackendState] = useState<BackendState | null>(null);
  const [backendStatus, setBackendStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEvent[]>(initialLedger);
  const [roomState, setRoomState] =
    useState<LocalRoomState>(defaultLocalRoomState);
  const [hostLiveMetrics, setHostLiveMetrics] =
    useState<MonitorSignalPayload | null>(null);
  const [replyInput, setReplyInput] = useState("");
  const [stockInput, setStockInput] = useState(
    String(getActiveSkuDisplay(defaultActiveSkuId).stock),
  );
  const [stockSaving, setStockSaving] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([
    {
      id: "queue-initial",
      title: "Waiting for CoHost Agent",
      detail: "Submit a typed command or speak live to call the Python CoHost Agent workflow.",
      status: "Review",
    },
  ]);
  const [mediaSessionId, setMediaSessionId] = useState<string | null>(null);
  const [hostInputTrace, setHostInputTrace] = useState<HostInputTrace | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "offline" | "starting" | "live"
  >("offline");
  const [mediaError, setMediaError] = useState("");
  const [resolvingActionId, setResolvingActionId] = useState<string | null>(null);
  const [liveTranscriptLines, setLiveTranscriptLines] = useState<
    LiveTranscriptLine[]
  >([]);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [liveTranscriptStatus, setLiveTranscriptStatus] = useState<
    "idle" | "connecting" | "listening" | "unsupported" | "error"
  >("idle");
  const [editedEscalationReplies, setEditedEscalationReplies] = useState<
    Record<string, string>
  >({});
  const [interactionDraftReplies, setInteractionDraftReplies] = useState<
    Record<string, string>
  >({});
  const [liveTranscriptError, setLiveTranscriptError] = useState("");
  const [debugMessagesVisible, setDebugMessagesVisible] = useState(false);
  const [debugMessagesLoading, setDebugMessagesLoading] = useState(false);
  const [debugMessagesError, setDebugMessagesError] = useState("");
  const [cohostDebugMessages, setCohostDebugMessages] = useState<
    CoHostDebugMessage[]
  >([]);
  const [wordCloudRefreshing, setWordCloudRefreshing] = useState(false);
  const [viewerMonitorError, setViewerMonitorError] = useState("");
  const [latestInsight, setLatestInsight] =
    useState<ViewerInsightSnapshot | null>(null);
  const [resolvedDraftIds, setResolvedDraftIds] = useState<string[]>([]);
  const [resolvingDraftIds, setResolvingDraftIds] = useState<string[]>([]);
  const [activeInteractionCueIds, setActiveInteractionCueIds] = useState<string[]>(
    [],
  );
  const [deferredInteractionCueIds, setDeferredInteractionCueIds] = useState<
    string[]
  >([]);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const viewerPeersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const transcriptionPeerRef = useRef<RTCPeerConnection | null>(null);
  const transcriptionDataChannelRef = useRef<RTCDataChannel | null>(null);
  const completedTranscriptIdsRef = useRef<Set<string>>(new Set());
  const answerPollRef = useRef<number | null>(null);
  const viewerCandidateCountsRef = useRef<Map<string, number>>(new Map());
  const refreshViewerWordCloudRef = useRef<() => Promise<void>>(async () => {});

  const activeProduct = getActiveSkuDisplay(activeSkuId);
  const backendActiveSku = backendState?.skus.find(
    (sku) => sku.id === backendState.active_sku_id,
  );
  const conciergeEscalations =
    backendState?.pending_actions.filter(
      (pending) =>
        pending.status === "pending" &&
        pending.requested_by === "concierge" &&
        pending.action.type === "suggest_reply",
    ) ?? [];
  const pendingConfirmations =
    backendState?.pending_actions.filter(
      (pending) =>
        pending.status === "pending" &&
        pending.action.type !== "noop" &&
        !(
          pending.requested_by === "concierge" &&
          pending.action.type === "suggest_reply"
        ),
    ) ??
    [];
  const queuedViewerComments = dedupeViewerComments(
    backendState?.viewer_comments.filter(
      (comment) =>
        comment.reply_status !== "suggested" &&
        !resolvedDraftIds.includes(comment.id),
    ) ?? [],
    backendState?.active_sku_id ?? activeSkuId,
    backendActiveSku?.name ?? activeProduct.name,
    backendActiveSku?.aliases ?? activeProduct.aliases,
  );
  const activeInteractionCue =
    activeInteractionCueIds.length > 0
      ? queuedViewerComments.find((comment) =>
          comment.groupedCommentIds.some((id) =>
            activeInteractionCueIds.includes(id),
          ),
        ) ?? null
      : [...queuedViewerComments]
          .filter(
            (comment) =>
              !comment.groupedCommentIds.some((id) =>
                deferredInteractionCueIds.includes(id),
              ),
          )
          .sort(
            (first, second) =>
              getCommentCreatedAt(second) - getCommentCreatedAt(first),
          )[0] ?? null;
  const activeConciergeEscalation = activeInteractionCue
    ? conciergeEscalations.find(
        (pending) =>
          normalizeChatText(pending.action.source_text) ===
          normalizeChatText(activeInteractionCue.text),
      ) ?? null
    : null;
  const activeEscalationDraft =
    activeConciergeEscalation
      ? editedEscalationReplies[activeConciergeEscalation.id] ??
        activeConciergeEscalation.action.reply_text ??
        ""
      : activeInteractionCue
        ? interactionDraftReplies[activeInteractionCue.id] ??
          activeInteractionCue.suggested_reply ??
          fallbackHostCueForQuestion(activeInteractionCue)
        : "";
  const activeEscalationReason =
    activeConciergeEscalation?.guardrail_result.reason ??
    (activeInteractionCue
      ? "Host should answer this viewer question live or adopt the candidate response."
      : "No active viewer question needs host review.");
  const activeCueResolving =
    activeInteractionCue?.groupedCommentIds.some((id) =>
      resolvingDraftIds.includes(id),
    ) ?? false;
  const waitingViewerComments = queuedViewerComments.filter((comment) =>
    activeInteractionCue
      ? normalizeChatText(comment.text) !== normalizeChatText(activeInteractionCue.text)
      : true,
  );
  const recentViewerComments = waitingViewerComments;
  const activeInsight = latestInsight ?? backendState?.viewer_insights[0] ?? null;
  const agentFlow = buildAgentFlow({
    backendState,
    roomState,
    hostInputTrace,
    queueItems,
    backendStatus,
    streamStatus,
  });
  const liveMonitorSummary = summarizeLiveMonitor(hostLiveMetrics);
  const monitorDisplay = liveMonitorSummary
    ? {
        scenarioLabel: liveMonitorSummary.scenarioLabel,
        scenarioReason: liveMonitorSummary.reason,
        urgency: liveMonitorSummary.urgency,
        hookLabel: liveMonitorSummary.hookLabel,
        hostCue: liveMonitorSummary.hostCue,
        script: liveMonitorSummary.script,
        signals: roomState.monitorSignal?.signals ?? {},
      }
    : roomState.monitorSignal;
  const monitorTopIntents =
    topChatIntentsFromMetrics(hostLiveMetrics).length > 0
      ? topChatIntentsFromMetrics(hostLiveMetrics)
      : splitTopChatIntents(
          monitorDisplay?.signals.top_chat_intents ??
            monitorDisplay?.signals.top_chat_intent,
        );

  function closeViewerPeers() {
    viewerPeersRef.current.forEach((peer) => peer.close());
    viewerPeersRef.current.clear();
    viewerCandidateCountsRef.current.clear();
  }

  useEffect(() => {
    function syncRoomState() {
      const nextRoomState = readLocalRoomState();
      setRoomState(nextRoomState);
    }

    syncRoomState();
    void syncBackendState();
    void syncLiveMetrics();
    const unsubscribe = subscribeToLocalRoom(syncRoomState);
    const backendPollId = window.setInterval(() => {
      void syncBackendState();
    }, 3000);
    const metricsPollId = window.setInterval(() => {
      void syncLiveMetrics();
    }, 3000);
    const initialWordCloudId = window.setTimeout(() => {
      void refreshViewerWordCloudRef.current();
    }, 5000);
    const wordCloudIntervalId = window.setInterval(() => {
      void refreshViewerWordCloudRef.current();
    }, 60000);

    return () => {
      window.clearInterval(backendPollId);
      window.clearInterval(metricsPollId);
      window.clearTimeout(initialWordCloudId);
      window.clearInterval(wordCloudIntervalId);
      if (answerPollRef.current) {
        window.clearInterval(answerPollRef.current);
      }
      unsubscribe();
      stopRealtimeTranscription();
      closeViewerPeers();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function syncBackendState() {
    try {
      const state = await fetchBackendState();
      setBackendState(state);
      setBackendStatus("online");
      setStockInput(getActiveStockInputValue(state));
      const nextSkuId = getValidSkuId(state.active_sku_id);
      setActiveSkuId(nextSkuId);
      if (readLocalRoomState().activeSkuId !== nextSkuId) {
        setRoomActiveSku(nextSkuId);
      }
      setViewerMonitorError("");
    } catch {
      setBackendStatus("offline");
    }
  }

  async function syncLiveMetrics() {
    try {
      const metrics = await fetchLiveMetrics();
      setHostLiveMetrics(metrics);
    } catch {
      setHostLiveMetrics(null);
    }
  }

  async function refreshViewerWordCloud() {
    setWordCloudRefreshing(true);
    try {
      const snapshot = await generateViewerWordCloud(180);
      setLatestInsight(snapshot);
      setViewerMonitorError("");
      await syncBackendState();
    } catch (error) {
      setViewerMonitorError(
        error instanceof Error
          ? error.message
          : "Viewer word cloud refresh failed.",
      );
    } finally {
      setWordCloudRefreshing(false);
    }
  }
  refreshViewerWordCloudRef.current = refreshViewerWordCloud;

  function appendLedger(event: LedgerEvent) {
    setLedgerEvents((currentEvents) => [
      {
        ...event,
        id: `${event.id}-${Date.now()}`,
      },
      ...currentEvents,
    ]);
  }

  function appendLiveTranscriptLine(text: string, status: LiveTranscriptLine["status"]) {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    setLiveTranscriptLines((currentLines) =>
      [
        {
          id: `transcript-${Date.now()}-${Math.random()}`,
          text: trimmedText,
          status,
        },
        ...currentLines,
      ].slice(0, 8),
    );
  }

  async function loadCoHostDebugMessages() {
    setDebugMessagesVisible(true);
    setDebugMessagesLoading(true);
    setDebugMessagesError("");
    try {
      const response = await fetchCoHostDebugMessages();
      setCohostDebugMessages(response.messages);
      setBackendStatus("online");
    } catch (error) {
      setDebugMessagesError(
        error instanceof Error ? error.message : "Unable to load CoHost messages.",
      );
      setBackendStatus("offline");
    } finally {
      setDebugMessagesLoading(false);
    }
  }

  async function processFinalSpeechTranscript(text: string) {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    appendLiveTranscriptLine(trimmedText, "final");
    setHostInputTrace({
      id: `host-speech-${Date.now()}`,
      timestamp: Date.now(),
      text: trimmedText,
      source: "speech_transcript",
      matchedEntity: inferMatchedSkuName(trimmedText, backendState),
    });
    if (
      activeInteractionCue
    ) {
      void assessViewerQuestionAnswered(activeInteractionCue.text, trimmedText)
        .then((assessment) => {
          if (assessment.answered) {
            handleMarkInteractionAnswered(activeInteractionCue.groupedCommentIds);
          }
        })
        .catch(() => {
          appendLedger({
            id: "evt-answer-assessment-error",
            label: "Answer assessment failed",
            detail: "OpenAI could not determine whether the host answered the viewer question.",
            status: "blocked",
          });
        });
    }
    try {
      const response = await sendHostTranscript(trimmedText);
      applyWorkflowResponse(response);
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : "Backend transcript event failed.";
      appendLiveTranscriptLine(detail, "error");
      appendLedger({
        id: "evt-transcript-error",
        label: "Transcript failed",
        detail,
        status: "blocked",
      });
      setBackendStatus("offline");
    }
  }

  function stopRealtimeTranscription() {
    transcriptionDataChannelRef.current?.close();
    transcriptionDataChannelRef.current = null;
    transcriptionPeerRef.current?.close();
    transcriptionPeerRef.current = null;
    completedTranscriptIdsRef.current.clear();
    setInterimTranscript("");
    setLiveTranscriptStatus("idle");
  }

  function handleRealtimeTranscriptionEvent(event: RealtimeTranscriptionEvent) {
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      setInterimTranscript((currentText) => `${currentText}${event.delta ?? ""}`);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const eventId = event.item_id ?? event.event_id ?? event.transcript ?? "";
      if (eventId && completedTranscriptIdsRef.current.has(eventId)) {
        return;
      }
      if (eventId) {
        completedTranscriptIdsRef.current.add(eventId);
      }
      setInterimTranscript("");
      if (event.transcript) {
        void processFinalSpeechTranscript(event.transcript);
      }
      return;
    }

    if (event.type.includes("error")) {
      setLiveTranscriptStatus("error");
      setLiveTranscriptError(
        event.error?.message ?? "OpenAI Realtime transcription returned an error.",
      );
    }
  }

  async function startRealtimeTranscription(stream: MediaStream) {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      setLiveTranscriptStatus("unsupported");
      setLiveTranscriptError("No microphone audio track is available for transcription.");
      return;
    }

    stopRealtimeTranscription();
    setLiveTranscriptStatus("connecting");
    setLiveTranscriptError("");

    try {
      const peer = new RTCPeerConnection();
      const dataChannel = peer.createDataChannel("oai-events");
      transcriptionPeerRef.current = peer;
      transcriptionDataChannelRef.current = dataChannel;

      dataChannel.addEventListener("open", () => {
        setLiveTranscriptStatus("listening");
        appendLedger({
          id: "evt-openai-realtime-transcript",
          label: "Realtime transcript ready",
          detail: "OpenAI Realtime transcription connected.",
          status: "watching",
        });
      });
      dataChannel.addEventListener("message", (messageEvent) => {
        try {
          handleRealtimeTranscriptionEvent(JSON.parse(messageEvent.data));
        } catch {
          setLiveTranscriptStatus("error");
          setLiveTranscriptError("Unable to read an OpenAI Realtime transcript event.");
        }
      });
      dataChannel.addEventListener("close", () => {
        if (transcriptionDataChannelRef.current === dataChannel) {
          setLiveTranscriptStatus("idle");
        }
      });
      dataChannel.addEventListener("error", () => {
        setLiveTranscriptStatus("error");
        setLiveTranscriptError("OpenAI Realtime transcription data channel failed.");
      });

      peer.addTrack(audioTrack, stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) {
        throw new Error("Browser did not create an SDP offer for transcription.");
      }

      const sdpResponse = await exchangeRealtimeTranscriptionOffer(offer.sdp);

      await peer.setRemoteDescription({
        type: "answer",
        sdp: sdpResponse.answer_sdp,
      });
      appendLedger({
        id: "evt-openai-realtime-model",
        label: "Realtime transcript model",
        detail: `Backend exchanged SDP with ${sdpResponse.model}.`,
        status: "watching",
      });
    } catch (error) {
      transcriptionDataChannelRef.current?.close();
      transcriptionDataChannelRef.current = null;
      transcriptionPeerRef.current?.close();
      transcriptionPeerRef.current = null;
      setLiveTranscriptStatus("error");
      setLiveTranscriptError(
        error instanceof Error
          ? error.message
          : "Unable to start OpenAI Realtime transcription.",
      );
    }
  }

  function applyWorkflowResponse(response: WorkflowResponse) {
    setBackendState(response.state);
    setBackendStatus("online");
    setStockInput(getActiveStockInputValue(response.state));
    const nextSkuId = getValidSkuId(response.state.active_sku_id);
    setActiveSkuId(nextSkuId);
    setRoomActiveSku(nextSkuId);
    setLedgerEvents((currentEvents) => [
      ...ledgerFromWorkflow(response),
      ...currentEvents,
    ]);
    setQueueItems((currentItems) => [
      ...response.proposed_actions
        .filter((action) => action.type !== "noop")
        .map((action) => ({
          id: `queue-${action.type}-${Date.now()}-${Math.random()}`,
          title: action.type.replaceAll("_", " "),
          detail:
            action.reply_text ??
            action.reason ??
            "CoHost Agent produced a structured action.",
          status: response.guardrail_results.some(
            (result) =>
              result.action_type === action.type &&
              result.status === "blocked",
          )
            ? ("Blocked" as const)
            : response.guardrail_results.some(
                  (result) =>
                    result.action_type === action.type &&
                    result.status === "needs_host_confirmation",
                )
              ? ("Review" as const)
              : ("Draft" as const),
        })),
      ...currentItems,
    ]);
    if (response.suggested_reply) {
      appendAgentReply(response.suggested_reply);
      setRoomState(readLocalRoomState());
    }
  }

  function applyConciergeResolution(response: WorkflowResponse) {
    applyWorkflowResponse(response);
    setEditedEscalationReplies((currentReplies) => {
      const nextReplies = { ...currentReplies };
      response.ledger_entries.forEach((entry) => {
        const pendingActionId = entry.payload?.pending_action_id;
        if (typeof pendingActionId === "string") {
          delete nextReplies[pendingActionId];
        }
      });
      return nextReplies;
    });
  }

  async function handleAcceptEscalation(
    pendingActionId: string,
    commentIds?: string[],
  ) {
    setResolvingActionId(pendingActionId);
    try {
      const response = await approvePendingAction(pendingActionId);
      applyConciergeResolution(response);
      if (commentIds?.length) {
        handleMarkInteractionAnswered(commentIds);
      }
    } catch (error) {
      appendLedger({
        id: "evt-escalation-accept-error",
        label: "Escalation failed",
        detail:
          error instanceof Error ? error.message : "Unable to accept reply draft.",
        status: "blocked",
      });
    } finally {
      setResolvingActionId(null);
    }
  }

  async function handleSendEditedEscalation(
    pendingActionId: string,
    commentIds?: string[],
  ) {
    const replyText = editedEscalationReplies[pendingActionId]?.trim();
    if (!replyText) {
      return;
    }

    setResolvingActionId(pendingActionId);
    try {
      const response = await sendEditedPendingReply(pendingActionId, replyText);
      applyConciergeResolution(response);
      if (commentIds?.length) {
        handleMarkInteractionAnswered(commentIds);
      }
    } catch (error) {
      appendLedger({
        id: "evt-escalation-edit-error",
        label: "Edited reply failed",
        detail:
          error instanceof Error ? error.message : "Unable to send edited reply.",
        status: "blocked",
      });
    } finally {
      setResolvingActionId(null);
    }
  }

  async function handleDiscardEscalation(pendingActionId: string) {
    setResolvingActionId(pendingActionId);
    try {
      const response = await rejectPendingAction(pendingActionId);
      applyConciergeResolution(response);
    } catch (error) {
      appendLedger({
        id: "evt-escalation-discard-error",
        label: "Discard failed",
        detail:
          error instanceof Error ? error.message : "Unable to discard reply draft.",
        status: "blocked",
      });
    } finally {
      setResolvingActionId(null);
    }
  }

  async function handleResolvePendingAction(
    pendingActionId: string,
    resolution: "approve" | "reject",
  ) {
    setResolvingActionId(pendingActionId);
    try {
      const response =
        resolution === "approve"
          ? await approvePendingAction(pendingActionId)
          : await rejectPendingAction(pendingActionId);
      applyWorkflowResponse(response);
    } catch (error) {
      appendLedger({
        id: "evt-confirmation-error",
        label: "Confirmation failed",
        detail:
          error instanceof Error
            ? error.message
            : "Backend confirmation request failed.",
        status: "blocked",
      });
    } finally {
      setResolvingActionId(null);
    }
  }

  async function handleSubmitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = commandInput.trim();
    if (!text) {
      return;
    }

    setHostInputTrace({
      id: `host-command-${Date.now()}`,
      timestamp: Date.now(),
      text,
      source: "typed_command",
      matchedEntity: inferMatchedSkuName(text, backendState),
    });
    try {
      const response = await sendHostCommand(text);
      applyWorkflowResponse(response);
      setCommandInput("");
    } catch (error) {
      appendLedger({
        id: "evt-command-error",
        label: "Command failed",
        detail: error instanceof Error ? error.message : "Backend command failed.",
        status: "blocked",
      });
      setBackendStatus("offline");
    }
  }

  async function handleUpdateStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const stock = Number(stockInput);
    if (!Number.isInteger(stock) || stock < 0) {
      appendLedger({
        id: "evt-stock-invalid",
        label: "Stock update blocked",
        detail: "Stock must be a non-negative whole number.",
        status: "blocked",
      });
      return;
    }

    setStockSaving(true);
    try {
      const response = await sendHostCommand(`Set this product stock to ${stock}.`);
      applyWorkflowResponse(response);
    } catch (error) {
      appendLedger({
        id: "evt-stock-error",
        label: "Stock update failed",
        detail:
          error instanceof Error ? error.message : "Backend stock update failed.",
        status: "blocked",
      });
      setBackendStatus("offline");
    } finally {
      setStockSaving(false);
    }
  }

  function handleUseDraftReply(reply: string, commentIds?: string[]) {
    setReplyInput(reply);
    if (commentIds?.length) {
      handleMarkInteractionAnswered(commentIds);
    }
  }

  function handleMarkInteractionAnswered(commentIds: string[]) {
    setResolvingDraftIds((currentIds) =>
      Array.from(new Set([...currentIds, ...commentIds])),
    );
    window.setTimeout(() => {
      setResolvedDraftIds((currentIds) =>
        Array.from(new Set([...currentIds, ...commentIds])),
      );
      setActiveInteractionCueIds((currentIds) =>
        currentIds.filter((id) => !commentIds.includes(id)),
      );
      setDeferredInteractionCueIds((currentIds) =>
        currentIds.filter((id) => !commentIds.includes(id)),
      );
      setResolvingDraftIds((currentIds) =>
        currentIds.filter((id) => !commentIds.includes(id)),
      );
    }, 900);
  }

  function handleDeferInteractionCue(commentIds: string[]) {
    setDeferredInteractionCueIds((currentIds) =>
      Array.from(new Set([...currentIds, ...commentIds])),
    );
    setActiveInteractionCueIds([]);
  }

  function handleSelectWaitingComment(comment: QueuedViewerComment) {
    setActiveInteractionCueIds(comment.groupedCommentIds);
    setDeferredInteractionCueIds((currentIds) =>
      currentIds.filter((id) => !comment.groupedCommentIds.includes(id)),
    );
  }

  async function handleResetDemo() {
    try {
      const state = await resetBackendState();
      setBackendState(state);
      setStockInput(getActiveStockInputValue(state));
      setActiveSkuId(getValidSkuId(state.active_sku_id));
    } catch {
      setBackendStatus("offline");
    }
    resetLocalRoomState();
    setRoomState(readLocalRoomState());
    setCommandInput("Switch to the Bamboo Thermal Tumbler.");
    setLiveTranscriptLines([]);
    setInterimTranscript("");
    setResolvedDraftIds([]);
    setResolvingDraftIds([]);
    setActiveInteractionCueIds([]);
    setDeferredInteractionCueIds([]);
    setLiveTranscriptError("");
    setHostInputTrace(null);
    setLatestInsight(null);
    setViewerMonitorError("");
    setLedgerEvents(initialLedger);
    setQueueItems([
      {
        id: "queue-initial",
        title: "Waiting for CoHost Agent",
        detail: "Submit a typed command or speak live to call the Python CoHost Agent workflow.",
        status: "Review",
      },
    ]);
  }

  async function handleSendHostReply(event: FormEvent<HTMLFormElement>) {
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

  async function startHostStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaError("Browser media capture is unavailable.");
      return;
    }

    setMediaError("");
    setStreamStatus("starting");
    setHostMediaSession(null, "starting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      void startRealtimeTranscription(stream);

      const session = await createMediaSession();
      setMediaSessionId(session.session_id);
      setHostMediaSession(session.session_id, "starting");

      answerPollRef.current = window.setInterval(async () => {
        const latest = await fetchMediaSession(session.session_id);
        if (latest.status === "stopped") {
          await stopHostStream();
          return;
        }

        const viewerIds = Array.from(
          new Set([
            ...(latest.viewer_ids ?? []),
            ...Object.keys(latest.viewer_answers ?? {}),
            ...Object.keys(latest.viewer_ice_candidates ?? {}),
          ]),
        );

        for (const viewerId of viewerIds) {
          let peer = viewerPeersRef.current.get(viewerId);
          if (!peer) {
            peer = new RTCPeerConnection({
              iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            });
            viewerPeersRef.current.set(viewerId, peer);
            viewerCandidateCountsRef.current.set(viewerId, 0);
            stream.getTracks().forEach((track) => peer?.addTrack(track, stream));
            peer.onicecandidate = (event) => {
              if (event.candidate) {
                void postIceCandidate(
                  session.session_id,
                  "host",
                  event.candidate.toJSON(),
                  viewerId,
                );
              }
            };

            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            await postMediaOffer(session.session_id, offer, viewerId);
          }

          const answer = latest.viewer_answers?.[viewerId];
          if (answer && !peer.currentRemoteDescription) {
            await peer.setRemoteDescription(answer);
          }

          const viewerCandidates = latest.viewer_ice_candidates?.[viewerId] ?? [];
          const consumedCount = viewerCandidateCountsRef.current.get(viewerId) ?? 0;
          const newCandidates = viewerCandidates.slice(consumedCount);
          viewerCandidateCountsRef.current.set(viewerId, viewerCandidates.length);
          for (const candidate of newCandidates) {
            await peer.addIceCandidate(candidate);
          }
        }

        if (viewerPeersRef.current.size > 0) {
          setStreamStatus("live");
          setHostMediaSession(session.session_id, "live");
        }
      }, 1000);
    } catch (error) {
      stopRealtimeTranscription();
      closeViewerPeers();
      setStreamStatus("offline");
      setHostMediaSession(null, "offline");
      setMediaError(
        error instanceof Error ? error.message : "Unable to start host stream.",
      );
    }
  }

  async function stopHostStream() {
    if (answerPollRef.current) {
      window.clearInterval(answerPollRef.current);
      answerPollRef.current = null;
    }
    stopRealtimeTranscription();
    closeViewerPeers();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (mediaSessionId) {
      await stopMediaSession(mediaSessionId).catch(() => null);
    }
    setMediaSessionId(null);
    setStreamStatus("offline");
    setHostMediaSession(null, "offline");
  }

  const liveTranscriptTone =
    liveTranscriptStatus === "listening"
      ? "good"
      : liveTranscriptStatus === "unsupported" || liveTranscriptStatus === "error"
        ? "warning"
    : "neutral";

  return (
    <AppShell
      eyebrow="Host"
      title="Operator cockpit"
      description={`Python backend: ${getBackendUrl()}`}
      contentMaxWidthClass="max-w-[104rem]"
    >
      <div className="mb-4 flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={backendStatus === "online" ? "good" : "warning"}>
            Backend {backendStatus}
          </StatusPill>
          <StatusPill tone={streamStatus === "live" ? "good" : "neutral"}>
            Stream {streamStatus}
          </StatusPill>
          {mediaSessionId ? <StatusPill>{mediaSessionId}</StatusPill> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
            onClick={() => void syncBackendState()}
            type="button"
          >
            Sync backend
          </button>
          <button
            className="min-h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:bg-white"
            onClick={() => void handleResetDemo()}
            type="button"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_0.82fr_1.05fr_0.75fr] xl:items-stretch">
        <Panel
          title="Live Stream"
          eyebrow="Camera and microphone"
          className="xl:col-start-1 xl:row-span-2 xl:flex xl:flex-col"
          contentClassName="xl:flex xl:flex-1 xl:flex-col"
        >
            <div className="overflow-hidden rounded-md bg-slate-950">
              <video
                autoPlay
                className="aspect-video w-full object-cover"
                muted
                playsInline
                ref={localVideoRef}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                disabled={streamStatus !== "offline"}
                onClick={() => void startHostStream()}
                type="button"
              >
                Start stream
              </button>
              <button
                className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
                onClick={() => void stopHostStream()}
                type="button"
              >
                Stop stream
              </button>
              <div
                className="relative"
                onMouseEnter={() => void loadCoHostDebugMessages()}
                onMouseLeave={() => setDebugMessagesVisible(false)}
              >
                <button
                  className="min-h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-white hover:text-teal-800"
                  onFocus={() => void loadCoHostDebugMessages()}
                  onBlur={() => setDebugMessagesVisible(false)}
                  type="button"
                >
                  Messages
                </button>
                {debugMessagesVisible ? (
                  <div className="absolute left-0 z-30 mt-2 w-[min(38rem,calc(100vw-3rem))] rounded-lg border border-slate-200 bg-white p-3 text-left shadow-xl">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase text-slate-500">
                        CoHost LLM messages
                      </p>
                      <StatusPill tone={debugMessagesError ? "warning" : "neutral"}>
                        {debugMessagesLoading ? "loading" : `${cohostDebugMessages.length}`}
                      </StatusPill>
                    </div>
                    {debugMessagesError ? (
                      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-800">
                        {debugMessagesError}
                      </p>
                    ) : (
                      <div className="max-h-96 space-y-2 overflow-y-auto pr-2 text-xs leading-5 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300">
                        {cohostDebugMessages.map((message, index) => (
                          <div
                            className="rounded-md border border-slate-200 bg-slate-50 p-2"
                            key={`${message.role}-${index}`}
                          >
                            <div className="mb-1 flex flex-wrap items-center gap-2">
                              <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-semibold uppercase text-slate-600">
                                {message.role}
                              </span>
                              {message.is_open_user ? (
                                <span className="rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 font-semibold uppercase text-teal-700">
                                  open
                                </span>
                              ) : null}
                            </div>
                            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-slate-700">
                              {message.content}
                            </pre>
                          </div>
                        ))}
                        {!debugMessagesLoading && cohostDebugMessages.length === 0 ? (
                          <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                            No CoHost messages yet.
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
            {mediaError ? (
              <p className="mt-3 text-sm leading-6 text-amber-700">{mediaError}</p>
            ) : null}
            <div
              aria-live="polite"
              className="mt-4 overflow-hidden rounded-md border border-slate-200 bg-slate-50/80 xl:flex xl:flex-1 xl:flex-col"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      liveTranscriptStatus === "listening"
                        ? "bg-teal-500"
                        : liveTranscriptStatus === "error" ||
                            liveTranscriptStatus === "unsupported"
                          ? "bg-amber-500"
                          : "bg-slate-300"
                    }`}
                  />
                  <p className="truncate text-sm font-semibold text-slate-900">
                    Live transcript
                  </p>
                </div>
                <StatusPill tone={liveTranscriptTone}>
                  {liveTranscriptStatus}
                </StatusPill>
              </div>
              <div className="min-h-40 max-h-64 space-y-2 overflow-y-auto border-t border-slate-200 bg-white/80 p-3 text-sm leading-6 xl:min-h-0 xl:max-h-none xl:flex-1">
                {interimTranscript ? (
                  <p className="rounded-md border border-teal-100 bg-teal-50 px-3 py-2 text-slate-800 shadow-sm">
                    <span className="mb-1 block text-xs font-semibold uppercase text-teal-700">
                      Listening
                    </span>
                    {interimTranscript}
                  </p>
                ) : null}
                {liveTranscriptLines.map((line) => (
                  <p
                    className={`rounded-md border px-3 py-2 shadow-sm ${
                      line.status === "error"
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-slate-100 bg-white text-slate-800"
                    }`}
                    key={line.id}
                  >
                    {line.text}
                  </p>
                ))}
                {!interimTranscript && liveTranscriptLines.length === 0 ? (
                  <div className="flex min-h-28 items-center text-sm text-slate-500">
                    <p>Waiting for host speech.</p>
                  </div>
                ) : null}
              </div>
              {liveTranscriptError ? (
                <p className="border-t border-amber-100 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                  {liveTranscriptError}
                </p>
              ) : null}
            </div>
        </Panel>

        <Panel
          title="CoHost Agent Text Command"
          eyebrow="Debug input"
          className="xl:col-start-1 xl:row-start-3"
        >
            <form onSubmit={handleSubmitCommand}>
              <label className="sr-only" htmlFor="host-command">
                Host command
              </label>
              <textarea
                className="min-h-24 w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-teal-500 focus:bg-white"
                id="host-command"
                onChange={(event) => setCommandInput(event.target.value)}
                value={commandInput}
              />
              <button
                className="mt-3 min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                type="submit"
              >
                Send to CoHost Agent
              </button>
            </form>
        </Panel>

        <Panel
          title="Product Shelf"
          eyebrow="Backend active SKU"
          className="xl:col-start-2 xl:row-start-1"
        >
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    {backendActiveSku?.name ?? activeProduct.name}
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {backendActiveSku
                      ? `${formatPrice(backendActiveSku.price_cents)} · ${backendActiveSku.stock} in stock`
                      : `${activeProduct.price} · ${activeProduct.stockLabel}`}
                  </p>
                </div>
                <StatusPill tone="good">Highlighted</StatusPill>
              </div>
              <ul className="mt-4 space-y-2 text-sm text-slate-700">
                {(backendActiveSku?.facts ?? activeProduct.facts).map((fact) => (
                  <li key={fact}>- {fact}</li>
                ))}
              </ul>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {commerceCatalogue.map((sku) => {
                const backendSku = backendState?.skus.find(
                  (stateSku) => stateSku.id === sku.id,
                );
                return (
                  <button
                    className={`rounded-md border p-3 text-left text-sm transition ${
                      sku.id === activeProduct.id
                        ? "border-teal-300 bg-teal-50 text-teal-900"
                        : "border-slate-200 bg-slate-50 text-slate-700 hover:border-teal-300 hover:bg-white"
                    }`}
                    key={sku.id}
                    onClick={() => setCommandInput(`Switch to ${sku.name}.`)}
                    type="button"
                  >
                    <span className="block font-semibold">{sku.name}</span>
                    <span className="mt-1 block text-xs">
                      {backendSku
                        ? `${formatPrice(backendSku.price_cents)} · ${backendSku.stock} in stock`
                        : `${sku.price} · ${sku.stock} in stock`}
                    </span>
                  </button>
                );
              })}
            </div>
            <form
              className="mt-3 rounded-md border border-slate-200 bg-white p-3"
              onSubmit={handleUpdateStock}
            >
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-end">
                <label className="block text-sm font-semibold text-slate-900">
                  Active SKU stock
                  <span className="mt-1 block text-xs font-medium text-slate-500">
                    {backendActiveSku?.name ?? activeProduct.name}
                  </span>
                </label>
                <input
                  className="min-h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none transition focus:border-teal-500 focus:bg-white"
                  min={0}
                  onChange={(event) => setStockInput(event.target.value)}
                  type="number"
                  value={stockInput}
                />
                <button
                  className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                  disabled={stockSaving}
                  type="submit"
                >
                  {stockSaving ? "Saving" : "Update"}
                </button>
              </div>
            </form>
        </Panel>

        <Panel
          title="CoHost Agent Suggested Actions"
          eyebrow="CoHost Agent queue"
          className="xl:col-start-2 xl:row-start-2"
        >
            <div className={boundedScrollAreaClass}>
              {pendingConfirmations.map((pending) => (
                <div
                  className="rounded-md border border-amber-300 bg-amber-50 p-3"
                  key={pending.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">
                      Confirm {formatActionName(pending.action.type)}
                    </p>
                    <StatusPill tone="warning">Needs confirmation</StatusPill>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">
                    {describePendingAction(pending, backendState)}
                  </p>
                  <p className="mt-2 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm leading-6 text-slate-700">
                    {pending.action.source_text}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      className="min-h-9 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                      disabled={resolvingActionId === pending.id}
                      onClick={() =>
                        void handleResolvePendingAction(pending.id, "approve")
                      }
                      type="button"
                    >
                      Approve
                    </button>
                    <button
                      className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-amber-300 hover:text-amber-800 disabled:text-slate-400"
                      disabled={resolvingActionId === pending.id}
                      onClick={() =>
                        void handleResolvePendingAction(pending.id, "reject")
                      }
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
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
                      tone={item.status === "Blocked" ? "warning" : "good"}
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

        <Panel
          title="Viewer AI Monitor"
          eyebrow="Last three minutes"
          className="xl:col-start-2 xl:row-start-3"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  Comment word cloud
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  {activeInsight
                    ? `${activeInsight.comment_count} comments analyzed`
                    : "Waiting for viewer comments"}
                </p>
              </div>
              <button
                className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800 disabled:text-slate-400"
                disabled={wordCloudRefreshing}
                onClick={() => void refreshViewerWordCloud()}
                type="button"
              >
                {wordCloudRefreshing ? "Refreshing" : "Refresh"}
              </button>
            </div>

            {activeInsight ? (
              <div className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm leading-6 text-slate-700">
                  {activeInsight.summary}
                </p>
                {(activeInsight.intent_breakdown ?? []).length > 0 ? (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {(activeInsight.intent_breakdown ?? [])
                      .slice(0, 4)
                      .map((metric) => (
                        <div
                          className="rounded-md border border-slate-200 bg-white px-3 py-2"
                          key={`${activeInsight.id}-${metric.label}`}
                        >
                          <p className="truncate text-xs font-medium text-slate-500">
                            {metric.label}
                          </p>
                          <p className="mt-1 text-lg font-semibold text-slate-900">
                            {metric.count}
                          </p>
                        </div>
                      ))}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {activeInsight.terms.length > 0 ? (
                    activeInsight.terms.slice(0, 8).map((term) => (
                      <span
                        className="rounded-md border border-teal-200 bg-white px-2 py-1 font-semibold text-teal-800"
                        key={`${activeInsight.id}-${term.text}`}
                        style={{
                          fontSize: `${12 + term.weight}px`,
                          opacity: 0.56 + term.weight / 24,
                        }}
                        title={`${term.count} mention weight`}
                      >
                        {term.text}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-slate-400">
                      No weighted terms yet.
                    </span>
                  )}
                </div>
                {activeInsight.suggested_replies.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    {activeInsight.suggested_replies.slice(0, 2).map((reply) => (
                      <button
                        className="w-full rounded-md border border-teal-200 bg-white px-3 py-2 text-left text-sm leading-6 text-slate-700 transition hover:border-teal-400 hover:text-teal-900"
                        key={reply}
                        onClick={() => handleUseDraftReply(reply)}
                        type="button"
                      >
                        {reply}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {viewerMonitorError ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                {viewerMonitorError}
              </p>
            ) : null}

        </Panel>

        <div className="grid gap-4 xl:col-start-3 xl:col-span-2 xl:row-span-2 xl:min-h-0 xl:grid-cols-[1.35fr_0.9fr]">
          <Panel
            title="Monitor Agent"
            eyebrow="Scene judgment"
            className="xl:min-h-0 xl:flex xl:flex-col"
            contentClassName="xl:flex xl:flex-1"
          >
            {monitorDisplay ? (
              <div className="w-full rounded-md border border-rose-100 bg-rose-50 p-4">
                <div className="mb-3 rounded-md border border-white/80 bg-white/80 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Top chat intents
                  </p>
                  <div className="mt-2 grid gap-2">
                    {monitorTopIntents.map((intent) => (
                      <div
                        className="rounded-md bg-slate-50 px-3 py-2 text-sm font-semibold leading-5 text-slate-950"
                        key={intent}
                      >
                        {intent}
                      </div>
                    ))}
                    {monitorTopIntents.length === 0 ? (
                      <p className="text-sm font-semibold text-slate-950">-</p>
                    ) : null}
                  </div>
                </div>
                <div className="mb-4 grid grid-cols-2 gap-2">
                  {[
                    [
                      "Viewers",
                      formatHostLiveMetric(
                        hostLiveMetrics,
                        "online_viewers",
                        monitorDisplay.signals.online_viewers,
                      ),
                    ],
                    [
                      "GPM",
                      formatHostLiveMetric(
                        hostLiveMetrics,
                        "gpm",
                        monitorDisplay.signals.gpm,
                      ),
                    ],
                    [
                      "Conversion",
                      formatHostLiveMetric(
                        hostLiveMetrics,
                        "conversion_rate",
                        monitorDisplay.signals.conversion_rate,
                      ),
                    ],
                    [
                      "High intent",
                      formatHostLiveMetric(
                        hostLiveMetrics,
                        "high_intent_density",
                        monitorDisplay.signals.high_intent_density,
                      ),
                    ],
                    [
                      "Backlog",
                      formatHostLiveMetric(
                        hostLiveMetrics,
                        "question_backlog",
                        monitorDisplay.signals.question_backlog,
                      ),
                    ],
                    [
                      "Interaction",
                      formatHostLiveMetric(
                        hostLiveMetrics,
                        "interaction_rate",
                        monitorDisplay.signals.interaction_rate,
                      ),
                    ],
                    ["Source", liveMonitorSummary ? "live metrics" : monitorDisplay.signals.analysis_source],
                  ].map(([label, value]) => (
                    <div
                      className="min-h-16 rounded-md border border-white/70 bg-white/70 p-2"
                      key={label}
                    >
                      <p className="text-[11px] font-semibold text-slate-500">
                        {label}
                      </p>
                      <p className="mt-0.5 text-[10px] leading-4 text-slate-500">
                        {monitorMetricHelp[label] ?? "Live monitor metric."}
                      </p>
                      <p className="mt-1 break-words text-sm font-semibold text-slate-950">
                        {value ?? "-"}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-rose-700">
                      {monitorDisplay.scenarioLabel}
                    </p>
                    <h2 className="mt-2 text-lg font-semibold text-slate-950">
                      {monitorDisplay.hookLabel}
                    </h2>
                  </div>
                  <StatusPill
                    tone={
                      monitorDisplay.urgency === "high"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {monitorDisplay.urgency}
                  </StatusPill>
                </div>
                {monitorDisplay.hostCue ? (
                  <div className="mt-4 rounded-md border border-amber-100 bg-amber-50 p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                      Host Cue
                    </p>
                    <p className="mt-2 text-xs leading-5 text-slate-800">
                      {monitorDisplay.hostCue}
                    </p>
                  </div>
                ) : null}
                <div className="mt-3 rounded-md bg-white p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Suggested Line
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-950">
                    {monitorDisplay.script}
                  </p>
                </div>
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  {monitorDisplay.scenarioReason}
                </p>
              </div>
            ) : (
              <div className="flex w-full items-center rounded-md border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                Open Monitor and click a scenario to push judgment and script here.
              </div>
            )}
          </Panel>

          <Panel
            title="CoHost Agent Event Timeline"
            eyebrow="Ledger"
            className="xl:min-h-0 xl:flex xl:flex-col"
            contentClassName="xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
          >
            <div className={ledgerScrollAreaClass}>
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
        </div>

        <Panel
          title="Host Reply"
          eyebrow="Viewer room"
          className="xl:col-start-3 xl:col-span-2 xl:row-start-3"
        >
            <div className="space-y-3">
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-950">
                    Escalated
                  </p>
                  {activeInteractionCue ? (
                    activeCueResolving ? (
                      <span className="animate-pulse rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">
                        ✓ Resolved
                      </span>
                    ) : (
                      <StatusPill tone="warning">Host review</StatusPill>
                    )
                  ) : (
                    <StatusPill tone="neutral">No active cue</StatusPill>
                  )}
                </div>
                {activeInteractionCue ? (
                  <>
                    <div className="mt-3 space-y-2 text-sm leading-6">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Viewer question
                        </p>
                        <p className="text-slate-800">
                          {activeInteractionCue.text}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Reason
                        </p>
                        <p className="text-slate-800">
                          {activeEscalationReason}
                        </p>
                      </div>
                      {activeCueResolving ? (
                        <div className="animate-pulse rounded-md border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-700">
                          ✓ Resolved. Removing this question from the queue.
                        </div>
                      ) : null}
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Draft reply
                        </span>
                        <textarea
                          className="mt-1 min-h-24 w-full resize-y rounded-md border border-amber-200 bg-white p-3 text-sm leading-6 outline-none transition focus:border-teal-500"
                          onChange={(event) => {
                            if (activeConciergeEscalation) {
                              setEditedEscalationReplies((currentReplies) => ({
                                ...currentReplies,
                                [activeConciergeEscalation.id]: event.target.value,
                              }));
                              return;
                            }
                            setInteractionDraftReplies((currentReplies) => ({
                              ...currentReplies,
                              [activeInteractionCue.id]: event.target.value,
                            }));
                          }}
                          value={activeEscalationDraft}
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {activeConciergeEscalation ? (
                        <>
                          <button
                            className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                            disabled={
                              activeCueResolving ||
                              resolvingActionId === activeConciergeEscalation.id
                            }
                            onClick={() =>
                              void handleAcceptEscalation(
                                activeConciergeEscalation.id,
                                activeInteractionCue.groupedCommentIds,
                              )
                            }
                            type="button"
                          >
                            Accept
                          </button>
                          <button
                            className="min-h-10 rounded-md border border-teal-200 bg-white px-3 text-sm font-semibold text-teal-800 transition hover:border-teal-400"
                            disabled={
                              activeCueResolving ||
                              !activeEscalationDraft.trim() ||
                              resolvingActionId === activeConciergeEscalation.id
                            }
                            onClick={() =>
                              void handleSendEditedEscalation(
                                activeConciergeEscalation.id,
                                activeInteractionCue.groupedCommentIds,
                              )
                            }
                            type="button"
                          >
                            Send edited
                          </button>
                          <button
                            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            disabled={
                              activeCueResolving ||
                              resolvingActionId === activeConciergeEscalation.id
                            }
                            onClick={() =>
                              void handleDiscardEscalation(
                                activeConciergeEscalation.id,
                              )
                            }
                            type="button"
                          >
                            Discard
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                            disabled={activeCueResolving || !activeEscalationDraft.trim()}
                            onClick={() =>
                              handleUseDraftReply(
                                activeEscalationDraft,
                                activeInteractionCue.groupedCommentIds,
                              )
                            }
                            type="button"
                          >
                            Adopt
                          </button>
                          <button
                            className="min-h-10 rounded-md border border-teal-200 bg-white px-3 text-sm font-semibold text-teal-800 transition hover:border-teal-400"
                            disabled={activeCueResolving}
                            onClick={() =>
                              handleMarkInteractionAnswered(
                                activeInteractionCue.groupedCommentIds,
                              )
                            }
                            type="button"
                          >
                            Answered
                          </button>
                          <button
                            className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                            disabled={activeCueResolving}
                            onClick={() =>
                              handleDeferInteractionCue(
                                activeInteractionCue.groupedCommentIds,
                              )
                            }
                            type="button"
                          >
                            Later
                          </button>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="mt-3 rounded-md border border-amber-200 bg-white px-3 py-4 text-sm text-slate-500">
                    New unanswered viewer questions will appear here for host review.
                  </p>
                )}
              </div>

              <div className="max-w-xl rounded-md border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-900">
                    Waiting queue
                  </p>
                </div>
                <div className="mt-3 max-h-72 space-y-3 overflow-y-auto pr-2 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-slate-100 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300">
                  {recentViewerComments.map((comment) => (
                    <button
                      className={`w-full rounded-md border p-3 text-left transition hover:border-teal-300 hover:bg-white ${
                        comment.isProductRelated
                          ? "border-teal-200 bg-teal-50"
                          : comment.frequency > 1
                            ? "border-amber-200 bg-amber-50"
                            : "border-slate-200 bg-white"
                      }`}
                      key={comment.id}
                      onClick={() => handleSelectWaitingComment(comment)}
                      type="button"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p
                          className={`text-xs font-semibold ${
                            comment.isProductRelated ? "text-teal-700" : "text-slate-500"
                          }`}
                        >
                          {comment.viewer}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {comment.isProductRelated ? (
                            <span className="rounded-sm bg-teal-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-teal-700">
                              Active SKU
                            </span>
                          ) : null}
                          {comment.frequency > 1 ? (
                            <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700">
                              Asked {comment.frequency}x
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-800">
                        {comment.text}
                      </p>
                    </button>
                  ))}
                  {recentViewerComments.length === 0 ? (
                    <p className="rounded-md border border-slate-200 bg-white px-3 py-4 text-sm text-slate-500">
                      No viewer questions need host review.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>

            <form onSubmit={handleSendHostReply}>
              <input
                className="mt-3 min-h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-500"
                onChange={(event) => setReplyInput(event.target.value)}
                placeholder="Send a host reply"
                value={replyInput}
              />
              <button
                className="mt-3 min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                type="submit"
              >
                Send reply
              </button>
            </form>
        </Panel>

        <Panel
          title="Live internal flow"
          eyebrow="Agent workflow"
          className="h-[500px] xl:col-span-4 xl:flex xl:flex-col"
          contentClassName="flex min-h-0 flex-1 flex-col"
        >
          <AgentFlowPanel flow={agentFlow} />
        </Panel>
      </div>
    </AppShell>
  );
}
