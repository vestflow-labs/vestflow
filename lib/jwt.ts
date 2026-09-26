import { createHmac, timingSafeEqual } from "crypto";

const JWT_EXPIRY_SECONDS = parseInt(process.env.JWT_EXPIRY_SECONDS || "3600", 10);

export interface JWTPayload {
  sub: string; // wallet public key (G...)
  iat: number;
  exp: number;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is not set");
  return secret;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLength), "base64");
}

/**
 * Generates a short-lived JWT bound to a wallet public key.
 * Hand-rolled HS256 (HMAC-SHA256) using Node's built-in crypto module —
 * no external JWT library dependency required.
 */
export function generateJWT(publicKey: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    sub: publicKey,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createHmac("sha256", getSecret()).update(signingInput).digest();
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Verifies a JWT's signature and expiry.
 * Returns the decoded payload if valid, or null if missing, malformed,
 * expired, or has a bad signature.
 */
export function verifyJWT(token: string): JWTPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac("sha256", getSecret()).update(signingInput).digest();

  let providedSignature: Buffer;
  try {
    providedSignature = base64urlDecode(encodedSignature);
  } catch {
    return null;
  }

  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return null;
  }

  let payload: JWTPayload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || Date.now() / 1000 > payload.exp) {
    return null;
  }

  return payload;
}

/**
 * Extracts a Bearer token from an Authorization header value.
 * Returns null if the header is missing or not in Bearer format.
 */
export function extractTokenFromHeader(header: string | null): string | null {
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;
  return parts[1];
}
