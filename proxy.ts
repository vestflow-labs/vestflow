import { NextRequest, NextResponse } from "next/server";
import { getCorsHeaders } from "@/lib/cors";
import { verifyJWT } from "@/lib/jwt";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Auth endpoints must stay reachable without a token.
const PUBLIC_PATHS = ["/api/auth/nonce", "/api/auth/verify"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: getCorsHeaders() });
  }
  if (!WRITE_METHODS.has(request.method)) return NextResponse.next();
  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) return NextResponse.next();

  const authHeader = request.headers.get("authorization") || "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
  }

  const payload = verifyJWT(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  // Downstream route handlers can read the authenticated wallet from this header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-wallet-address", payload.sub);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: "/api/:path*",
};
