/**
 * Middleware to verify JWT tokens for protected API routes.
 * Can be used with Next.js middleware or applied to individual route handlers.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyJWT, extractTokenFromHeader } from "@/lib/jwt";

export interface AuthenticatedRequest extends NextRequest {
  publicKey?: string;
}

/**
 * Middleware function to verify JWT and extract publicKey
 * Attach to any route handler that requires authentication.
 *
 * Usage:
 * ```typescript
 * export async function POST(request: NextRequest) {
 *   const { publicKey, error, response } = await verifyAuth(request);
 *   if (error) return response;
 *   // publicKey is now available and verified
 * }
 * ```
 */
export async function verifyAuth(
  request: NextRequest
): Promise<
  | { publicKey: string; error: null; response: null }
  | { publicKey: null; error: string; response: NextResponse }
> {
  const authHeader = request.headers.get("Authorization");
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    return {
      publicKey: null,
      error: "Missing authorization token",
      response: NextResponse.json(
        { error: "Missing authorization token" },
        { status: 401 }
      ),
    };
  }

  const payload = verifyJWT(token);
  if (!payload) {
    return {
      publicKey: null,
      error: "Invalid or expired token",
      response: NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      ),
    };
  }

  return {
    publicKey: payload.sub,
    error: null,
    response: null,
  };
}

/**
 * Higher-order function to wrap route handlers with authentication
 *
 * Usage:
 * ```typescript
 * export const POST = withAuth(async (request, publicKey) => {
 *   // publicKey is guaranteed to be present
 *   return NextResponse.json({ ok: true });
 * });
 * ```
 */
export function withAuth(
  handler: (request: NextRequest, publicKey: string) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const { publicKey, error, response } = await verifyAuth(request);

    if (error || !publicKey) {
      return response || NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return handler(request, publicKey);
  };
}
