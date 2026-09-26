import { NextRequest, NextResponse } from "next/server";
import { validateCsv } from "@/lib/csv-validation";
import { buildBatchFromRows, suggestExpiryLedger } from "@/scripts/merkle-batch";
import { createIpBasedRateLimiter } from "@/lib/rateLimit";
import { withLogging } from "@/lib/requestLogger";

// Server-side counterpart to `scripts/merkle-batch.ts` for the bulk-create
// page's Merkle mode: takes the CSV a grantor already validated client-side
// plus a chosen expiry ledger, and returns the committed root and every
// beneficiary's proof so the browser never needs to bundle Node's `crypto`/
// `fs` for a client-side build.
const rateLimiter = createIpBasedRateLimiter(60000, 10);

export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  const rateLimitResponse = await rateLimiter(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  let body: { csv?: string; expiryLedger?: number; expiryDays?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.csv !== "string" || !body.csv.trim()) {
    return NextResponse.json({ error: "Missing required field: csv" }, { status: 400 });
  }

  let expiryLedger: number;
  if (body.expiryLedger !== undefined) {
    if (!Number.isInteger(body.expiryLedger) || body.expiryLedger <= 0) {
      return NextResponse.json(
        { error: "expiryLedger must be a positive integer" },
        { status: 400 }
      );
    }
    expiryLedger = body.expiryLedger;
  } else {
    const expiryDays = Number.isInteger(body.expiryDays) && (body.expiryDays as number) > 0
      ? (body.expiryDays as number)
      : 30;
    try {
      expiryLedger = await suggestExpiryLedger(expiryDays);
    } catch (e: any) {
      return NextResponse.json(
        { error: `Could not reach the network to compute an expiry ledger: ${e?.message || e}` },
        { status: 502 }
      );
    }
  }

  const { validRows, invalidRows, headerError } = validateCsv(body.csv);
  if (headerError) {
    return NextResponse.json({ error: headerError }, { status: 400 });
  }
  if (invalidRows.length > 0) {
    return NextResponse.json(
      {
        error: `${invalidRows.length} row(s) failed validation`,
        invalidRows: invalidRows.map((r) => ({ rowIndex: r.rowIndex, errors: r.errors })),
      },
      { status: 400 }
    );
  }
  if (validRows.length === 0) {
    return NextResponse.json({ error: "CSV has no valid rows" }, { status: 400 });
  }

  try {
    const batch = buildBatchFromRows(validRows, expiryLedger);
    return NextResponse.json(batch);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to build batch" }, { status: 400 });
  }
});
