import { NextResponse } from "next/server";

const backendBaseUrl =
  process.env.NEXT_PUBLIC_LIVECREW_BACKEND_URL ?? "http://127.0.0.1:8000";

export async function POST() {
  try {
    const response = await fetch(`${backendBaseUrl}/eval/run-agent-suite`, {
      method: "POST",
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Backend evaluation suite failed." },
        { status: response.status },
      );
    }

    return NextResponse.json(await response.json());
  } catch {
    return NextResponse.json(
      { error: "Backend evaluation suite is unavailable." },
      { status: 503 },
    );
  }
}
