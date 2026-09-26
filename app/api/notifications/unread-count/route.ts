import { NextRequest, NextResponse } from "next/server";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

/**
 * GET /api/notifications/unread-count — number of unread notifications for the
 * wallet in the bearer token (proxied to the indexer).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return NextResponse.json({ error: "Missing authorization token" }, { status: 401 });
    }

    const res = await fetch(`${INDEXER_URL}/notifications/unread-count`, {
      headers: { Authorization: auth },
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Indexer service unavailable" }, { status: 503 });
  }
}
