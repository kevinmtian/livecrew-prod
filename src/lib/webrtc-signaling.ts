export type WebrtcDescription = {
  type: "offer" | "answer";
  sdp: string;
};

export type WebrtcSignalState = {
  offer: WebrtcDescription | null;
  answer: WebrtcDescription | null;
  updatedAt: number;
};

export async function getWebrtcSignal() {
  const response = await fetch("/api/live/webrtc", { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`WebRTC signal read failed: ${response.status}`);
  }

  return (await response.json()) as WebrtcSignalState;
}

export async function postWebrtcDescription(
  role: "host" | "viewer",
  description: WebrtcDescription,
) {
  const response = await fetch("/api/live/webrtc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role, description }),
  });

  if (!response.ok) {
    throw new Error(`WebRTC signal write failed: ${response.status}`);
  }

  return (await response.json()) as WebrtcSignalState;
}

export async function resetWebrtcSignal() {
  const response = await fetch("/api/live/webrtc", {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`WebRTC signal reset failed: ${response.status}`);
  }

  return (await response.json()) as WebrtcSignalState;
}

export function waitForIceGatheringComplete(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", handleStateChange);
      resolve();
    }, 2500);

    function handleStateChange() {
      if (peer.iceGatheringState === "complete") {
        window.clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", handleStateChange);
        resolve();
      }
    }

    peer.addEventListener("icegatheringstatechange", handleStateChange);
  });
}
