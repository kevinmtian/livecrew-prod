import { NextResponse } from "next/server";
import { getRoomState } from "@/lib/roomStore";

export function GET() {
  return NextResponse.json(getRoomState());
}
