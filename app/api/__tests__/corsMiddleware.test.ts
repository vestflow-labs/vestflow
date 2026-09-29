import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

const originalCorsOrigin = process.env.CORS_ORIGIN;

afterEach(() => {
  if (originalCorsOrigin === undefined) {
    delete process.env.CORS_ORIGIN;
  } else {
    process.env.CORS_ORIGIN = originalCorsOrigin;
  }
});

describe("API CORS middleware", () => {
  it("returns a 204 preflight response with configured CORS headers", () => {
    process.env.CORS_ORIGIN = "https://client.example, https://other.example";
    const request = new NextRequest("http://localhost:3000/api/v1/schedules", {
      method: "OPTIONS",
      headers: { Origin: "https://client.example" },
    });

    const response = middleware(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://client.example"
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, OPTIONS"
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization"
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("uses wildcard origin by default and bypasses authentication for preflight", () => {
    delete process.env.CORS_ORIGIN;
    const request = new NextRequest("http://localhost:3000/api/private", {
      method: "OPTIONS",
      headers: { Origin: "https://client.example" },
    });

    const response = middleware(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("adds the configured CORS origin to regular API responses", () => {
    process.env.CORS_ORIGIN = "https://client.example";
    const request = new NextRequest("http://localhost:3000/api/private", {
      headers: { Origin: "https://client.example" },
    });

    const response = middleware(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://client.example"
    );
  });

  it("does not allow an unconfigured origin", () => {
    process.env.CORS_ORIGIN = "https://client.example";
    const request = new NextRequest("http://localhost:3000/api/private", {
      headers: { Origin: "https://untrusted.example" },
    });

    const response = middleware(request);

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });
});
