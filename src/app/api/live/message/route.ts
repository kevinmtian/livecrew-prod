import { NextResponse } from "next/server";
import { applyRoomEvent, getRoomState } from "@/lib/roomStore";
import type { RoomEvent, RoomViewerMessage } from "@/lib/roomChannel";

export async function POST(request: Request) {
  const body = (await request.json()) as RoomEvent | RoomViewerMessage;
  const event: RoomEvent =
    "type" in body
      ? body
      : {
          type: "viewer-message",
          message: body,
        };

  applyRoomEvent(event);

  return NextResponse.json(getRoomState());
}
