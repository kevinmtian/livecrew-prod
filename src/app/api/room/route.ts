import { NextResponse } from "next/server";
import { applyRoomEvent, getRoomState } from "@/lib/roomStore";
import type { RoomEvent } from "@/lib/roomChannel";

export function GET() {
  return NextResponse.json(getRoomState());
}

export async function POST(request: Request) {
  const event = (await request.json()) as RoomEvent;

  applyRoomEvent(event);

  return NextResponse.json(getRoomState());
}
