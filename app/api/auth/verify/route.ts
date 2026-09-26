import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/indexer/src/db";
import { verifyFreighterSignature, isValidStellarAddress } from "@/lib/stellar-verify";
import { generateJWT } from "@/lib/jwt";
import { withLogging } from "@/lib/requestLogger";
import { createErrorResponse } from "@/lib/apiError";
import { createVersionedHandler } from "@/lib/versionedRoute";

const NONCE_VALIDITY_MS = 5 * 60 * 1000; // 5 minutes (must match nonce generation)

/**
 * POST /api/auth/verify
 * Verifies a wallet signature and issues a JWT token.
 */
export const POST = withLogging(async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { publicKey, nonce, signedMessage } = body;

    // Validate inputs
    if (
      !publicKey ||
      !nonce ||
      !signedMessage ||
      typeof publicKey !== "string" ||
      typeof nonce !== "string" ||
      typeof signedMessage !== "string"
    ) {
      return createErrorResponse(
        400,
        "publicKey, nonce, and signedMessage are required",
        request
      );
    }

    // Validate Stellar address
    if (!isValidStellarAddress(publicKey)) {
      return createErrorResponse(
        400,
        "Invalid Stellar address format",
        request
      );
    }

    const db = getDb();

    // Retrieve nonce from database
    const nonceRecord = db
      .prepare("SELECT * FROM nonces WHERE nonce = ? AND public_key = ?")
      .get(nonce, publicKey) as
      | { nonce: string; public_key: string; expires_at: string; created_at: string }
      | undefined;

    if (!nonceRecord) {
      return createErrorResponse(
        400,
        "Nonce not found or does not match public key",
        request
      );
    }

    // Check if nonce has expired
    const expiresAt = new Date(nonceRecord.expires_at).getTime();
    if (Date.now() > expiresAt) {
      // Clean up expired nonce
      db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce);
      return createErrorResponse(
        400,
        "Nonce has expired",
        request
      );
    }

    // Verify signature
    const isValidSignature = verifyFreighterSignature(publicKey, nonce, signedMessage);
    if (!isValidSignature) {
      return createErrorResponse(
        401,
        "Invalid signature",
        request
      );
    }

    // Clean up the used nonce
    db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce);

    // Generate JWT token
    const token = generateJWT(publicKey);
    const expiresIn = Math.floor(((process.env.JWT_EXPIRY_SECONDS || "3600") as any) as number);

    return NextResponse.json(
      {
        token,
        expiresIn,
        publicKey,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error verifying signature:", error);
    return createErrorResponse(
      500,
      "Failed to verify signature",
      request
    );
  }
});

export const POST_VERSIONED = createVersionedHandler(POST);
