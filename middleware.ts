/**
 * middleware.ts — Next.js edge middleware for JWT auth.
 *
 * Protects all write (POST/PUT/PATCH/DELETE) requests to /api routes
 * except the auth endpoints themselves.
 *
 * Read-only GET routes remain public so the frontend can display
 * schedule data without requiring a wallet connection.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthPayload } from "@/lib/auth";

// Routes that never require auth (auth endpoints + public reads)
const PUBLIC_PREFIXES = [
  "/api/auth/",       // nonce + login
  "/api/events",      // public event feed
  "/api/analytics",   // public stats
  "/api/schedules",   // public schedule reads
  "/api/notifications/verify", // email verification link
];

// Only enforce auth on mutating methods
const PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // Only intercept API routes with mutating methods
  if (!pathname.startsWith("/api/") || !PROTECTED_METHODS.has(method)) {
    return NextResponse.next();
  }

  // Allow public routes through
  const isPublic = PUBLIC_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  );
  if (isPublic) return NextResponse.next();

  // Verify JWT
  const payload = await getAuthPayload(req);
  if (!payload) {
    return NextResponse.json(
      { error: "Unauthorized: valid Bearer token required" },
      { status: 401 }
    );
  }

  // Forward address in a header so API routes can use it without re-verifying
  const response = NextResponse.next();
  response.headers.set("x-auth-address", payload.address);
  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
