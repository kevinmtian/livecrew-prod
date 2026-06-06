"use client";

import { StatusPill } from "@/components/dashboard";
import { defaultActiveSkuId, getActiveSkuDisplay } from "@/lib/catalogue";
import {
  appendAgentReply,
  appendViewerMessage,
  defaultLocalRoomState,
  type LocalRoomState,
  readLocalRoomState,
  subscribeToLocalRoom,
} from "@/lib/local-room";
import {
  type BackendState,
  type ViewerSession,
  fetchBackendState,
  fetchLatestMediaSession,
  fetchMediaSession,
  joinMediaSession,
  loginViewer,
  logoutViewer,
  postIceCandidate,
  postMediaAnswer,
  sendViewerHeartbeat,
  sendViewerMessage,
  sendViewerMetricEvent,
} from "@/lib/livecrew-api";
import { mockChat } from "@/lib/mock-data";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

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
];

function formatPrice(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function getFlashSaleSecondsLeft(
  flashSale: NonNullable<BackendState["flash_sale"]>,
  now: number,
) {
  const createdAt = new Date(flashSale.created_at).getTime();
  if (Number.isNaN(createdAt)) {
    return flashSale.duration_seconds;
  }
  const endsAt = createdAt + flashSale.duration_seconds * 1000;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export default function ViewerPage() {
  const [roomState, setRoomState] =
    useState<LocalRoomState>(defaultLocalRoomState);
  const [messageInput, setMessageInput] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<
    "offline" | "connecting" | "live"
  >("offline");
  const [streamError, setStreamError] = useState("");
  const [backendState, setBackendState] = useState<BackendState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [messageStatus, setMessageStatus] = useState<"idle" | "sending">("idle");
  const [messageError, setMessageError] = useState("");
  const [viewerSession, setViewerSession] = useState<ViewerSession | null>(null);
  const [loginInput, setLoginInput] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "submitting">("idle");
  const [loginError, setLoginError] = useState("");

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const hostCandidateCountRef = useRef(0);
  const pollRef = useRef<number | null>(null);
  const viewerSessionIdRef = useRef<string | null>(null);

  const fallbackProduct = getActiveSkuDisplay(
    backendState?.active_sku_id ?? roomState.activeSkuId ?? defaultActiveSkuId,
  );
  const backendActiveSkuId = backendState?.active_sku_id ?? null;
  const activeBackendSku = backendState?.skus.find(
    (sku) => sku.id === backendActiveSkuId,
  );
  const displayProduct = {
    name: activeBackendSku?.name ?? fallbackProduct.name,
    price: activeBackendSku
      ? formatPrice(activeBackendSku.price_cents)
      : fallbackProduct.price,
    stock: activeBackendSku?.stock ?? fallbackProduct.stock,
    facts: activeBackendSku?.facts ?? fallbackProduct.facts,
  };
  const activeFlashSale =
    backendState?.flash_sale?.sku_id === backendActiveSkuId
      ? backendState.flash_sale
      : null;
  const flashSaleSecondsLeft = activeFlashSale
    ? getFlashSaleSecondsLeft(activeFlashSale, now)
    : 0;
  const isFlashSaleActive =
    Boolean(activeFlashSale) &&
    flashSaleSecondsLeft > 0 &&
    (activeFlashSale?.remaining_stock ?? 0) > 0;
  const liveRoomMessages = [...roomState.viewerMessages, ...roomState.replies].sort(
    (firstMessage, secondMessage) => firstMessage.createdAt - secondMessage.createdAt,
  );

  const syncBackendState = useCallback(async () => {
    try {
      const state = await fetchBackendState();
      setBackendState(state);
    } catch {
      setBackendState(null);
    }
  }, []);

  const closeViewerPeer = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    peerRef.current?.close();
    peerRef.current = null;
    sessionIdRef.current = null;
    hostCandidateCountRef.current = 0;
  }, []);

  const connectToLatestStream = useCallback(async () => {
    if (!viewerSession) {
      return;
    }
    if (peerRef.current) {
      return;
    }

    setConnectionStatus("connecting");
    setStreamError("");

    try {
      const session = await fetchLatestMediaSession();
      if (session.status === "stopped") {
        setConnectionStatus("offline");
        return;
      }

      await joinMediaSession(session.session_id, viewerSession.id);
      let viewerOffer = session.viewer_offers?.[viewerSession.id] ?? null;
      if (!viewerOffer) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          const latest = await fetchMediaSession(session.session_id);
          if (latest.status === "stopped") {
            setConnectionStatus("offline");
            return;
          }
          viewerOffer = latest.viewer_offers?.[viewerSession.id] ?? null;
          if (viewerOffer) {
            break;
          }
        }
      }

      if (!viewerOffer) {
        setConnectionStatus("offline");
        setStreamError("Host has not prepared a viewer stream yet. Tap Connect again.");
        return;
      }

      sessionIdRef.current = session.session_id;
      hostCandidateCountRef.current = 0;
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peerRef.current = peer;

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (remoteVideoRef.current && stream) {
          remoteVideoRef.current.srcObject = stream;
          setConnectionStatus("live");
        }
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
          setConnectionStatus("offline");
          peerRef.current = null;
        }
      };
      peer.onicecandidate = (event) => {
        if (event.candidate && sessionIdRef.current) {
          void postIceCandidate(
            sessionIdRef.current,
            "viewer",
            event.candidate.toJSON(),
            viewerSession.id,
          );
        }
      };

      await peer.setRemoteDescription(viewerOffer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await postMediaAnswer(session.session_id, answer, viewerSession.id);

      pollRef.current = window.setInterval(async () => {
        try {
          if (!sessionIdRef.current || !peerRef.current) {
            return;
          }
          const latest = await fetchMediaSession(sessionIdRef.current);
          if (latest.status === "stopped") {
            closeViewerPeer();
            setConnectionStatus("offline");
            return;
          }
          const hostCandidates =
            latest.viewer_host_candidates?.[viewerSession.id] ?? [];
          const newCandidates = hostCandidates.slice(
            hostCandidateCountRef.current,
          );
          hostCandidateCountRef.current = hostCandidates.length;
          for (const candidate of newCandidates) {
            await peerRef.current.addIceCandidate(candidate);
          }
        } catch {
          closeViewerPeer();
          setConnectionStatus("offline");
          setStreamError("Host stream session ended. Waiting for a new stream.");
          return;
        }
      }, 1000);
    } catch (error) {
      setConnectionStatus("offline");
      closeViewerPeer();
      setStreamError(
        error instanceof Error
          ? error.message
          : "Unable to connect to host stream.",
      );
    }
  }, [closeViewerPeer, viewerSession]);

  useEffect(() => {
    if (!viewerSession) {
      return;
    }

    function syncRoomState() {
      setRoomState(readLocalRoomState());
    }

    syncRoomState();
    const unsubscribe = subscribeToLocalRoom(syncRoomState);
    const initialSyncId = window.setTimeout(() => {
      void syncBackendState();
      void connectToLatestStream();
    }, 0);
    const reconnectId = window.setInterval(() => {
      void syncBackendState();
      if (!peerRef.current) {
        void connectToLatestStream();
      }
    }, 3000);
    const clockId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    const heartbeatId = window.setInterval(() => {
      if (!viewerSessionIdRef.current) {
        viewerSessionIdRef.current = viewerSession.id;
      }
      void sendViewerHeartbeat(viewerSessionIdRef.current).catch(() => {});
    }, 5000);

    if (!viewerSessionIdRef.current) {
      viewerSessionIdRef.current = viewerSession.id;
    }
    void sendViewerHeartbeat(viewerSessionIdRef.current).catch(() => {});

    return () => {
      unsubscribe();
      window.clearTimeout(initialSyncId);
      window.clearInterval(reconnectId);
      window.clearInterval(clockId);
      window.clearInterval(heartbeatId);
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
      }
      closeViewerPeer();
    };
  }, [closeViewerPeer, connectToLatestStream, syncBackendState, viewerSession]);

  useEffect(() => {
    if (!viewerSession || !backendState) {
      return;
    }
    const sessionStillActive = backendState.viewer_sessions.some(
      (session) => session.id === viewerSession.id,
    );
    if (!sessionStillActive) {
      const timeoutId = window.setTimeout(() => {
        setViewerSession(null);
        closeViewerPeer();
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [backendState, closeViewerPeer, viewerSession]);

  useEffect(() => {
    chatListRef.current?.scrollTo({
      top: chatListRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [roomState.updatedAt, messageStatus]);

  async function handleSubmitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = messageInput.trim();

    if (!trimmedMessage) {
      return;
    }

    if (!viewerSession) {
      setMessageError("Please log in before chatting.");
      return;
    }

    appendViewerMessage(trimmedMessage, viewerSession.username);
    if (viewerSessionIdRef.current) {
      void sendViewerMetricEvent(
        viewerSessionIdRef.current,
        "message",
        trimmedMessage,
      ).catch(() => {});
    }
    setRoomState(readLocalRoomState());
    setMessageInput("");
    setMessageStatus("sending");
    setMessageError("");

    try {
      const response = await sendViewerMessage(
        trimmedMessage,
        viewerSession.username,
      );
      setBackendState(response.state);
      if (response.suggested_reply) {
        appendAgentReply(response.suggested_reply);
        setRoomState(readLocalRoomState());
      }
    } catch (error) {
      setMessageError(
        error instanceof Error ? error.message : "Viewer message failed.",
      );
    } finally {
      setMessageStatus("idle");
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const username = loginInput.trim();
    if (!username) {
      setLoginError("Username is required.");
      return;
    }

    setLoginStatus("submitting");
    setLoginError("");
    try {
      const response = await loginViewer(username);
      setViewerSession(response.session);
      setBackendState(response.state);
      setLoginInput("");
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : "Viewer login failed.",
      );
    } finally {
      setLoginStatus("idle");
    }
  }

  async function handleLogout() {
    if (!viewerSession) {
      return;
    }

    const sessionId = viewerSession.id;
    setViewerSession(null);
    closeViewerPeer();
    try {
      await logoutViewer(sessionId);
    } catch {
      // The local session is already cleared; backend reset may have removed it.
    }
  }

  if (!viewerSession) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#f7f8fa] px-4">
        <form
          className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
          onSubmit={handleLogin}
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
            LiveCrew Viewer
          </p>
          <h1 className="mt-2 text-xl font-semibold text-slate-950">
            Enter the live room
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Use a unique username for this demo room.
          </p>
          <label className="mt-5 block text-sm font-semibold text-slate-900">
            Username
            <input
              className="mt-2 min-h-11 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none transition focus:border-teal-500 focus:bg-white"
              disabled={loginStatus === "submitting"}
              onChange={(event) => setLoginInput(event.target.value)}
              placeholder="alice"
              value={loginInput}
            />
          </label>
          {loginError ? (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
              {loginError}
            </p>
          ) : null}
          <button
            className="mt-4 min-h-11 w-full rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
            disabled={loginStatus === "submitting"}
            type="submit"
          >
            {loginStatus === "submitting" ? "Entering" : "Enter room"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh bg-[#f7f8fa] p-3 sm:items-center sm:justify-center">
      <div className="mx-auto flex h-[calc(100dvh-1.5rem)] max-h-[860px] w-full max-w-[430px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-slate-950 shadow-sm sm:rounded-[2rem]">
        <section className="relative flex-[2] overflow-hidden bg-slate-950">
          <video
            autoPlay
            className="absolute inset-0 h-full w-full object-cover"
            playsInline
            ref={remoteVideoRef}
          />

          <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/65 to-transparent px-4 py-3 text-white">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-white/70">
                {viewerSession.username}
              </p>
              <p className="text-sm font-semibold">Customer live room</p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  connectionStatus === "live" ? "bg-emerald-400" : "bg-amber-300"
                }`}
              />
              <span className="text-xs font-medium capitalize">
                {connectionStatus}
              </span>
              <button
                className="rounded-md border border-white/20 px-2 py-1 text-xs font-semibold text-white/85 transition hover:bg-white/10"
                onClick={() => void handleLogout()}
                type="button"
              >
                Logout
              </button>
            </div>
          </div>

          {connectionStatus !== "live" ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <div>
                <p className="text-base font-semibold text-white">
                  Host stream is {connectionStatus}
                </p>
                <p className="mt-2 text-sm leading-6 text-white/70">
                  Start the stream from the host cockpit, then connect here.
                </p>
                <button
                  className="mt-4 min-h-10 rounded-md border border-white/20 bg-white px-4 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
                  onClick={() => void connectToLatestStream()}
                  type="button"
                >
                  Connect
                </button>
                {streamError ? (
                  <p className="mt-3 text-xs leading-5 text-amber-200">
                    {streamError}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="absolute inset-x-3 bottom-3 rounded-md border border-white/15 bg-white/92 p-3 shadow-sm backdrop-blur">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold text-slate-950">
                  {displayProduct.name}
                </p>
                {isFlashSaleActive && activeFlashSale ? (
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <p className="text-lg font-bold text-rose-700">
                      {formatPrice(activeFlashSale.sale_price_cents)}
                    </p>
                    <p className="text-xs font-medium text-slate-500 line-through">
                      {displayProduct.price}
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-sm font-semibold text-teal-800">
                    {displayProduct.price}
                  </p>
                )}
              </div>
              <span className="shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                {displayProduct.stock} left
              </span>
            </div>
            <p className="mt-2 max-h-10 overflow-hidden text-sm leading-5 text-slate-700">
              {displayProduct.facts.slice(0, 2).join(". ")}
            </p>
            {isFlashSaleActive && activeFlashSale ? (
              <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase text-rose-900">
                    Flash sale
                  </p>
                  <p className="mt-0.5 truncate text-xs text-rose-700">
                    {activeFlashSale.remaining_stock}/{activeFlashSale.stock_limit} left
                  </p>
                </div>
                <div className="min-w-20 rounded-md bg-rose-700 px-3 py-1.5 text-center text-white shadow-sm">
                  <p className="text-[10px] font-semibold uppercase leading-none text-white/75">
                    Ends in
                  </p>
                  <p className="mt-1 font-mono text-xl font-bold leading-none">
                    {flashSaleSecondsLeft}s
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col border-t border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-950">Live chat</p>
              <p className="text-xs text-slate-500">Viewer messages and replies</p>
            </div>
            <StatusPill tone="good">Synced</StatusPill>
          </div>

          <div
            className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3"
            ref={chatListRef}
          >
            {initialReplies.map((reply) => (
              <div
                className={`max-w-[88%] rounded-md border px-3 py-2 ${
                  reply.tone === "agent"
                    ? "border-teal-200 bg-teal-50"
                    : "border-slate-200 bg-slate-50"
                }`}
                key={reply.id}
              >
                <p
                  className={`text-xs font-semibold ${
                    reply.tone === "agent" ? "text-teal-700" : "text-slate-500"
                  }`}
                >
                  {reply.sender}
                </p>
                <p className="mt-1 text-sm leading-5 text-slate-800">
                  {reply.message}
                </p>
              </div>
            ))}
            {mockChat.slice(0, 3).map((chat) => (
              <div
                className="ml-auto max-w-[88%] rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                key={`${chat.viewer}-${chat.message}`}
              >
                <p className="text-xs font-semibold text-slate-500">
                  {chat.viewer}
                </p>
                <p className="mt-1 text-sm leading-5 text-slate-800">
                  {chat.message}
                </p>
              </div>
            ))}
            {liveRoomMessages.map((message) => {
              const isViewer = message.sender === "viewer";
              const isAgent = message.sender === "agent";

              return (
                <div
                  className={`max-w-[88%] rounded-md border px-3 py-2 ${
                    isViewer
                      ? "ml-auto border-slate-200 bg-slate-50"
                      : isAgent
                        ? "border-teal-200 bg-teal-50"
                        : "border-slate-200 bg-white"
                  }`}
                  key={message.id}
                >
                  <p
                    className={`text-xs font-semibold ${
                      isAgent ? "text-teal-700" : "text-slate-500"
                    }`}
                  >
                    {message.name}
                  </p>
                  <p className="mt-1 text-sm leading-5 text-slate-800">
                    {message.text}
                  </p>
                </div>
              );
            })}
          </div>

          <form
            className="flex gap-2 border-t border-slate-100 bg-white p-3"
            onSubmit={handleSubmitMessage}
          >
            <label className="sr-only" htmlFor="viewer-message">
              Viewer message
            </label>
            <input
              className="min-h-10 min-w-0 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none transition focus:border-teal-500 focus:bg-white"
              id="viewer-message"
              onChange={(event) => setMessageInput(event.target.value)}
              placeholder="Ask about this product"
              value={messageInput}
            />
            <button
              className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
              disabled={messageStatus === "sending"}
              type="submit"
            >
              {messageStatus === "sending" ? "Sending" : "Send"}
            </button>
          </form>
          {messageError ? (
            <p className="border-t border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
              {messageError}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
