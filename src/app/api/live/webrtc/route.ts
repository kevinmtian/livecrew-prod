import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type SignalDescription = {
  type: "offer" | "answer";
  sdp: string;
};

type SignalState = {
  offer: SignalDescription | null;
  answer: SignalDescription | null;
  updatedAt: number;
};

const globalSignal = globalThis as typeof globalThis & {
  __livecrewWebrtcSignal?: SignalState;
};

function getSignalState() {
  if (!globalSignal.__livecrewWebrtcSignal) {
    globalSignal.__livecrewWebrtcSignal = {
      offer: null,
      answer: null,
      updatedAt: Date.now(),
    };
  }

  return globalSignal.__livecrewWebrtcSignal;
}

export function GET() {
  const state = getSignalState();

  return NextResponse.json({
    offer: state.offer,
    answer: state.answer,
    updatedAt: state.updatedAt,
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    role?: "host" | "viewer";
    description?: SignalDescription;
  };
  const state = getSignalState();

  if (!body.description?.sdp || !body.description.type) {
    return NextResponse.json({ error: "Missing WebRTC description" }, { status: 400 });
  }

  if (body.role === "host" && body.description.type === "offer") {
    state.offer = body.description;
    state.answer = null;
    state.updatedAt = Date.now();
    return NextResponse.json(state);
  }

  if (body.role === "viewer" && body.description.type === "answer") {
    state.answer = body.description;
    state.updatedAt = Date.now();
    return NextResponse.json(state);
  }

  return NextResponse.json({ error: "Invalid role or description type" }, { status: 400 });
}

export function DELETE() {
  globalSignal.__livecrewWebrtcSignal = {
    offer: null,
    answer: null,
    updatedAt: Date.now(),
  };

  return NextResponse.json(globalSignal.__livecrewWebrtcSignal);
}
