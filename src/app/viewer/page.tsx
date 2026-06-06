"use client";

import { AppShell, StatusPill } from "@/components/dashboard";
import { defaultActiveSkuId, getActiveSkuDisplay } from "@/lib/catalogue";
import {
  defaultLocalRoomState,
  type LocalRoomState,
  readLocalRoomState,
  subscribeToLocalRoom,
} from "@/lib/local-room";
import {
  type BackendState,
  type CheckoutIntent,
  cancelCheckoutIntent,
  confirmCheckoutIntent,
  fetchBackendState,
  fetchLatestMediaSession,
  fetchMediaSession,
  getBackendUrl,
  postIceCandidate,
  postMediaAnswer,
  sendViewerMessage,
  startCheckoutIntent,
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

const VIEWER_ID_STORAGE_KEY = "livecrew.viewer-id.v1";

function formatPrice(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function getViewerIdentity() {
  if (typeof window === "undefined") {
    return "viewer";
  }

  const existingId = window.localStorage.getItem(VIEWER_ID_STORAGE_KEY);
  if (existingId) {
    return existingId;
  }

  const nextId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `viewer-${crypto.randomUUID().slice(0, 8)}`
      : `viewer-${Date.now().toString(36)}`;
  window.localStorage.setItem(VIEWER_ID_STORAGE_KEY, nextId);
  return nextId;
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
  const [messageStatus, setMessageStatus] = useState<
    "idle" | "sending" | "failed"
  >("idle");
  const [remoteMuted, setRemoteMuted] = useState(true);
  const [purchaseQuantity, setPurchaseQuantity] = useState(1);
  const [checkoutIntent, setCheckoutIntent] = useState<CheckoutIntent | null>(
    null,
  );
  const [checkoutStatus, setCheckoutStatus] = useState<
    "idle" | "starting" | "confirming" | "cancelling"
  >("idle");
  const [checkoutError, setCheckoutError] = useState("");

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const hostCandidateCountRef = useRef(0);
  const pollRef = useRef<number | null>(null);
  const remoteMutedRef = useRef(true);

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
  const backendViewerComments = backendState?.viewer_comments ?? [];
  function getPurchasableQuantityForSku(skuId: string | null) {
    const sku = backendState?.skus.find((stateSku) => stateSku.id === skuId);
    if (!sku) {
      return 0;
    }
    const sale = backendState?.flash_sale;
    const saleCreatedAt = sale ? new Date(sale.created_at).getTime() : Number.NaN;
    const saleSecondsLeft =
      sale && !Number.isNaN(saleCreatedAt)
        ? Math.max(
            0,
            Math.ceil(
              (saleCreatedAt + sale.duration_seconds * 1000 - now) / 1000,
            ),
          )
        : 0;
    if (
      sale?.sku_id === sku.id &&
      saleSecondsLeft > 0 &&
      sale.remaining_stock > 0
    ) {
      return Math.min(sku.stock, sale.remaining_stock);
    }
    return sku.stock;
  }

  const purchasableQuantity = getPurchasableQuantityForSku(backendActiveSkuId);
  const cappedPurchaseQuantity = Math.min(
    Math.max(1, purchaseQuantity),
    Math.max(1, purchasableQuantity),
  );
  const checkoutProduct = checkoutIntent
    ? backendState?.skus.find((sku) => sku.id === checkoutIntent.sku_id)
    : null;
  const checkoutAvailableQuantity = checkoutIntent
    ? getPurchasableQuantityForSku(checkoutIntent.sku_id)
    : purchasableQuantity;

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
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }, []);

  const connectToLatestStream = useCallback(async () => {
    closeViewerPeer();

    setConnectionStatus("connecting");
    setStreamError("");

    try {
      const session = await fetchLatestMediaSession();
      if (!session.offer || session.status === "stopped") {
        setConnectionStatus("offline");
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
          const video = remoteVideoRef.current;
          video.srcObject = stream;
          video.muted = remoteMutedRef.current;
          video.play().catch(() => {
            setStreamError("Tap Connect to allow video playback in this browser.");
          });
          setConnectionStatus("live");
        }
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
          setConnectionStatus("offline");
          closeViewerPeer();
        }
      };
      peer.onicecandidate = (event) => {
        if (event.candidate && sessionIdRef.current) {
          void postIceCandidate(
            sessionIdRef.current,
            "viewer",
            event.candidate.toJSON(),
          );
        }
      };

      await peer.setRemoteDescription(session.offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await postMediaAnswer(session.session_id, answer);

      pollRef.current = window.setInterval(async () => {
        if (!sessionIdRef.current || !peerRef.current) {
          return;
        }
        const latest = await fetchMediaSession(sessionIdRef.current);
        if (latest.status === "stopped") {
          closeViewerPeer();
          setConnectionStatus("offline");
          return;
        }
        const newCandidates = latest.host_candidates.slice(
          hostCandidateCountRef.current,
        );
        hostCandidateCountRef.current = latest.host_candidates.length;
        for (const candidate of newCandidates) {
          await peerRef.current.addIceCandidate(candidate);
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
  }, [closeViewerPeer]);

  useEffect(() => {
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

    return () => {
      unsubscribe();
      window.clearTimeout(initialSyncId);
      window.clearInterval(reconnectId);
      window.clearInterval(clockId);
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
      }
      closeViewerPeer();
    };
  }, [closeViewerPeer, connectToLatestStream, syncBackendState]);

  function toggleRemoteAudio() {
    const nextMuted = !remoteMuted;
    setRemoteMuted(nextMuted);
    remoteMutedRef.current = nextMuted;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = nextMuted;
      if (!nextMuted) {
        remoteVideoRef.current.play().catch(() => {
          setStreamError("Browser blocked audio playback. Try Connect again.");
        });
      }
    }
  }

  async function handleSubmitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = messageInput.trim();

    if (!trimmedMessage) {
      return;
    }

    setMessageStatus("sending");
    try {
      const response = await sendViewerMessage(
        trimmedMessage,
        getViewerIdentity(),
      );
      setBackendState(response.state);
      setMessageInput("");
      setMessageStatus("idle");
    } catch {
      setMessageStatus("failed");
    }
  }

  function updatePurchaseQuantity(nextQuantity: number) {
    setPurchaseQuantity(
      Math.min(Math.max(1, nextQuantity), Math.max(1, purchasableQuantity)),
    );
  }

  async function handleStartCheckout() {
    if (!backendActiveSkuId || purchasableQuantity < 1) {
      return;
    }

    setCheckoutStatus("starting");
    setCheckoutError("");
    try {
      const response = await startCheckoutIntent(
        backendActiveSkuId,
        cappedPurchaseQuantity,
        getViewerIdentity(),
      );
      setBackendState(response.state);
      setCheckoutIntent(response.checkout_intent);
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Unable to start checkout.",
      );
    } finally {
      setCheckoutStatus("idle");
    }
  }

  async function handleCancelCheckout() {
    if (!checkoutIntent || checkoutIntent.status !== "pending") {
      setCheckoutIntent(null);
      return;
    }

    setCheckoutStatus("cancelling");
    setCheckoutError("");
    try {
      const response = await cancelCheckoutIntent(checkoutIntent.id);
      setBackendState(response.state);
      setCheckoutIntent(null);
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Unable to cancel checkout.",
      );
    } finally {
      setCheckoutStatus("idle");
    }
  }

  async function handleConfirmCheckout() {
    if (!checkoutIntent) {
      return;
    }

    setCheckoutStatus("confirming");
    setCheckoutError("");
    try {
      const response = await confirmCheckoutIntent(checkoutIntent.id);
      setBackendState(response.state);
      setCheckoutIntent(null);
      setPurchaseQuantity(1);
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : "Unable to confirm checkout.",
      );
    } finally {
      setCheckoutStatus("idle");
    }
  }

  return (
    <AppShell
      eyebrow="Viewer"
      title="Customer livestream room"
      description={`Python backend: ${getBackendUrl()}`}
    >
      <div className="mx-auto flex h-[calc(100dvh-11rem)] max-h-[860px] w-full max-w-[430px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-slate-950 shadow-sm">
        <section className="relative flex-[2] overflow-hidden bg-slate-950">
          <video
            autoPlay
            className="absolute inset-0 h-full w-full object-cover"
            muted={remoteMuted}
            playsInline
            ref={remoteVideoRef}
          />

          <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/65 to-transparent px-4 py-3 text-white">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-white/70">
                LiveCrew
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

          {connectionStatus === "live" ? (
            <div className="absolute right-3 top-16 flex gap-2">
              <button
                className="min-h-9 rounded-md border border-white/20 bg-black/55 px-3 text-xs font-semibold text-white backdrop-blur transition hover:bg-black/70"
                onClick={toggleRemoteAudio}
                type="button"
              >
                {remoteMuted ? "Unmute" : "Mute"}
              </button>
              <button
                className="min-h-9 rounded-md border border-white/20 bg-black/55 px-3 text-xs font-semibold text-white backdrop-blur transition hover:bg-black/70"
                onClick={() => void connectToLatestStream()}
                type="button"
              >
                Reconnect
              </button>
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
            <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
              <div className="flex min-h-10 items-center overflow-hidden rounded-md border border-slate-200 bg-white">
                <button
                  className="h-10 w-10 text-base font-semibold text-slate-700 transition hover:bg-slate-100 disabled:text-slate-300"
                  disabled={cappedPurchaseQuantity <= 1 || checkoutStatus !== "idle"}
                  onClick={() => updatePurchaseQuantity(cappedPurchaseQuantity - 1)}
                  type="button"
                >
                  -
                </button>
                <span className="min-w-10 text-center text-sm font-semibold text-slate-900">
                  {cappedPurchaseQuantity}
                </span>
                <button
                  className="h-10 w-10 text-base font-semibold text-slate-700 transition hover:bg-slate-100 disabled:text-slate-300"
                  disabled={
                    cappedPurchaseQuantity >= purchasableQuantity ||
                    checkoutStatus !== "idle"
                  }
                  onClick={() => updatePurchaseQuantity(cappedPurchaseQuantity + 1)}
                  type="button"
                >
                  +
                </button>
              </div>
              <p className="min-w-0 truncate text-xs text-slate-500">
                {purchasableQuantity} available
              </p>
              <button
                className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                disabled={
                  !backendActiveSkuId ||
                  purchasableQuantity < 1 ||
                  checkoutStatus !== "idle"
                }
                onClick={() => void handleStartCheckout()}
                type="button"
              >
                {checkoutStatus === "starting" ? "Opening" : "Buy"}
              </button>
            </div>
            {checkoutError ? (
              <p className="mt-2 text-xs leading-5 text-amber-700">
                {checkoutError}
              </p>
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

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
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
            {roomState.replies.map((reply) => (
              <div
                className="max-w-[88%] rounded-md border border-teal-200 bg-teal-50 px-3 py-2"
                key={reply.id}
              >
                <p className="text-xs font-semibold text-teal-700">
                  {reply.name}
                </p>
                <p className="mt-1 text-sm leading-5 text-slate-800">
                  {reply.text}
                </p>
              </div>
            ))}
            {[...backendViewerComments].reverse().map((chat) => (
              <div
                className="ml-auto max-w-[88%] rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
                key={chat.id}
              >
                <p className="text-xs font-semibold text-slate-500">
                  {chat.viewer}
                </p>
                <p className="mt-1 text-sm leading-5 text-slate-800">
                  {chat.text}
                </p>
              </div>
            ))}
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
              className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800"
              disabled={messageStatus === "sending"}
              type="submit"
            >
              {messageStatus === "sending" ? "Sending" : "Send"}
            </button>
          </form>
          {messageStatus === "failed" ? (
            <p className="border-t border-amber-100 bg-amber-50 px-4 py-2 text-xs leading-5 text-amber-800">
              Backend chat is unavailable. Start FastAPI on port 8000 and try again.
            </p>
          ) : null}
        </section>
      </div>
      {checkoutIntent ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-4 py-5 sm:items-center">
          <div
            aria-modal="true"
            className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
                  Confirm purchase
                </p>
                <h2 className="mt-1 text-lg font-semibold text-slate-950">
                  {checkoutProduct?.name ?? displayProduct.name}
                </h2>
              </div>
              <button
                className="min-h-9 rounded-md border border-slate-200 px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
                disabled={checkoutStatus !== "idle"}
                onClick={() => void handleCancelCheckout()}
                type="button"
              >
                Close
              </button>
            </div>
            <dl className="mt-4 grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Unit price</dt>
                <dd className="font-semibold text-slate-950">
                  {formatPrice(checkoutIntent.unit_price_cents)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Quantity</dt>
                <dd className="font-semibold text-slate-950">
                  {checkoutIntent.quantity}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Available now</dt>
                <dd className="font-semibold text-slate-950">
                  {checkoutAvailableQuantity}
                </dd>
              </div>
              <div className="border-t border-slate-200 pt-3 flex justify-between gap-3">
                <dt className="text-slate-700">Total</dt>
                <dd className="text-base font-bold text-slate-950">
                  {formatPrice(checkoutIntent.total_price_cents)}
                </dd>
              </div>
            </dl>
            {checkoutError ? (
              <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                {checkoutError}
              </p>
            ) : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                className="min-h-11 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 disabled:text-slate-400"
                disabled={checkoutStatus !== "idle"}
                onClick={() => void handleCancelCheckout()}
                type="button"
              >
                Cancel
              </button>
              <button
                className="min-h-11 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                disabled={
                  checkoutStatus !== "idle" ||
                  checkoutIntent.quantity > checkoutAvailableQuantity
                }
                onClick={() => void handleConfirmCheckout()}
                type="button"
              >
                {checkoutStatus === "confirming" ? "Confirming" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
