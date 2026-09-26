/**
 * Bearer-token authentication for the indexer's write endpoints.
 *
 * Tokens are the short-lived HS256 JWTs minted by the app's wallet login
 * (`POST /api/auth/verify`), whose `sub` claim is the wallet address. The
 * indexer only needs to verify them, so it re-implements the check against
 * the shared JWT_SECRET instead of importing from the Next.js app (separate
 * build root, no cross-package imports).
 */

import { createHmac, timingSafeEqual } from "crypto";

export interface AuthPayload {
  /** Wallet public key (G...). */
  sub: string;
  iat: number;
  exp: number;
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLength), "base64");
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}

/**
 * Verifies an HS256 JWT and returns its payload, or null when the token is
 * malformed, expired or incorrectly signed.
 */
export function verifyAuthToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): AuthPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const expected = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();

  let provided: Buffer;
  try {
    provided = base64urlDecode(encodedSignature);
  } catch {
    return null;
  }

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  let payload: AuthPayload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (typeof payload.exp !== "number" || nowSeconds > payload.exp) return null;

  return payload;
}
