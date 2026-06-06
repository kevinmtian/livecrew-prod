"use client";

import { StatusPill } from "@/components/dashboard";
import {
  appendAgentReply,
  appendViewerMessage,
  defaultLocalRoomState,
  markViewerMessageHandledByAgent,
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

type ExclusiveCoupon = {
  percent: number;
};

const initialReplies: RoomReply[] = [
  {
    id: "reply-host-001",
    sender: "Host",
    message:
      "The shelf is ready. I will mount the first product card once we start the live demo.",
    tone: "host",
  },
  {
    id: "reply-agent-001",
    sender: "LiveCrew Agent",
    message:
      "LiveCrew is standing by for the host to list the first SKU.",
    tone: "agent",
  },
];

const skuImages: Record<string, { src: string; alt: string }> = {
  "glowfix-vitamin-c-serum": {
    src: "https://images.unsplash.com/photo-1723951174326-2a97221d3b7f?auto=format&fit=crop&q=70&w=240&h=240",
    alt: "Vitamin C serum bottle on citrus slices",
  },
  "hydramist-cushion-spf": {
    src: "https://images.unsplash.com/photo-1768369712397-f1a9fa19ea27?auto=format&fit=crop&q=70&w=240&h=240",
    alt: "Compact cushion foundation product",
  },
  "bamboo-thermal-tumbler": {
    src: "https://images.unsplash.com/photo-1561180796-dbaa5caf76e0?auto=format&fit=crop&q=70&w=240&h=240",
    alt: "Blue reusable tumbler bottle",
  },
  "satin-cloud-sleep-mask": {
    src: "https://images.unsplash.com/photo-1742794565428-1a74fa73f1c9?auto=format&fit=crop&q=70&w=240&h=240",
    alt: "Satin sleep mask on bedding",
  },
};

function formatPrice(priceCents: number) {
  return `$${(priceCents / 100).toFixed(2)}`;
}

function getRandomCouponPercent() {
  return Math.floor(Math.random() * 6) + 5;
}

function CartIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M6 6h15l-1.5 8.5a2 2 0 0 1-2 1.5H9a2 2 0 0 1-2-1.6L5 3H2" />
      <circle cx="9" cy="20" r="1" />
      <circle cx="18" cy="20" r="1" />
    </svg>
  );
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
  const [backendState, setBackendState] = useState<BackendState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [messageStatus, setMessageStatus] = useState<"idle" | "sending">("idle");
  const [messageError, setMessageError] = useState("");
  const [viewerSession, setViewerSession] = useState<ViewerSession | null>(null);
  const [loginInput, setLoginInput] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "submitting">("idle");
  const [loginError, setLoginError] = useState("");
  const [cartOpen, setCartOpen] = useState(false);
  const [cartItems, setCartItems] = useState<Record<string, number>>({});
  const [checkoutConfirmOpen, setCheckoutConfirmOpen] = useState(false);
  const [checkoutStatus, setCheckoutStatus] = useState<"idle" | "submitting">("idle");
  const [exclusiveCoupon, setExclusiveCoupon] = useState<ExclusiveCoupon | null>(null);
  const [couponPromptOpen, setCouponPromptOpen] = useState(false);
  const [couponDismissConfirmOpen, setCouponDismissConfirmOpen] = useState(false);

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const hostCandidateCountRef = useRef(0);
  const pollRef = useRef<number | null>(null);
  const viewerSessionIdRef = useRef<string | null>(null);
  const couponTimerRef = useRef<number | null>(null);

  const backendActiveSkuId = backendState?.active_sku_id ?? null;
  const activeBackendSku = backendState?.skus.find(
    (sku) => sku.id === backendActiveSkuId,
  );
  const displayProduct = activeBackendSku
    ? {
        name: activeBackendSku.name,
        price: formatPrice(activeBackendSku.price_cents),
        stock: activeBackendSku.stock,
        facts: activeBackendSku.facts,
      }
    : null;
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
  const getSkuUnitPriceCents = (sku: { id: string; price_cents: number }) =>
    isFlashSaleActive && activeFlashSale?.sku_id === sku.id
      ? activeFlashSale.sale_price_cents
      : sku.price_cents;
  const productShelf = backendState?.skus.length && backendActiveSkuId
    ? [
        ...backendState.skus.filter((sku) => sku.id === backendActiveSkuId),
        ...backendState.skus.filter((sku) => sku.id !== backendActiveSkuId),
      ]
    : [];
  const activeProductImage = backendActiveSkuId
    ? skuImages[backendActiveSkuId]
    : undefined;
  const cartCount = Object.values(cartItems).reduce(
    (total, quantity) => total + quantity,
    0,
  );
  const cartTotalCents = productShelf.reduce((total, sku) => {
    const quantity = cartItems[sku.id] ?? 0;
    const unitPrice = getSkuUnitPriceCents(sku);
    return total + quantity * unitPrice;
  }, 0);
  const cartTotal = cartTotalCents > 0 ? formatPrice(cartTotalCents) : null;
  const couponDiscountCents =
    exclusiveCoupon && cartTotalCents > 0
      ? Math.min(
          Math.round((cartTotalCents * exclusiveCoupon.percent) / 100),
          Math.round(cartTotalCents * 0.1),
        )
      : 0;
  const discountedCartTotalCents = Math.max(0, cartTotalCents - couponDiscountCents);
  const discountedCartTotal =
    discountedCartTotalCents > 0 ? formatPrice(discountedCartTotalCents) : null;
  const isHostLive =
    connectionStatus === "live" && roomState.hostStreamStatus === "live";
  const checkoutLines = productShelf
    .map((sku) => ({
      sku,
      quantity: cartItems[sku.id] ?? 0,
      unitPriceCents: getSkuUnitPriceCents(sku),
    }))
    .filter((item) => item.quantity > 0);
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
          return;
        }
      }, 1000);
    } catch {
      setConnectionStatus("offline");
      closeViewerPeer();
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

  useEffect(() => {
    if (cartCount <= 0) {
      if (couponTimerRef.current) {
        window.clearTimeout(couponTimerRef.current);
        couponTimerRef.current = null;
      }
      const clearCouponId = window.setTimeout(() => {
        setExclusiveCoupon(null);
        setCouponPromptOpen(false);
        setCouponDismissConfirmOpen(false);
      }, 0);
      return () => window.clearTimeout(clearCouponId);
    }

    if (exclusiveCoupon || couponTimerRef.current) {
      return;
    }

    couponTimerRef.current = window.setTimeout(() => {
      couponTimerRef.current = null;
      setExclusiveCoupon({
        percent: getRandomCouponPercent(),
      });
      setCouponPromptOpen(true);
    }, 10000);

    return () => {
      if (couponTimerRef.current) {
        window.clearTimeout(couponTimerRef.current);
        couponTimerRef.current = null;
      }
    };
  }, [cartCount, exclusiveCoupon]);

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

    const viewerMessage = appendViewerMessage(trimmedMessage, viewerSession.username);
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
        markViewerMessageHandledByAgent(viewerMessage.id);
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

  async function handleCheckout() {
    if (!viewerSession || cartCount <= 0) {
      return;
    }

    const orderLines = checkoutLines;
    setMessageError("");
    setCheckoutStatus("submitting");

    try {
      let latestBackendState: BackendState | null = null;
      for (const item of orderLines) {
        const orderText = `I want to order ${item.quantity} x ${item.sku.name}.`;
        const response = await sendViewerMessage(orderText, viewerSession.username);
        latestBackendState = response.state;
        if (viewerSessionIdRef.current) {
          void sendViewerMetricEvent(
            viewerSessionIdRef.current,
            "order",
            orderText,
          ).catch(() => {});
        }
      }
      if (latestBackendState) {
        setBackendState(latestBackendState);
      }
      setCartItems({});
      setCartOpen(false);
      setCheckoutConfirmOpen(false);
      setExclusiveCoupon(null);
      setCouponPromptOpen(false);
      setCouponDismissConfirmOpen(false);
      if (viewerSessionIdRef.current) {
        void syncBackendState();
      }
    } catch (error) {
      setMessageError(
        error instanceof Error ? error.message : "Checkout failed.",
      );
    } finally {
      setCheckoutStatus("idle");
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
              <p className="text-sm font-semibold">Live room</p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  isHostLive ? "bg-emerald-400" : "bg-amber-300"
                }`}
              />
              <span className="text-xs font-medium capitalize">
                {isHostLive ? "live" : "offline"}
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

          {!isHostLive ? (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <p className="text-lg font-semibold text-white">Not live</p>
            </div>
          ) : null}

          {displayProduct ? (
          <div className="absolute inset-x-3 bottom-3 rounded-md border border-white/15 bg-white/92 p-3 shadow-sm backdrop-blur">
            {!cartOpen ? (
              <>
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3">
                  <div className="h-28 w-28 overflow-hidden rounded-md bg-slate-200">
                    {activeProductImage ? (
                      <img
                        alt={activeProductImage.alt}
                        className="h-full w-full object-cover"
                        src={activeProductImage.src}
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-base font-semibold leading-5 text-slate-950">
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
                    <p className="mt-2 max-h-16 overflow-hidden text-sm leading-5 text-slate-700">
                      {displayProduct.facts.slice(0, 2).join(". ")}
                    </p>
                  </div>
                </div>
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
                <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-2">
                  <button
                    className="relative flex min-h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:bg-slate-300"
                    onClick={() => setCartOpen((isOpen) => !isOpen)}
                    type="button"
                  >
                    <CartIcon />
                    Cart
                    {cartCount > 0 ? (
                      <span className="absolute -right-2 -top-2 min-w-5 rounded-full bg-rose-600 px-1.5 py-0.5 text-center text-[11px] leading-none text-white">
                        {cartCount}
                      </span>
                    ) : null}
                  </button>
                  <button
                    className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                    disabled={cartCount <= 0 || checkoutStatus === "submitting"}
                    onClick={() => setCheckoutConfirmOpen(true)}
                    type="button"
                  >
                    {discountedCartTotal ? `Checkout ${discountedCartTotal}` : "Checkout"}
                  </button>
                </div>
                {cartCount > 0 ? (
                  <div className="mt-2 flex items-center justify-between rounded-md border border-teal-100 bg-teal-50 px-3 py-2 text-xs text-teal-900">
                    <span className="font-semibold">
                      Cart: {cartCount} item{cartCount === 1 ? "" : "s"}
                    </span>
                    <button
                      className="font-semibold text-teal-800 underline-offset-2 hover:underline"
                      onClick={() => setCartOpen(true)}
                      type="button"
                    >
                      Edit
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            {cartOpen ? (
              <div className="rounded-md border border-slate-200 bg-white p-2">
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Product cart
                  </p>
                  <div className="flex items-center gap-2">
                    {cartCount > 0 ? (
                      <button
                        className="text-xs font-semibold text-teal-800 underline-offset-2 hover:underline"
                        onClick={() => setCartItems({})}
                        type="button"
                      >
                        Clear
                      </button>
                    ) : null}
                    <button
                      aria-label="Close cart"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
                      onClick={() => setCartOpen(false)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                  {productShelf.map((sku) => {
                    const quantity = cartItems[sku.id] ?? 0;
                    const skuFlashSale =
                      isFlashSaleActive && activeFlashSale?.sku_id === sku.id
                        ? activeFlashSale
                        : null;
                    const priceCents = getSkuUnitPriceCents(sku);
                    const stockLimit = skuFlashSale?.remaining_stock ?? sku.stock;
                    const isActiveSku = sku.id === backendActiveSkuId;
                    const image = skuImages[sku.id];

                    return (
                      <div
                        className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-slate-100 bg-slate-50 p-2"
                        key={sku.id}
                      >
                        <div className="h-14 w-14 overflow-hidden rounded-md bg-slate-200">
                          {image ? (
                            <img
                              alt={image.alt}
                              className="h-full w-full object-cover"
                              src={image.src}
                            />
                          ) : null}
                        </div>
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <p className="truncate text-sm font-semibold text-slate-950">
                              {sku.name}
                            </p>
                            {isActiveSku ? (
                              <span className="shrink-0 rounded-sm bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700">
                                Live now
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {formatPrice(priceCents)} · {stockLimit} left
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-sm font-bold text-slate-700 disabled:text-slate-300"
                            disabled={quantity <= 0}
                            onClick={() =>
                              setCartItems((current) => ({
                                ...current,
                                [sku.id]: Math.max((current[sku.id] ?? 0) - 1, 0),
                              }))
                            }
                            type="button"
                          >
                            -
                          </button>
                          <span className="w-6 text-center text-sm font-semibold text-slate-950">
                            {quantity}
                          </span>
                          <button
                            className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-950 text-sm font-bold text-white disabled:bg-slate-300"
                            disabled={quantity >= stockLimit || stockLimit <= 0}
                            onClick={() =>
                              setCartItems((current) => ({
                                ...current,
                                [sku.id]: Math.min(
                                  (current[sku.id] ?? 0) + 1,
                                  stockLimit,
                                ),
                              }))
                            }
                            type="button"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button
                  className="mt-3 min-h-10 w-full rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                  disabled={cartCount <= 0 || checkoutStatus === "submitting"}
                  onClick={() => setCheckoutConfirmOpen(true)}
                  type="button"
                >
                  {discountedCartTotal ? `Checkout ${discountedCartTotal}` : "Checkout"}
                </button>
              </div>
            ) : null}
          </div>
          ) : null}
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
      {couponPromptOpen && exclusiveCoupon ? (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/35 p-3 sm:items-center">
          <div className="w-full max-w-[360px] rounded-lg border border-teal-200 bg-white p-4 shadow-xl">
            {couponDismissConfirmOpen ? (
              <>
                <div className="rounded-md border border-rose-100 bg-rose-50 px-3 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">
                    Give up your exclusive discount?
                  </p>
                  <p className="mt-1 text-2xl font-bold text-slate-950">
                    You will lose {exclusiveCoupon.percent}% off
                  </p>
                  <p className="mt-2 text-sm leading-5 text-slate-700">
                    This private offer will not be saved after you close it.
                  </p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    className="min-h-10 rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                    onClick={() => setCouponDismissConfirmOpen(false)}
                    type="button"
                  >
                    Keep offer
                  </button>
                  <button
                    className="min-h-10 rounded-md border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
                    onClick={() => {
                      setCouponDismissConfirmOpen(false);
                      setCouponPromptOpen(false);
                      setExclusiveCoupon(null);
                    }}
                    type="button"
                  >
                    Give up
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex justify-end">
                  <button
                    aria-label="Dismiss exclusive offer"
                    className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900"
                    onClick={() => setCouponDismissConfirmOpen(true)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
                <div className="rounded-md border border-teal-100 bg-teal-50 px-3 py-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
                    Your exclusive offer
                  </p>
                  <p className="mt-1 text-3xl font-bold text-slate-950">
                    {exclusiveCoupon.percent}% off
                  </p>
                  <p className="mt-2 text-sm leading-5 text-slate-700">
                    This private checkout coupon is available right now. Use it before
                    closing this offer, or the savings will be released.
                  </p>
                </div>
                <div className="mt-3">
                  <button
                    className="min-h-10 w-full rounded-md bg-teal-700 px-3 text-sm font-semibold text-white transition hover:bg-teal-800"
                    onClick={() => {
                      setCouponPromptOpen(false);
                      setCouponDismissConfirmOpen(false);
                      setCheckoutConfirmOpen(true);
                    }}
                    type="button"
                  >
                    Apply offer
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
      {checkoutConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-3 sm:items-center">
          <div className="w-full max-w-[400px] rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-slate-950">
                  Confirm order
                </p>
                <p className="mt-1 text-sm text-slate-500">
                  Review price and quantity before checkout.
                </p>
              </div>
              <button
                className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                disabled={checkoutStatus === "submitting"}
                onClick={() => setCheckoutConfirmOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="mt-4 space-y-2">
              {checkoutLines.map((item) => {
                const image = skuImages[item.sku.id];
                return (
                  <div
                    className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-slate-100 bg-slate-50 p-2"
                    key={item.sku.id}
                  >
                    <div className="h-12 w-12 overflow-hidden rounded-md bg-slate-200">
                      {image ? (
                        <img
                          alt={image.alt}
                          className="h-full w-full object-cover"
                          src={image.src}
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-950">
                        {item.sku.name}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatPrice(item.unitPriceCents)} x {item.quantity}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-slate-950">
                      {formatPrice(item.unitPriceCents * item.quantity)}
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Total
                </p>
                {exclusiveCoupon && couponDiscountCents > 0 ? (
                  <div className="mt-1 space-y-1">
                    <p className="text-sm text-slate-500 line-through">
                      {cartTotal ?? "$0.00"}
                    </p>
                    <p className="text-xs font-semibold text-teal-700">
                      Exclusive coupon -{exclusiveCoupon.percent}% (
                      {formatPrice(couponDiscountCents)})
                    </p>
                    <p className="text-xl font-bold text-slate-950">
                      {discountedCartTotal ?? "$0.00"}
                    </p>
                  </div>
                ) : (
                  <p className="mt-1 text-xl font-bold text-slate-950">
                    {cartTotal ?? "$0.00"}
                  </p>
                )}
              </div>
              <button
                className="min-h-10 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:bg-slate-300"
                disabled={checkoutStatus === "submitting" || checkoutLines.length === 0}
                onClick={() => void handleCheckout()}
                type="button"
              >
                {checkoutStatus === "submitting" ? "Placing order" : "Place order"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
