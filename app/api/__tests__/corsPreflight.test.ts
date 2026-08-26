import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

const originalCorsOrigin = process.env.CORS_ALLOWED_ORIGIN;

afterEach(() => {
  if (originalCorsOrigin === undefined) {
    delete process.env.CORS_ALLOWED_ORIGIN;
  } else {
    process.env.CORS_ALLOWED_ORIGIN = originalCorsOrigin;
  }
});

describe("API CORS preflight", () => {
  it("returns the required headers for every API path", async () => {
    delete process.env.CORS_ALLOWED_ORIGIN;

    const response = proxy(
      new NextRequest("http://localhost/api/schedules", { method: "OPTIONS" })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("Content-Type");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(await response.text()).toBe("");
  });

  it("uses the configured allowed origin", () => {
    process.env.CORS_ALLOWED_ORIGIN = "https://partner.example";

    const response = proxy(
      new NextRequest("http://localhost/api/health", { method: "OPTIONS" })
    );

    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://partner.example"
    );
  });
});
