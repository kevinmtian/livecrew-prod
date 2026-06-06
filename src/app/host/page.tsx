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
  type WorkflowResponse,
  createMediaSession,
  fetchBackendState,
  fetchMediaSession,
  getBackendUrl,
  postIceCandidate,
  postMediaOffer,
  resetBackendState,
  sendHostCommand,
  sendHostTranscript,
  stopMediaSession,
  transcribeAudio,
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

const initialTranscript =
  "Today we are starting with GlowFix Vitamin C Serum. It is a brightening serum in a 30 ml bottle.";

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

function ledgerFromWorkflow(response: WorkflowResponse): LedgerEvent[] {
  return response.ledger_entries.map((entry) => ({
    id: entry.id,
    label: entry.type.replaceAll("_", " "),
    detail: entry.detail,
    status: entry.type.includes("block")
      ? "blocked"
      : entry.type.includes("confirmation")
        ? "pending"
        : "complete",
  }));
}

export default function HostPage() {
  const [transcript, setTranscript] = useState(initialTranscript);
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
  const [queueItems, setQueueItems] = useState<QueueItem[]>([
    {
      id: "queue-initial",
      title: "Waiting for CoHostAgent",
      detail: "Submit a typed command or speech transcript to call the Python LangGraph backend.",
      status: "Review",
    },
  ]);
  const [mediaSessionId, setMediaSessionId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "offline" | "starting" | "live"
  >("offline");
  const [mediaError, setMediaError] = useState("");
  const [recordingStatus, setRecordingStatus] = useState<
    "idle" | "recording" | "transcribing"
  >("idle");

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const answerPollRef = useRef<number | null>(null);
  const viewerCandidateCountRef = useRef(0);

  const activeProduct = getActiveSkuDisplay(activeSkuId);
  const backendActiveSku = backendState?.skus.find(
    (sku) => sku.id === backendState.active_sku_id,
  );

  useEffect(() => {
    function syncRoomState() {
      const nextRoomState = readLocalRoomState();
      setRoomState(nextRoomState);
    }

    syncRoomState();
    void syncBackendState();
    const unsubscribe = subscribeToLocalRoom(syncRoomState);

    return () => {
      if (answerPollRef.current) {
        window.clearInterval(answerPollRef.current);
      }
      unsubscribe();
      peerRef.current?.close();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function syncBackendState() {
    try {
      const state = await fetchBackendState();
      setBackendState(state);
      setBackendStatus("online");
      const nextSkuId = getValidSkuId(state.active_sku_id);
      setActiveSkuId(nextSkuId);
      setRoomActiveSku(nextSkuId);
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

  function applyWorkflowResponse(response: WorkflowResponse) {
    setBackendState(response.state);
    const nextSkuId = getValidSkuId(response.state.active_sku_id);
    setActiveSkuId(nextSkuId);
    setRoomActiveSku(nextSkuId);
    setLedgerEvents((currentEvents) => [
      ...ledgerFromWorkflow(response),
      ...currentEvents,
    ]);
    setQueueItems((currentItems) => [
      ...response.proposed_actions.map((action) => ({
        id: `queue-${action.type}-${Date.now()}-${Math.random()}`,
        title: action.type.replaceAll("_", " "),
        detail: action.reason ?? "CoHostAgent produced a structured action.",
        status:
          response.guardrail_results.some(
            (result) =>
              result.action_type === action.type && result.status === "blocked",
          )
            ? ("Blocked" as const)
            : ("Draft" as const),
      })),
      ...currentItems,
    ]);
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
      setTranscript(text);
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

  async function handleSubmitTranscript() {
    try {
      const response = await sendHostTranscript(transcript);
      applyWorkflowResponse(response);
    } catch (error) {
      appendLedger({
        id: "evt-transcript-error",
        label: "Transcript failed",
        detail:
          error instanceof Error ? error.message : "Backend transcript event failed.",
        status: "blocked",
      });
      setBackendStatus("offline");
    }
  }

  async function handleResetDemo() {
    try {
      const state = await resetBackendState();
      setBackendState(state);
      setActiveSkuId(getValidSkuId(state.active_sku_id));
    } catch {
      setBackendStatus("offline");
    }
    resetLocalRoomState();
    setRoomState(readLocalRoomState());
    setTranscript(initialTranscript);
    setCommandInput("Switch to the Bamboo Thermal Tumbler.");
    setLedgerEvents(initialLedger);
    setQueueItems([
      {
        id: "queue-initial",
        title: "Waiting for CoHostAgent",
        detail: "Submit a typed command or speech transcript to call the Python LangGraph backend.",
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

  async function recordAndTranscribe() {
    const stream = localStreamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") {
      setMediaError("Start the host stream before recording audio.");
      return;
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    setRecordingStatus("recording");
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = async () => {
      setRecordingStatus("transcribing");
      try {
        const result = await transcribeAudio(new Blob(chunks, { type: "audio/webm" }));
        setTranscript(result.text);
        const response = await sendHostTranscript(result.text);
        applyWorkflowResponse(response);
      } catch (error) {
        appendLedger({
          id: "evt-transcribe-error",
          label: "Transcription failed",
          detail:
            error instanceof Error
              ? error.message
              : "OpenAI transcription request failed.",
          status: "blocked",
        });
      } finally {
        setRecordingStatus("idle");
      }
    };
    recorder.start();
    window.setTimeout(() => recorder.stop(), 4000);
  }

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
              <button
                className="min-h-10 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:bg-white disabled:text-slate-400"
                disabled={recordingStatus !== "idle"}
                onClick={() => void recordAndTranscribe()}
                type="button"
              >
                {recordingStatus === "idle" ? "Record 4s" : recordingStatus}
              </button>
            </div>
            {mediaError ? (
              <p className="mt-3 text-sm leading-6 text-amber-700">{mediaError}</p>
            ) : null}
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

          <Panel title="Host Transcript" eyebrow="Speech transcript">
            <textarea
              className="min-h-28 w-full resize-y rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-6 outline-none transition focus:border-teal-500 focus:bg-white"
              onChange={(event) => setTranscript(event.target.value)}
              value={transcript}
            />
            <button
              className="mt-3 min-h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:text-teal-800"
              onClick={() => void handleSubmitTranscript()}
              type="button"
            >
              Run transcript
            </button>
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
              {commerceCatalogue.map((sku) => (
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
                    {sku.price} · {sku.stock} in stock
                  </span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="AI Suggested Actions" eyebrow="LangGraph queue">
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
            <form onSubmit={handleSendHostReply}>
              <input
                className="min-h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-teal-500"
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
