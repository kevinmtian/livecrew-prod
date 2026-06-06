"use client";

import { AppShell, Panel, StatusPill } from "@/components/dashboard";
import {
  type SkuId,
  commerceCatalogue,
  defaultActiveSkuId,
  getActiveSkuDisplay,
  resolveSkuById,
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
  type PendingAction,
  type WorkflowResponse,
  approvePendingAction,
  createMediaSession,
  fetchBackendState,
  fetchMediaSession,
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
import { mockChat } from "@/lib/mock-data";
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

type LiveTranscriptLine = {
  id: string;
  text: string;
  status: "final" | "error";
};

type BrowserSpeechRecognitionAlternative = {
  transcript: string;
};

type BrowserSpeechRecognitionResult = {
  isFinal: boolean;
  0: BrowserSpeechRecognitionAlternative;
};

type BrowserSpeechRecognitionResultList = {
  length: number;
  [index: number]: BrowserSpeechRecognitionResult;
};

type BrowserSpeechRecognitionEvent = Event & {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
};

type BrowserSpeechRecognitionErrorEvent = Event & {
  error: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  abort: () => void;
  start: () => void;
  stop: () => void;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onstart: (() => void) | null;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };

const initialLedger: LedgerEvent[] = [
  {
    id: "evt-initial-001",
    label: "Backend expected",
    detail: "Start the Python backend on port 8000 before running live agent flows.",
    status: "watching",
  },
];

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

function ledgerFromWorkflow(response: WorkflowResponse): LedgerEvent[] {
  return response.ledger_entries.map((entry) => ({
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
  const [replyInput, setReplyInput] = useState("");
  const [stockInput, setStockInput] = useState(
    String(getActiveSkuDisplay(defaultActiveSkuId).stock),
  );
  const [stockSaving, setStockSaving] = useState(false);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([
    {
      id: "queue-initial",
      title: "Waiting for CoHostAgent",
      detail: "Submit a typed command or speak live to call the Python LangGraph backend.",
      status: "Review",
    },
  ]);
  const [mediaSessionId, setMediaSessionId] = useState<string | null>(null);
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
    "idle" | "listening" | "unsupported" | "error"
  >("idle");
  const [editedEscalationReplies, setEditedEscalationReplies] = useState<
    Record<string, string>
  >({});
  const [liveTranscriptError, setLiveTranscriptError] = useState("");

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const answerPollRef = useRef<number | null>(null);
  const viewerCandidateCountRef = useRef(0);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const shouldListenForSpeechRef = useRef(false);

  const activeProduct = getActiveSkuDisplay(activeSkuId);
  const backendActiveSku = backendState?.skus.find(
    (sku) => sku.id === backendState.active_sku_id,
  );
  const liveRoomMessages = [...roomState.viewerMessages, ...roomState.replies].sort(
    (firstMessage, secondMessage) => firstMessage.createdAt - secondMessage.createdAt,
  );
  const conciergeEscalations =
    backendState?.pending_actions.filter(
      (pending) =>
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

  useEffect(() => {
    function syncRoomState() {
      const nextRoomState = readLocalRoomState();
      setRoomState(nextRoomState);
    }

    syncRoomState();
    void syncBackendState();
    const unsubscribe = subscribeToLocalRoom(syncRoomState);
    const backendPollId = window.setInterval(() => {
      void syncBackendState();
    }, 3000);

    return () => {
      window.clearInterval(backendPollId);
      if (answerPollRef.current) {
        window.clearInterval(answerPollRef.current);
      }
      unsubscribe();
      stopLiveSpeechRecognition();
      peerRef.current?.close();
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
    } catch {
      setBackendStatus("offline");
    }
  }

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

  async function processFinalSpeechTranscript(text: string) {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    appendLiveTranscriptLine(trimmedText, "final");
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

  function stopLiveSpeechRecognition() {
    shouldListenForSpeechRef.current = false;
    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.onstart = null;
      recognition.abort();
    }
    setInterimTranscript("");
    setLiveTranscriptStatus("idle");
  }

  function startLiveSpeechRecognition() {
    const SpeechRecognition =
      (window as SpeechWindow).SpeechRecognition ??
      (window as SpeechWindow).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setLiveTranscriptStatus("unsupported");
      setLiveTranscriptError("Live transcript preview is unavailable in this browser.");
      return;
    }

    stopLiveSpeechRecognition();
    setLiveTranscriptError("");
    shouldListenForSpeechRef.current = true;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.onstart = () => setLiveTranscriptStatus("listening");
    recognition.onresult = (event) => {
      const finalSegments: string[] = [];
      const interimSegments: string[] = [];

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcriptText = result[0]?.transcript.trim();
        if (!transcriptText) {
          continue;
        }

        if (result.isFinal) {
          finalSegments.push(transcriptText);
        } else {
          interimSegments.push(transcriptText);
        }
      }

      setInterimTranscript(interimSegments.join(" "));
      finalSegments.forEach((segment) => {
        void processFinalSpeechTranscript(segment);
      });
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech") {
        return;
      }

      setLiveTranscriptStatus("error");
      setLiveTranscriptError(`Live transcript error: ${event.error}`);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldListenForSpeechRef.current = false;
      }
    };
    recognition.onend = () => {
      if (!shouldListenForSpeechRef.current) {
        setLiveTranscriptStatus("idle");
        return;
      }

      window.setTimeout(() => {
        if (
          !shouldListenForSpeechRef.current ||
          speechRecognitionRef.current !== recognition
        ) {
          return;
        }
        try {
          recognition.start();
        } catch {
          setLiveTranscriptStatus("error");
        }
      }, 250);
    };

    speechRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setLiveTranscriptStatus("error");
      setLiveTranscriptError("Unable to start live transcript preview.");
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
            "Agent produced a structured action.",
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

  async function handleAcceptEscalation(pendingActionId: string) {
    setResolvingActionId(pendingActionId);
    try {
      const response = await approvePendingAction(pendingActionId);
      applyConciergeResolution(response);
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

  async function handleSendEditedEscalation(pendingActionId: string) {
    const replyText = editedEscalationReplies[pendingActionId]?.trim();
    if (!replyText) {
      return;
    }

    setResolvingActionId(pendingActionId);
    try {
      const response = await sendEditedPendingReply(pendingActionId, replyText);
      applyConciergeResolution(response);
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
    setLiveTranscriptError("");
    setLedgerEvents(initialLedger);
    setQueueItems([
      {
        id: "queue-initial",
        title: "Waiting for CoHostAgent",
        detail: "Submit a typed command or speak live to call the Python LangGraph backend.",
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
      startLiveSpeechRecognition();

      const session = await createMediaSession();
      setMediaSessionId(session.session_id);
      setHostMediaSession(session.session_id, "starting");

      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peerRef.current = peer;
      viewerCandidateCountRef.current = 0;

      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          void postIceCandidate(session.session_id, "host", event.candidate.toJSON());
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await postMediaOffer(session.session_id, offer);

      answerPollRef.current = window.setInterval(async () => {
        const latest = await fetchMediaSession(session.session_id);
        if (latest.answer && !peer.currentRemoteDescription) {
          await peer.setRemoteDescription(latest.answer);
          setStreamStatus("live");
          setHostMediaSession(session.session_id, "live");
        }
        const newCandidates = latest.viewer_candidates.slice(
          viewerCandidateCountRef.current,
        );
        viewerCandidateCountRef.current = latest.viewer_candidates.length;
        for (const candidate of newCandidates) {
          await peer.addIceCandidate(candidate);
        }
      }, 1000);
    } catch (error) {
      stopLiveSpeechRecognition();
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
    stopLiveSpeechRecognition();
    peerRef.current?.close();
    peerRef.current = null;
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

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.85fr]">
        <div className="grid gap-4">
          <Panel title="Live Stream" eyebrow="Camera and microphone">
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
            </div>
            {mediaError ? (
              <p className="mt-3 text-sm leading-6 text-amber-700">{mediaError}</p>
            ) : null}
            <div
              aria-live="polite"
              className="mt-4 min-h-48 rounded-md border-4 border-red-400 bg-white p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">
                  Live transcript
                </p>
                <StatusPill tone={liveTranscriptTone}>
                  {liveTranscriptStatus}
                </StatusPill>
              </div>
              <div className="mt-3 space-y-2 text-sm leading-6">
                {interimTranscript ? (
                  <p className="rounded-md border border-red-100 bg-red-50 px-3 py-2 text-slate-700">
                    {interimTranscript}
                  </p>
                ) : null}
                {liveTranscriptLines.map((line) => (
                  <p
                    className={`rounded-md border px-3 py-2 ${
                      line.status === "error"
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-slate-200 bg-slate-50 text-slate-800"
                    }`}
                    key={line.id}
                  >
                    {line.text}
                  </p>
                ))}
                {!interimTranscript && liveTranscriptLines.length === 0 ? (
                  <p className="text-sm text-slate-400">Waiting for host speech.</p>
                ) : null}
              </div>
              {liveTranscriptError ? (
                <p className="mt-3 text-sm leading-6 text-amber-700">
                  {liveTranscriptError}
                </p>
              ) : null}
            </div>
          </Panel>

          <Panel title="CoHost Text Command" eyebrow="Debug input">
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
                Send to CoHost
              </button>
            </form>
          </Panel>
        </div>

        <div className="grid gap-4">
          <Panel title="Product Shelf" eyebrow="Backend active SKU">
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

          <Panel title="AI Suggested Actions" eyebrow="LangGraph queue">
            <div className="space-y-3">
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

          <Panel title="Viewer Chat" eyebrow="Room messages">
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
                  <p className="text-xs font-semibold text-teal-700">
                    {chat.name}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-800">
                    {chat.text}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="grid gap-4">
          <Panel title="Monitor Agent" eyebrow="Scene judgment">
            {roomState.monitorSignal ? (
              <div className="rounded-md border border-rose-100 bg-rose-50 p-4">
                <div className="mb-4 grid grid-cols-2 gap-2">
                  {[
                    ["在线人数", roomState.monitorSignal.signals.online_viewers],
                    ["GPM", roomState.monitorSignal.signals.gpm],
                    ["转化率", roomState.monitorSignal.signals.conversion_rate],
                    ["弹幕情绪", roomState.monitorSignal.signals.comment_sentiment],
                    ["互动率", roomState.monitorSignal.signals.interaction_rate],
                    ["来源", roomState.monitorSignal.signals.analysis_source],
                  ].map(([label, value]) => (
                    <div
                      className="min-h-16 rounded-md border border-white/70 bg-white/70 p-2"
                      key={label}
                    >
                      <p className="text-[11px] font-semibold text-slate-500">
                        {label}
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
                      {roomState.monitorSignal.scenarioLabel}
                    </p>
                    <h2 className="mt-2 text-lg font-semibold text-slate-950">
                      {roomState.monitorSignal.hookLabel}
                    </h2>
                  </div>
                  <StatusPill
                    tone={
                      roomState.monitorSignal.urgency === "high"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {roomState.monitorSignal.urgency}
                  </StatusPill>
                </div>
                <p className="mt-4 rounded-md bg-white p-3 text-sm leading-6 text-slate-950">
                  {roomState.monitorSignal.script}
                </p>
                <p className="mt-3 text-xs leading-5 text-slate-600">
                  {roomState.monitorSignal.scenarioReason}
                </p>
              </div>
            ) : (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
                Open Monitor and click a scenario to push judgment and script here.
              </div>
            )}
          </Panel>

          <Panel title="Agent Event Timeline" eyebrow="Ledger">
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

          <Panel title="Host Reply" eyebrow="Viewer room">
            <div className="space-y-3">
              {conciergeEscalations.map((pending) => {
                const draftReply =
                  editedEscalationReplies[pending.id] ??
                  pending.action.reply_text ??
                  "";

                return (
                  <div
                    className="rounded-md border border-amber-300 bg-amber-50 p-3"
                    key={pending.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-950">
                        Escalated
                      </p>
                      <StatusPill tone="warning">Host review</StatusPill>
                    </div>
                    <div className="mt-3 space-y-2 text-sm leading-6">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Viewer question
                        </p>
                        <p className="text-slate-800">
                          {pending.action.source_text}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Reason
                        </p>
                        <p className="text-slate-800">
                          {pending.guardrail_result.reason}
                        </p>
                      </div>
                      <label className="block">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Draft reply
                        </span>
                        <textarea
                          className="mt-1 min-h-24 w-full resize-y rounded-md border border-amber-200 bg-white p-3 text-sm leading-6 outline-none transition focus:border-teal-500"
                          onChange={(event) =>
                            setEditedEscalationReplies((currentReplies) => ({
                              ...currentReplies,
                              [pending.id]: event.target.value,
                            }))
                          }
                          value={draftReply}
                        />
                      </label>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                        onClick={() => void handleAcceptEscalation(pending.id)}
                        type="button"
                      >
                        Accept
                      </button>
                      <button
                        className="min-h-10 rounded-md border border-teal-200 bg-white px-3 text-sm font-semibold text-teal-800 transition hover:border-teal-400"
                        disabled={!draftReply.trim()}
                        onClick={() =>
                          void handleSendEditedEscalation(pending.id)
                        }
                        type="button"
                      >
                        Send edited
                      </button>
                      <button
                        className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                        onClick={() => void handleDiscardEscalation(pending.id)}
                        type="button"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                );
              })}

              <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3">
                {liveRoomMessages.length ? (
                  liveRoomMessages.map((message) => {
                    const isViewer = message.sender === "viewer";
                    const isAgent = message.sender === "agent";

                    return (
                      <div
                        className={`rounded-md border bg-white p-3 ${
                          isViewer
                            ? "border-slate-200"
                            : isAgent
                              ? "border-teal-200"
                              : "border-slate-200"
                        }`}
                        key={message.id}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p
                            className={`text-xs font-semibold uppercase tracking-wide ${
                              isAgent ? "text-teal-700" : "text-slate-500"
                            }`}
                          >
                            {message.name}
                          </p>
                          <StatusPill tone={isAgent ? "good" : "neutral"}>
                            {message.sender}
                          </StatusPill>
                        </div>
                        <p className="mt-1 text-sm leading-6 text-slate-800">
                          {message.text}
                        </p>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-sm leading-6 text-slate-500">
                    No viewer room replies yet.
                  </p>
                )}
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
        </div>
      </div>
    </AppShell>
  );
}
