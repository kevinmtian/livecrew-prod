"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Mic, VideoOff } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";

type PermissionState = "idle" | "requesting" | "live" | "blocked" | "unsupported";

export function CameraPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [permissionState, setPermissionState] = useState<PermissionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const currentVideo = videoRef.current;

    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;

      if (currentVideo) {
        currentVideo.srcObject = null;
      }
    };
  }, []);

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermissionState("unsupported");
      setErrorMessage("Camera capture is not available in this browser.");
      return;
    }

    setPermissionState("requesting");
    setErrorMessage(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: true,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setPermissionState("live");
    } catch (error) {
      setPermissionState("blocked");
      setErrorMessage(
        error instanceof Error ? error.message : "Camera permission was not granted.",
      );
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setPermissionState("idle");
  }

  const isLive = permissionState === "live";

  return (
    <div className="overflow-hidden rounded-md border border-slate-800 bg-slate-950 text-white">
      <div className="relative aspect-video min-h-[220px] bg-black">
        <video
          ref={videoRef}
          className={`h-full w-full object-cover ${isLive ? "block" : "hidden"}`}
          muted
          playsInline
        />

        {!isLive ? (
          <div className="flex h-full min-h-[220px] items-center justify-center p-6 text-center">
            <div>
              <Camera className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold uppercase text-slate-300">
                Host Camera
              </p>
              <p className="mt-2 text-2xl font-semibold">Preview offline</p>
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
        <div className="flex items-center gap-2">
          <StatusPill tone={isLive ? "live" : "neutral"}>
            {permissionState === "requesting"
              ? "Requesting"
              : isLive
                ? "Camera live"
                : "Camera off"}
          </StatusPill>
          {isLive ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase text-slate-300">
              <Mic className="h-3.5 w-3.5" aria-hidden="true" />
              Audio enabled
            </span>
          ) : null}
        </div>

        <button
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-white px-3 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          onClick={isLive ? stopCamera : startCamera}
          disabled={permissionState === "requesting"}
        >
          {isLive ? (
            <VideoOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Camera className="h-4 w-4" aria-hidden="true" />
          )}
          {isLive ? "Stop camera" : "Start camera"}
        </button>
      </div>
    </div>
  );
}
