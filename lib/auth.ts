/**
 * lib/auth.ts
 * JWT utilities for VestFlow wallet-signature authentication.
 *
 * Flow:
 *   1. Client calls GET /api/auth/nonce?address=G... → receives a nonce
 *   2. Client signs the nonce message with Freighter
 *   3. Client calls POST /api/auth/login { address, signature, nonce }
 *   4. Server verifies signature against the Stellar public key, issues JWT
 *   5. Client includes JWT in Authorization: Bearer <token> for write routes
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { NextRequest, NextResponse } from "next/server";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "vestflow-dev-secret-change-in-production"
);

export const JWT_EXPIRY = "1h"; // short-lived as required

export interface AuthPayload extends JWTPayload {
  address: string; // Stellar public key (G...)
}

/**
 * Sign a JWT for a verified Stellar address.
 */
export async function signAuthToken(address: string): Promise<string> {
  return new SignJWT({ address })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .setSubject(address)
    .sign(JWT_SECRET);
}

/**
 * Verify a JWT and return its payload.
 * Throws if the token is invalid or expired.
 */
export async function verifyAuthToken(token: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if (!payload.address || typeof payload.address !== "string") {
    throw new Error("Invalid token payload");
  }
  return payload as AuthPayload;
}

/**
 * Extract and verify the Bearer token from a request.
 * Returns the payload or null if missing/invalid.
 */
export async function getAuthPayload(
  req: NextRequest
): Promise<AuthPayload | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  try {
    return await verifyAuthToken(token);
  } catch {
    return null;
  }
}

/**
 * Middleware helper: require a valid JWT.
 * Returns a 401 response if auth fails, otherwise returns null (proceed).
 */
export async function requireAuth(
  req: NextRequest
): Promise<NextResponse | null> {
  const payload = await getAuthPayload(req);
  if (!payload) {
    return NextResponse.json(
      { error: "Unauthorized: valid Bearer token required" },
      { status: 401 }
    );
  }
  return null;
}

/**
 * Build the nonce message the wallet must sign.
 * Kept in one place so client and server always agree on the format.
 */
export function buildNonceMessage(address: string, nonce: string): string {
  return `VestFlow authentication\nAddress: ${address}\nNonce: ${nonce}`;
}

/**
 * Validate a Stellar public key (basic format check).
 */
export function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}
EOFcat > lib/auth.ts << 'EOF'
/**
 * lib/auth.ts
 * JWT utilities for VestFlow wallet-signature authentication.
 *
 * Flow:
 *   1. Client calls GET /api/auth/nonce?address=G... → receives a nonce
 *   2. Client signs the nonce message with Freighter
 *   3. Client calls POST /api/auth/login { address, signature, nonce }
 *   4. Server verifies signature against the Stellar public key, issues JWT
 *   5. Client includes JWT in Authorization: Bearer <token> for write routes
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { NextRequest, NextResponse } from "next/server";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "vestflow-dev-secret-change-in-production"
);

export const JWT_EXPIRY = "1h"; // short-lived as required

export interface AuthPayload extends JWTPayload {
  address: string; // Stellar public key (G...)
}

/**
 * Sign a JWT for a verified Stellar address.
 */
export async function signAuthToken(address: string): Promise<string> {
  return new SignJWT({ address })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .setSubject(address)
    .sign(JWT_SECRET);
}

/**
 * Verify a JWT and return its payload.
 * Throws if the token is invalid or expired.
 */
export async function verifyAuthToken(token: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if (!payload.address || typeof payload.address !== "string") {
    throw new Error("Invalid token payload");
  }
  return payload as AuthPayload;
}

/**
 * Extract and verify the Bearer token from a request.
 * Returns the payload or null if missing/invalid.
 */
export async function getAuthPayload(
  req: NextRequest
): Promise<AuthPayload | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  try {
    return await verifyAuthToken(token);
  } catch {
    return null;
  }
}

/**
 * Middleware helper: require a valid JWT.
 * Returns a 401 response if auth fails, otherwise returns null (proceed).
 */
export async function requireAuth(
  req: NextRequest
): Promise<NextResponse | null> {
  const payload = await getAuthPayload(req);
  if (!payload) {
    return NextResponse.json(
      { error: "Unauthorized: valid Bearer token required" },
      { status: 401 }
    );
  }
  return null;
}

/**
 * Build the nonce message the wallet must sign.
 * Kept in one place so client and server always agree on the format.
 */
export function buildNonceMessage(address: string, nonce: string): string {
  return `VestFlow authentication\nAddress: ${address}\nNonce: ${nonce}`;
}

/**
 * Validate a Stellar public key (basic format check).
 */
export function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}
