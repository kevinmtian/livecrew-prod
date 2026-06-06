import { NextResponse } from "next/server";
import {
  analyzeViewerMessage,
  type AnalyzeViewerMessageInput,
} from "@/lib/agent-analyzer";

export async function POST(request: Request) {
  const body = (await request.json()) as AnalyzeViewerMessageInput;

  return NextResponse.json(analyzeViewerMessage(body));
}
