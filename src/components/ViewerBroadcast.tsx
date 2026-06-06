"use client";

import { useEffect, useRef, useState } from "react";
import { Radio, RotateCcw, Video } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import {
  getWebrtcSignal,
  postWebrtcDescription,
  waitForIceGatheringComplete,
} from "@/lib/webrtc-signaling";

type ViewerStreamState = "idle" | "waiting" | "connecting" | "live" | "failed" | "unsupported";

function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [],
  });
}

export function ViewerBroadcast() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const retryRef = useRef<number | null>(null);
  const [streamState, setStreamState] = useState<ViewerStreamState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (retryRef.current) {
        window.clearInterval(retryRef.current);
        retryRef.current = null;
      }

      peerRef.current?.close();
      peerRef.current = null;
    };
  }, []);

  function clearRetry() {
    if (retryRef.current) {
      window.clearInterval(retryRef.current);
      retryRef.current = null;
    }
  }

  function disconnect() {
    clearRetry();
    peerRef.current?.close();
    peerRef.current = null;

    if (videoRef.current) {
      const stream = videoRef.current.srcObject as MediaStream | null;
      stream?.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }

    setStreamState("idle");
  }

  async function connectOnce() {
    if (typeof RTCPeerConnection === "undefined") {
      setStreamState("unsupported");
      setErrorMessage("WebRTC playback is not available in this browser.");
      return false;
    }

    const signal = await getWebrtcSignal();

    if (!signal.offer) {
      setStreamState("waiting");
      return false;
    }

    setStreamState("connecting");
    setErrorMessage(null);

    const peer = createPeerConnection();
    peerRef.current = peer;

    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;

      if (videoRef.current && remoteStream) {
        videoRef.current.srcObject = remoteStream;
        void videoRef.current.play();
      }
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") {
        setStreamState("live");
      }
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        setStreamState("failed");
      }
    };

    await peer.setRemoteDescription(signal.offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForIceGatheringComplete(peer);

    if (!peer.localDescription) {
      throw new Error("Viewer answer was not created.");
    }

    await postWebrtcDescription("viewer", {
      type: "answer",
      sdp: peer.localDescription.sdp,
    });

    return true;
  }

  async function connectToStream() {
    clearRetry();

    try {
      const connected = await connectOnce();

      if (!connected) {
        retryRef.current = window.setInterval(() => {
          void connectOnce()
            .then((didConnect) => {
              if (didConnect) {
                clearRetry();
              }
            })
            .catch((error: unknown) => {
              setStreamState("failed");
              setErrorMessage(error instanceof Error ? error.message : "Unable to connect stream.");
            });
        }, 1500);
      }
    } catch (error) {
      setStreamState("failed");
      setErrorMessage(error instanceof Error ? error.message : "Unable to connect stream.");
    }
  }

  const isLive = streamState === "live" || streamState === "connecting";

  return (
    <div className="overflow-hidden rounded-md border border-slate-800 bg-slate-950 text-white">
      <div className="relative aspect-video min-h-[240px] bg-black">
        <video
          ref={videoRef}
          className={`h-full w-full object-contain ${isLive ? "block" : "hidden"}`}
          playsInline
          controls
        />

        {!isLive ? (
          <div className="flex h-full min-h-[240px] items-center justify-center p-6 text-center">
            <div>
              <Video className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold uppercase text-slate-300">
                Live Stream
              </p>
              <p className="mt-2 text-3xl font-semibold">
                {streamState === "waiting" ? "Waiting for host" : "Stream offline"}
              </p>
              {errorMessage ? (
                <p className="mt-2 max-w-md text-sm leading-6 text-rose-200">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-slate-800 bg-slate-900 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={streamState === "live" ? "live" : "neutral"}>
            {streamState === "live"
              ? "Live"
              : streamState === "connecting"
                ? "Connecting"
                : streamState === "waiting"
                  ? "Waiting"
                  : "Offline"}
          </StatusPill>
          <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase text-slate-300">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            WebRTC viewer
          </span>
        </div>

        <button
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-white px-3 text-sm font-semibold text-slate-950"
          type="button"
          onClick={streamState === "live" || streamState === "connecting" ? disconnect : connectToStream}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {streamState === "live" || streamState === "connecting" ? "Disconnect" : "Connect stream"}
        </button>
      </div>
    </div>
  );
}
