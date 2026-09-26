import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerEndpoint,
  removeEndpoint,
  listEndpoints,
  getEndpoint,
  deliverWebhook,
  WebhookPayload,
} from "../webhooks";

// Reset module-level store between tests by removing all endpoints
function clearStore() {
  listEndpoints().forEach((ep) => removeEndpoint(ep.id));
}

describe("webhook registry (#443)", () => {
  beforeEach(() => clearStore());

  it("registers an endpoint and returns it with a generated secret", () => {
    const ep = registerEndpoint("https://example.com/hook", ["schedule.claimed"]);
    expect(ep.id).toBeTruthy();
    expect(ep.secret).toBeTruthy();
    expect(ep.events).toEqual(["schedule.claimed"]);
  });

  it("lists all registered endpoints", () => {
    registerEndpoint("https://a.example.com/hook", ["schedule.revoked"]);
    registerEndpoint("https://b.example.com/hook", ["schedule.created"]);
    expect(listEndpoints()).toHaveLength(2);
  });

  it("removes an endpoint by id", () => {
    const ep = registerEndpoint("https://example.com/hook", ["schedule.claimed"]);
    expect(removeEndpoint(ep.id)).toBe(true);
    expect(getEndpoint(ep.id)).toBeUndefined();
  });

  it("returns false when removing a non-existent id", () => {
    expect(removeEndpoint("nonexistent-id")).toBe(false);
  });
});

describe("deliverWebhook (#443)", () => {
  beforeEach(() => clearStore());

  it("delivers to a matching endpoint and returns delivered count", async () => {
    registerEndpoint("https://example.com/hook", ["schedule.claimed"]);

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const payload: WebhookPayload = {
      event: "schedule.claimed",
      scheduleId: 42,
      timestamp: Date.now(),
      data: { amount: "1000000" },
    };

    const result = await deliverWebhook(payload);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://example.com/hook");
    expect((opts.headers as Record<string, string>)["X-VestFlow-Event"]).toBe("schedule.claimed");
    expect((opts.headers as Record<string, string>)["X-VestFlow-Signature"]).toMatch(/^sha256=/);

    vi.unstubAllGlobals();
  });

  it("does not deliver to an endpoint with a non-matching event", async () => {
    registerEndpoint("https://example.com/hook", ["schedule.revoked"]);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await deliverWebhook({
      event: "schedule.claimed",
      scheduleId: 1,
      timestamp: Date.now(),
      data: {},
    });

    expect(mockFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("counts a failed delivery when the endpoint returns a non-ok response", async () => {
    registerEndpoint("https://bad.example.com/hook", ["schedule.created"]);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const result = await deliverWebhook({
      event: "schedule.created",
      scheduleId: 2,
      timestamp: Date.now(),
      data: {},
    });

    expect(result.failed).toBe(1);
    vi.unstubAllGlobals();
  });
});
