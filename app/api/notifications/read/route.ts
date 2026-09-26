import { NextRequest, NextResponse } from "next/server";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

/**
 * POST /api/notifications/read — body { event_ids: number[] }. Marks the given
 * notifications read for the wallet in the bearer token (proxied to indexer).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return NextResponse.json({ error: "Missing authorization token" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));

    const res = await fetch(`${INDEXER_URL}/notifications/read`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Indexer service unavailable" }, { status: 503 });
  }
}
