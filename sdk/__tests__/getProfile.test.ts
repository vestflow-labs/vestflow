import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VestflowClient } from "../src/client";
import { ProfileError } from "../src/types";

const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";
const RECEIVER_B = "GBSOV3F63VBMLDKD3JV5HQC5KPVXJQEQHP5TPUMZWNMCZZQ6SKF2OL3A";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getProfile (#854)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a typed profile for an active address", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        address: ACCOUNT,
        network: "testnet",
        streams: [
          {
            sender: ACCOUNT,
            receiver: RECEIVER_B,
            token: CONTRACT,
            ratePerSec: "10",
            maxEndTime: 1_800_000_000,
          },
        ],
        splits: {
          receivers: [{ address: RECEIVER_B, weight_bps: 5_000 }],
          hash: "0xabc",
        },
        gives: [
          {
            id: "g1",
            sender: ACCOUNT,
            receiver: RECEIVER_B,
            token: CONTRACT,
            amount_stroops: "1000",
            ledger: 100,
            timestamp: 1_700_000_000,
          },
        ],
        dripsLists: [
          {
            id: "l1",
            name: "Team",
            owner: ACCOUNT,
            token: CONTRACT,
            member_count: 2,
          },
        ],
        totals: {},
      }),
    });

    const client = new VestflowClient({ network: "testnet" });
    const profile = await client.getProfile(ACCOUNT);

    expect(profile.address).toBe(ACCOUNT);
    expect(profile.network).toBe("testnet");
    expect(profile.streams).toHaveLength(1);
    expect(profile.streams[0].ratePerSec).toBe(10n);
    expect(profile.streams[0].receiver).toBe(RECEIVER_B);
    expect(profile.splits.receivers).toEqual([
      { address: RECEIVER_B, weightBps: 5_000 },
    ]);
    expect(profile.splits.hash).toBe("0xabc");
    expect(profile.gives).toHaveLength(1);
    expect(profile.gives[0].amount).toBe(1_000n);
    expect(profile.dripsLists).toHaveLength(1);
    expect(profile.dripsLists[0].memberCount).toBe(2);
    expect(profile.totals).toEqual({
      streams: 1,
      splitsReceivers: 1,
      gives: 1,
      totalGiven: 1_000n,
      dripsLists: 1,
    });
  });

  it("returns an empty/zeroed profile for an inactive address (404)", async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    });

    const client = new VestflowClient({ network: "testnet" });
    const profile = await client.getProfile(ACCOUNT);

    expect(profile).toEqual({
      address: ACCOUNT,
      network: "testnet",
      streams: [],
      splits: { receivers: [], hash: "" },
      gives: [],
      dripsLists: [],
      totals: {
        streams: 0,
        splitsReceivers: 0,
        gives: 0,
        totalGiven: 0n,
        dripsLists: 0,
      },
    });
  });

  it("maps an empty-but-200 payload to zeros", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({
        address: ACCOUNT,
        network: "testnet",
        streams: [],
        splits: { receivers: [], hash: "" },
        gives: [],
        dripsLists: [],
        totals: {
          streams: 0,
          splitsReceivers: 0,
          gives: 0,
          totalGiven: "0",
          dripsLists: 0,
        },
      }),
    });

    const client = new VestflowClient({ network: "testnet" });
    const profile = await client.getProfile(ACCOUNT);

    expect(profile.streams).toEqual([]);
    expect(profile.gives).toEqual([]);
    expect(profile.totals.totalGiven).toBe(0n);
    expect(profile.totals.streams).toBe(0);
  });

  it("throws ProfileError with status 400 for an invalid address", async () => {
    const client = new VestflowClient({ network: "testnet" });

    const err = await client.getProfile("not-an-address").catch((e) => e);
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/valid Stellar public key/i);
  });

  it("throws ProfileError with the indexer status on unexpected failures", async () => {
    mockFetchOnce({ ok: false, status: 500, json: async () => ({}) });

    const client = new VestflowClient({ network: "testnet" });
    const err = await client.getProfile(ACCOUNT).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.status).toBe(500);
  });

  it("requests /profile/:address with the network query param", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const client = new VestflowClient({
      network: "testnet",
      indexerUrl: "http://indexer.local",
    });
    await client.getProfile(ACCOUNT);

    expect(fetchMock).toHaveBeenCalledWith(
      `http://indexer.local/profile/${ACCOUNT}?network=testnet`
    );
  });
});
