import { NextRequest, NextResponse } from "next/server";

const REQUEST_START_HEADER = "x-request-start";
const REQUEST_ID_HEADER = "x-request-id";

export interface RequestLogEntry {
  timestamp: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
}

export function logRequest(entry: RequestLogEntry): void {
  console.log(JSON.stringify(entry));
}

export function withLogging<TArgs extends any[]>(
  handler: (...args: TArgs) => Promise<NextResponse>
) {
  return async (...args: TArgs): Promise<NextResponse> => {
    const request = args[0] as NextRequest;
    const { pathname } = request.nextUrl;
    const method = request.method;
    const requestId = request.headers.get(REQUEST_ID_HEADER) || "unknown";
    const startHeader = request.headers.get(REQUEST_START_HEADER);
    const startMs = startHeader ? Number(startHeader) : Date.now();

    let status = 500;
    try {
      const response = await handler(...args);
      status = response.status;
      return response;
    } catch (error) {
      status = 500;
      throw error;
    } finally {
      const durationMs = Date.now() - startMs;
      logRequest({
        timestamp: new Date().toISOString(),
        method,
        path: pathname,
        status,
        durationMs,
        requestId,
      });
    }
  };
}
