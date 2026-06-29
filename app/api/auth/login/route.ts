/**
 * POST /api/auth/login
 *
 * Body: { address: string, nonce: string, signature: string }
 *
 * Verifies that `signature` is a valid Freighter signature of
 * buildNonceMessage(address, nonce), then issues a short-lived JWT.
 *
 * Stellar / Freighter signature verification:
 *   Freighter's signMessage returns a base64-encoded Ed25519 signature.
 *   We verify it against the public key decoded from the Stellar address
 *   using the Stellar SDK's Keypair utility.
 */

import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { signAuthToken, buildNonceMessage, isValidStellarAddress } from "@/lib/auth";
import { consumeNonce } from "@/app/api/auth/nonce/route";

interface LoginRequest {
  address: string;
  nonce: string;
  signature: string; // base64-encoded Ed25519 signature from Freighter
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: LoginRequest;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { address, nonce, signature } = body;

  // ── Input validation ──────────────────────────────────────────────────────

  if (!address || !nonce || !signature) {
    return NextResponse.json(
      { error: "Missing required fields: address, nonce, signature" },
      { status: 400 }
    );
  }

  if (!isValidStellarAddress(address)) {
    return NextResponse.json(
      { error: "Invalid Stellar address" },
      { status: 400 }
    );
  }

  // ── Nonce validation (consumes it — prevents replay) ─────────────────────

  if (!consumeNonce(address, nonce)) {
    return NextResponse.json(
      { error: "Invalid or expired nonce" },
      { status: 401 }
    );
  }

  // ── Signature verification ────────────────────────────────────────────────

  try {
    const message = buildNonceMessage(address, nonce);
    const messageBytes = Buffer.from(message, "utf8");
    const signatureBytes = Buffer.from(signature, "base64");

    const keypair = Keypair.fromPublicKey(address);
    const valid = keypair.verify(messageBytes, signatureBytes);

    if (!valid) {
      return NextResponse.json(
        { error: "Signature verification failed" },
        { status: 401 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Signature verification error" },
      { status: 401 }
    );
  }

  // ── Issue JWT ─────────────────────────────────────────────────────────────

  const token = await signAuthToken(address);

  return NextResponse.json({
    token,
    address,
    expiresIn: 3600, // 1 hour in seconds
  });
}
