/**
 * GET /api/auth/nonce?address=G...
 *
 * Issues a one-time nonce for the given Stellar address.
 * The client must sign buildNonceMessage(address, nonce) with Freighter
 * and send the result to POST /api/auth/login.
 *
 * Nonces are stored in memory (Map) with a 5-minute TTL.
 * In production, replace with Redis or a DB-backed store.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildNonceMessage, isValidStellarAddress } from "@/lib/auth";
import { randomBytes } from "crypto";

interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

// In-memory nonce store — keyed by Stellar address
const nonceStore = new Map<string, NonceEntry>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Remove expired entries (called on each request to avoid unbounded growth). */
function purgeExpired(): void {
  const now = Date.now();
  for (const [key, entry] of nonceStore.entries()) {
    if (entry.expiresAt < now) nonceStore.delete(key);
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  purgeExpired();

  const address = req.nextUrl.searchParams.get("address") ?? "";

  if (!address) {
    return NextResponse.json(
      { error: "Missing required query parameter: address" },
      { status: 400 }
    );
  }

  if (!isValidStellarAddress(address)) {
    return NextResponse.json(
      { error: "Invalid Stellar address" },
      { status: 400 }
    );
  }

  const nonce = randomBytes(16).toString("hex");
  nonceStore.set(address, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });

  return NextResponse.json({
    nonce,
    message: buildNonceMessage(address, nonce),
    expiresIn: NONCE_TTL_MS / 1000,
  });
}

/** Exported for use in the login route to consume and invalidate a nonce. */
export function consumeNonce(address: string, nonce: string): boolean {
  const entry = nonceStore.get(address);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    nonceStore.delete(address);
    return false;
  }
  if (entry.nonce !== nonce) return false;
  nonceStore.delete(address); // one-time use
  return true;
}
