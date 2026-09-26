import { NextRequest, NextResponse } from "next/server";
import { verifyJWT } from "@/lib/jwt";

const REQUEST_START_HEADER = "x-request-start";
const REQUEST_ID_HEADER = "x-request-id";
const API_VERSION_HEADER = "x-api-version";
const IS_DEPRECATED_HEADER = "x-is-deprecated";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Auth endpoints & public endpoints must stay reachable without a token.
const PUBLIC_PATHS = [
  "/api/auth/nonce",
  "/api/auth/verify",
  "/api/health",
  "/api/ready",
  "/api/lists",
  "/api/schedules",
  "/api/events",
  "/api/contracts",
  "/api/analytics",
  "/api/stats",
  "/api/streams",
  "/api/addresses",
  "/api/openapi",
  "/api/profile",
];

const EXCLUDED_PATHS = ["/api/health", "/api/ready"];

function shouldExclude(pathname: string): boolean {
  return EXCLUDED_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

function getApiVersionInfo(pathname: string): {
  pathname: string;
  version: number;
  isDeprecated: boolean;
} {
  if (pathname.startsWith("/api/v1/")) {
    return { pathname, version: 1, isDeprecated: false };
  }
  if (pathname.startsWith("/api/v2/")) {
    return { pathname, version: 2, isDeprecated: false };
  }

  // For non-versioned paths like /api/something, treat as v1 with deprecation
  if (pathname.startsWith("/api/")) {
    const versionedPath = pathname.replace("/api/", "/api/v1/");
    return { pathname: versionedPath, version: 1, isDeprecated: true };
  }

  return { pathname, version: 1, isDeprecated: false };
}

export function middleware(request: NextRequest) {
  let { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const { pathname: versionedPath, version, isDeprecated } = getApiVersionInfo(
    pathname
  );

  if (shouldExclude(pathname) && !isDeprecated) {
    return NextResponse.next();
  }

  // Echo client-sent X-Request-ID or generate a new one
  const requestId =
    request.headers.get(REQUEST_ID_HEADER) || generateRequestId();
  const startMs = Date.now();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(REQUEST_START_HEADER, String(startMs));
  requestHeaders.set(API_VERSION_HEADER, String(version));
  requestHeaders.set(IS_DEPRECATED_HEADER, String(isDeprecated));

  // If write method and not in public path, verify auth
  if (
    WRITE_METHODS.has(request.method) &&
    !PUBLIC_PATHS.some((path) => versionedPath.startsWith(path))
  ) {
    const authHeader = request.headers.get("authorization") || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      const unauthorizedResponse = NextResponse.json(
        { error: "Missing or invalid Authorization header" },
        { status: 401 }
      );
      unauthorizedResponse.headers.set(REQUEST_ID_HEADER, requestId);
      return unauthorizedResponse;
    }

    const payload = verifyJWT(token);
    if (!payload) {
      const invalidTokenResponse = NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
      invalidTokenResponse.headers.set(REQUEST_ID_HEADER, requestId);
      return invalidTokenResponse;
    }

    requestHeaders.set("x-wallet-address", payload.sub);
  }

  const nextRequest = versionedPath !== pathname
    ? request.clone()
    : request;

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Set X-Request-ID on the response so the client can correlate
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set("API-Version", String(version));

  if (isDeprecated) {
    const sunsetDate = new Date();
    sunsetDate.setFullYear(sunsetDate.getFullYear() + 1);
    response.headers.set("Deprecation", "true");
    response.headers.set("Sunset", sunsetDate.toUTCString());
    response.headers.set(
      "Link",
      `<https://docs.vestflow.dev/api/migration>; rel="deprecation"`
    );
  }

  return response;
}

export const config = {
  matcher: ["/api/:path*", "/api/v1/:path*"],
};
