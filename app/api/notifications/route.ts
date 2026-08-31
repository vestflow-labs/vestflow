import { NextRequest, NextResponse } from "next/server";

const INDEXER_URL = process.env.INDEXER_URL ?? "http://localhost:3001";

const ALLOWED_PARAMS = new Set(["page", "limit", "type", "read"]);

/**
 * GET /api/notifications — paginated notification history for the wallet in
 * the bearer token. Proxies to the indexer's /notifications endpoint.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const upstream = new URL(`${INDEXER_URL}/notifications`);
    for (const [key, value] of req.nextUrl.searchParams.entries()) {
      if (ALLOWED_PARAMS.has(key)) upstream.searchParams.set(key, value);
    }

    const auth = req.headers.get("Authorization");
    if (!auth) {
      return NextResponse.json({ error: "Missing authorization token" }, { status: 401 });
    }

    const res = await fetch(upstream.toString(), {
      headers: { Authorization: auth },
    });

    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Indexer service unavailable" }, { status: 503 });
  }
}
