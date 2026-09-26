import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withLogging, logRequest, RequestLogEntry } from "../requestLogger";

function createMockRequest(pathname: string, method = "GET", headers?: Record<string, string>) {
  const url = new URL(`http://localhost${pathname}`);
  return {
    nextUrl: url,
    method,
    headers: {
      get: (name: string) => headers?.[name] ?? null,
    },
  } as any;
}

function createMockResponse(status = 200) {
  return { status } as any;
}

describe("requestLogger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe("withLogging", () => {
    it("logs request with all required fields", async () => {
      const startMs = Date.now();
      const requestId = "test-req-123";
      const mockRequest = createMockRequest("/api/schedules", "GET", {
        "x-request-id": requestId,
        "x-request-start": String(startMs),
      });
      const mockResponse = createMockResponse(200);

      const handler = vi.fn().mockResolvedValue(mockResponse);
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(logged).toHaveProperty("timestamp");
      expect(logged.method).toBe("GET");
      expect(logged.path).toBe("/api/schedules");
      expect(logged.status).toBe(200);
      expect(logged.requestId).toBe(requestId);
      expect(typeof logged.durationMs).toBe("number");
      expect(logged.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("uses 'unknown' when X-Request-ID header is missing", async () => {
      const mockRequest = createMockRequest("/api/events", "POST");

      const handler = vi.fn().mockResolvedValue(createMockResponse(201));
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.requestId).toBe("unknown");
      expect(logged.status).toBe(201);
    });

    it("logs error status when handler throws", async () => {
      const mockRequest = createMockRequest("/api/fail", "GET", {
        "x-request-id": "req-err",
        "x-request-start": String(Date.now()),
      });

      const handler = vi.fn().mockRejectedValue(new Error("boom"));
      const wrapped = withLogging(handler);

      await expect(wrapped(mockRequest)).rejects.toThrow("boom");

      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.status).toBe(500);
      expect(logged.requestId).toBe("req-err");
    });

    it("measures duration from start header", async () => {
      const pastMs = Date.now() - 150;
      const mockRequest = createMockRequest("/api/health", "GET", {
        "x-request-id": "req-dur",
        "x-request-start": String(pastMs),
      });

      const handler = vi.fn().mockResolvedValue(createMockResponse(200));
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.durationMs).toBeGreaterThanOrEqual(140);
    });

    it("falls back to Date.now() when start header is missing", async () => {
      const mockRequest = createMockRequest("/api/test", "GET", {
        "x-request-id": "req-no-start",
      });

      const handler = vi.fn().mockResolvedValue(createMockResponse(200));
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.durationMs).toBeGreaterThanOrEqual(0);
      expect(logged.durationMs).toBeLessThan(1000);
    });

    it("logs non-200 status codes correctly", async () => {
      const mockRequest = createMockRequest("/api/missing", "GET", {
        "x-request-id": "req-404",
        "x-request-start": String(Date.now()),
      });

      const handler = vi.fn().mockResolvedValue(createMockResponse(404));
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.status).toBe(404);
    });

    it("outputs valid JSON", async () => {
      const mockRequest = createMockRequest("/api/json", "DELETE", {
        "x-request-id": "req-json",
        "x-request-start": String(Date.now()),
      });

      const handler = vi.fn().mockResolvedValue(createMockResponse(204));
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      const logOutput = consoleSpy.mock.calls[0][0];
      expect(() => JSON.parse(logOutput)).not.toThrow();
      const parsed = JSON.parse(logOutput);
      expect(parsed).toHaveProperty("timestamp");
      expect(parsed).toHaveProperty("method");
      expect(parsed).toHaveProperty("path");
      expect(parsed).toHaveProperty("status");
      expect(parsed).toHaveProperty("durationMs");
      expect(parsed).toHaveProperty("requestId");
    });

    it("requestId appears in log line for correlation", async () => {
      const uniqueId = "correlation-test-uuid-abc-123";
      const mockRequest = createMockRequest("/api/correlate", "GET", {
        "x-request-id": uniqueId,
      });

      const handler = vi.fn().mockResolvedValue(createMockResponse(200));
      const wrapped = withLogging(handler);

      await wrapped(mockRequest);

      const logged: RequestLogEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(logged.requestId).toBe(uniqueId);
    });
  });

  describe("logRequest", () => {
    it("outputs structured JSON via console.log", () => {
      const entry: RequestLogEntry = {
        timestamp: "2025-01-01T00:00:00.000Z",
        method: "GET",
        path: "/api/test",
        status: 200,
        durationMs: 42,
        requestId: "abc-123",
      };

      logRequest(entry);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output).toEqual(entry);
    });
  });
});
