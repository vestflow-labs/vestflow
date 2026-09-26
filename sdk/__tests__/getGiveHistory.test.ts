import { afterEach, describe, expect, it, vi } from "vitest";
import { VestflowClient } from "../src/client";

const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

afterEach(() => vi.unstubAllGlobals());

function stubGives(gives: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ gives, nextCursor: "next-page" }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getGiveHistory (#849)", () => {
  it("loads sent gives", async () => {
    const fetchMock = stubGives([{ id: "1", sender: ACCOUNT, amount: "42" }]);
    const page = await new VestflowClient({ indexerUrl: "http://indexer.local" }).getGiveHistory(
      ACCOUNT,
      { asSender: true }
    );
    expect(page.items[0].amount).toBe(42n);
    expect(fetchMock.mock.calls[0][0]).toContain(`/gives?sender=${ACCOUNT}`);
  });

  it("loads received gives", async () => {
    const fetchMock = stubGives([{ id: "2", receiver: ACCOUNT, amount: "7" }]);
    await new VestflowClient({ indexerUrl: "http://indexer.local" }).getGiveHistory(
      ACCOUNT,
      { asReceiver: true }
    );
    expect(fetchMock.mock.calls[0][0]).toContain(`/gives?receiver=${ACCOUNT}`);
  });

  it("filters both directions by token", async () => {
    const fetchMock = stubGives([]);
    await new VestflowClient({ indexerUrl: "http://indexer.local" }).getGiveHistory(ACCOUNT, {
      token: TOKEN,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url.includes(`token=${TOKEN}`))).toBe(true);
  });
});