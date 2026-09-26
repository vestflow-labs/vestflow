import { NextRequest, NextResponse } from "next/server";

export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
}

const ERROR_TYPES: Record<number, { type: string; title: string }> = {
  400: {
    type: "https://api.vestflow.dev/errors/bad-request",
    title: "Bad Request",
  },
  401: {
    type: "https://api.vestflow.dev/errors/unauthorized",
    title: "Unauthorized",
  },
  403: {
    type: "https://api.vestflow.dev/errors/forbidden",
    title: "Forbidden",
  },
  404: {
    type: "https://api.vestflow.dev/errors/not-found",
    title: "Not Found",
  },
  413: {
    type: "https://api.vestflow.dev/errors/payload-too-large",
    title: "Payload Too Large",
  },
  422: {
    type: "https://api.vestflow.dev/errors/unprocessable-entity",
    title: "Unprocessable Entity",
  },
  429: {
    type: "https://api.vestflow.dev/errors/too-many-requests",
    title: "Too Many Requests",
  },
  500: {
    type: "https://api.vestflow.dev/errors/internal-server-error",
    title: "Internal Server Error",
  },
  503: {
    type: "https://api.vestflow.dev/errors/service-unavailable",
    title: "Service Unavailable",
  },
};

export function createProblemDetail(
  status: number,
  detail: string,
  requestId: string,
  pathname: string
): ProblemDetail {
  const errorInfo = ERROR_TYPES[status] || {
    type: "https://api.vestflow.dev/errors/internal-server-error",
    title: "Internal Server Error",
  };

  return {
    type: errorInfo.type,
    title: errorInfo.title,
    status,
    detail,
    instance: `${pathname}?requestId=${requestId}`,
  };
}

export function createErrorResponse(
  status: number,
  detail: string,
  request: NextRequest
): NextResponse {
  const requestId =
    request.headers.get("x-request-id") || crypto.randomUUID();
  const pathname = request.nextUrl.pathname;

  const problemDetail = createProblemDetail(status, detail, requestId, pathname);

  return NextResponse.json(problemDetail, {
    status,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Request-ID": requestId,
    },
  });
}
