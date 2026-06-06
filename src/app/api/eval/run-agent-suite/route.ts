import { NextResponse } from "next/server";

import { runAgentEvalSuite } from "@/lib/agent-eval-runner";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export async function POST() {
  const suite = runAgentEvalSuite();

  return NextResponse.json(suite, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
