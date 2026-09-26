import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getDb } from "@/indexer/src/db";
import { isValidStellarAddress } from "@/lib/stellar-verify";
import { withLogging } from "@/lib/requestLogger";
import { createErrorResponse } from "@/lib/apiError";
import { createVersionedHandler } from "@/lib/versionedRoute";

const NONCE_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes (must match verify route)

/**
 * POST /api/auth/nonce
 * Issues a short-lived, single-use nonce for a wallet to sign with Freighter.
 */
export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { publicKey } = body;

    if (!publicKey || typeof publicKey !== "string") {
      return createErrorResponse(400, "publicKey is required", request);
    }

    if (!isValidStellarAddress(publicKey)) {
      return createErrorResponse(
        400,
        "Invalid Stellar address format",
        request
      );
    }

    const nonce = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + NONCE_VALIDITY_MS).toISOString();

    const db = getDb();

    // Only one outstanding nonce per wallet at a time.
    db.prepare("DELETE FROM nonces WHERE public_key = ?").run(publicKey);
    db.prepare(
      "INSERT INTO nonces (nonce, public_key, expires_at) VALUES (?, ?, ?)"
    ).run(nonce, publicKey, expiresAt);

    return NextResponse.json({ nonce, expiresAt }, { status: 200 });
  } catch (error) {
    console.error("Error issuing nonce:", error);
    return createErrorResponse(500, "Failed to issue nonce", request);
  }
});

export const POST_VERSIONED = createVersionedHandler(POST);
