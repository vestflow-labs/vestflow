// Unit tests for VestflowClient.getStreams (#685)
//
// Covers: empty result when no streams, a single stream, and multiple streams,
// verifying the typed Stream fields (receiver, token, ratePerSec, maxEndTime).

import { describe, it, expect, vi, afterEach } from "vitest";
import { VestflowClient } from "../src/client";
import type { Stream } from "../src/types";

const GRANTOR = "GGRANTOR";
const RECEIVER = "GBENEFICIARY";
const TOKEN = "GTOKENCONTRACT";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    sender: GRANTOR,
    receiver: RECEIVER,
    token: TOKEN,
    ratePerSec: 1000n,
    maxEndTime: 2_000_000,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getStreams (#685)", () => {
  it("returns an empty array when the account has no streams", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ streams: [] }),
      })
    );

    const client = new VestflowClient({ network: "testnet" });
    const streams = await client.getStreams(GRANTOR);

    expect(streams).toEqual([]);
  });

  it("returns a single typed stream", async () => {
    const stream = makeStream();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ streams: [stream] }),
      })
    );

    const client = new VestflowClient({ network: "testnet" });
    const streams = await client.getStreams(GRANTOR);

    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      sender: GRANTOR,
      receiver: RECEIVER,
      token: TOKEN,
      ratePerSec: 1000n,
      maxEndTime: 2_000_000,
    });
  });

  it("returns multiple streams and parses ratePerSec as bigint", async () => {
    const streams = [
      makeStream({ receiver: "G1", ratePerSec: 500n, maxEndTime: 1 }),
      makeStream({ receiver: "G2", ratePerSec: 2500n, maxEndTime: 2 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ streams }),
      })
    );

    const client = new VestflowClient({ network: "testnet" });
    const result = await client.getStreams(GRANTOR);

    expect(result).toHaveLength(2);
    expect(result[0].ratePerSec).toBe(500n);
    expect(result[1].ratePerSec).toBe(2500n);
    expect(result[1].receiver).toBe("G2");
  });

  it("supports an indexer response that is a bare array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [makeStream({ receiver: "GBARE" })],
      })
    );

    const client = new VestflowClient({ network: "testnet" });
    const result = await client.getStreams(GRANTOR);

    expect(result).toHaveLength(1);
    expect(result[0].receiver).toBe("GBARE");
  });

  it("throws when the indexer responds with an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
      })
    );

    const client = new VestflowClient({ network: "testnet" });
    await expect(client.getStreams(GRANTOR)).rejects.toThrow(/Indexer request failed/);
  });
});
