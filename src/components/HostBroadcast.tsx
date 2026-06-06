"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Radio, VideoOff } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import {
  getWebrtcSignal,
  postWebrtcDescription,
  resetWebrtcSignal,
  waitForIceGatheringComplete,
} from "@/lib/webrtc-signaling";

type BroadcastState = "idle" | "requesting" | "publishing" | "connected" | "blocked" | "unsupported";

function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [],
  });
}

async function tuneVideoSender(sender: RTCRtpSender) {
  const parameters = sender.getParameters();

  parameters.encodings = [
    {
      ...(parameters.encodings?.[0] ?? {}),
      maxBitrate: 4_000_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 1,
    },
  ];

  await sender.setParameters(parameters);
}

export function HostBroadcast() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pollRef = useRef<number | null>(null);
  const [broadcastState, setBroadcastState] = useState<BroadcastState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }

      peerRef.current?.close();
      peerRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      void resetWebrtcSignal().catch(() => {});
    };
  }, []);

  function clearAnswerPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function cleanupMedia() {
    clearAnswerPolling();
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  async function startBroadcast() {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setBroadcastState("unsupported");
      setErrorMessage("WebRTC camera publishing is not available in this browser.");
      return;
    }

    setBroadcastState("requesting");
    setErrorMessage(null);

    try {
      await resetWebrtcSignal();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: "user",
        },
        audio: true,
      });
      const peer = createPeerConnection();

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setBroadcastState("connected");
        }
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          setBroadcastState("publishing");
        }
      };

      stream.getVideoTracks().forEach((track) => {
        track.contentHint = "motion";
        const sender = peer.addTrack(track, stream);
        void tuneVideoSender(sender).catch(() => {});
      });
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));
      streamRef.current = stream;
      peerRef.current = peer;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);

      if (!peer.localDescription) {
        throw new Error("Host offer was not created.");
      }

      await postWebrtcDescription("host", {
        type: "offer",
        sdp: peer.localDescription.sdp,
      });
      setBroadcastState("publishing");

      pollRef.current = window.setInterval(() => {
        void getWebrtcSignal()
          .then(async (signal) => {
            if (!signal.answer || peer.signalingState !== "have-local-offer") {
              return;
            }

            await peer.setRemoteDescription(signal.answer);
            clearAnswerPolling();
          })
          .catch((error: unknown) => {
            setErrorMessage(error instanceof Error ? error.message : "Viewer answer polling failed.");
          });
      }, 1000);
    } catch (error) {
      cleanupMedia();
      setBroadcastState("blocked");
      setErrorMessage(error instanceof Error ? error.message : "Unable to start broadcast.");
    }
  }

  function stopBroadcast() {
    cleanupMedia();
    setBroadcastState("idle");
    void resetWebrtcSignal().catch(() => {});
  }

  const isActive = ["publishing", "connected"].includes(broadcastState);

  return (
    <div className="overflow-hidden rounded-md border border-slate-800 bg-slate-950 text-white">
      <div className="relative aspect-video min-h-[220px] bg-black">
        <video
          ref={videoRef}
          className={`h-full w-full object-contain ${isActive ? "block" : "hidden"}`}
          muted
          playsInline
        />

        {!isActive ? (
          <div className="flex h-full min-h-[220px] items-center justify-center p-6 text-center">
            <div>
              <Camera className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold uppercase text-slate-300">
                Host Broadcast
              </p>
              <p className="mt-2 text-2xl font-semibold">Stream offline</p>
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
          <StatusPill tone={isActive ? "live" : "neutral"}>
            {broadcastState === "requesting"
              ? "Requesting"
              : broadcastState === "connected"
                ? "Viewer connected"
                : isActive
                  ? "Publishing"
                  : "Offline"}
          </StatusPill>
          {isActive ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase text-slate-300">
              <Radio className="h-3.5 w-3.5" aria-hidden="true" />
              WebRTC offer ready
            </span>
          ) : null}
        </div>

        <button
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-white px-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={isActive || broadcastState === "requesting" ? stopBroadcast : startBroadcast}
        >
          {isActive || broadcastState === "requesting" ? (
            <VideoOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Camera className="h-4 w-4" aria-hidden="true" />
          )}
          {isActive || broadcastState === "requesting" ? "Stop stream" : "Start stream"}
        </button>
      </div>
    </div>
  );
}
