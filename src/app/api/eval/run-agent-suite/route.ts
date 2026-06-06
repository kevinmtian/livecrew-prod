import { NextResponse } from "next/server";
import { runAgentEvaluationSuite } from "@/lib/agent-eval-suite";

export function GET() {
  return NextResponse.json(runAgentEvaluationSuite());
}
