import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "./apiError";

const MAX_REQUEST_BODY_BYTES = parseInt(
  process.env.MAX_REQUEST_BODY_BYTES || "102400",
  10
);

export async function checkRequestBodySize(
  request: NextRequest
): Promise<{ error: NextResponse | null }> {
  const method = request.method.toUpperCase();

  if (method === "GET" || method === "HEAD") {
    return { error: null };
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_REQUEST_BODY_BYTES) {
    const error = createErrorResponse(
      413,
      `Request body exceeds maximum size of ${MAX_REQUEST_BODY_BYTES} bytes`,
      request
    );
    return { error };
  }

  return { error: null };
}

export function withBodySizeLimit(
  handler: (request: NextRequest, ...args: any[]) => Promise<NextResponse>
) {
  return async (request: NextRequest, ...args: any[]): Promise<NextResponse> => {
    const { error } = await checkRequestBodySize(request);
    if (error) {
      return error;
    }
    return handler(request, ...args);
  };
}
