import { describe, it, expect, vi } from "vitest";
import { VestflowClient } from "../src/client";

// A real, checksum-valid Ed25519 account address (not client.ts's
// FALLBACK_ACCOUNT, which is a malformed 55-char string that fails strict
// StrKey validation) and the testnet native token SAC address already used
// elsewhere in this codebase.
const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const signer = vi.fn();

describe("give (#679)", () => {
  it("submits a give transaction and returns the settled result", async () => {
    const client = new VestflowClient({ network: "testnet" });
    const spy = vi
      .spyOn(client as any, "submitAndSettle")
      .mockResolvedValue({ hash: "abc123", status: "SUCCESS" });

    const result = await client.give(ACCOUNT, ACCOUNT, CONTRACT, 100n, signer);

    expect(result).toEqual({ hash: "abc123", status: "SUCCESS" });
    expect(spy).toHaveBeenCalledWith(ACCOUNT, "give", expect.any(Array), signer);
  });

  it("throws when receiver is not a valid Stellar address", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.give(ACCOUNT, "not-an-address", CONTRACT, 100n, signer)
    ).rejects.toThrow(/receiver/i);
  });

  it("throws when token is not a valid Stellar Asset Contract address", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.give(ACCOUNT, ACCOUNT, "not-a-token", 100n, signer)
    ).rejects.toThrow(/token/i);
  });

  it("throws when token is a classic account address rather than a contract", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.give(ACCOUNT, ACCOUNT, ACCOUNT, 100n, signer)
    ).rejects.toThrow(/token/i);
  });

  it("throws when amount is zero", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.give(ACCOUNT, ACCOUNT, CONTRACT, 0n, signer)
    ).rejects.toThrow(/amount/i);
  });

  it("throws when amount is negative", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.give(ACCOUNT, ACCOUNT, CONTRACT, -1n, signer)
    ).rejects.toThrow(/amount/i);
  });

  it("accepts a contract address as the receiver", async () => {
    const client = new VestflowClient({ network: "testnet" });
    vi.spyOn(client as any, "submitAndSettle").mockResolvedValue({
      hash: "def456",
      status: "SUCCESS",
    });

    const result = await client.give(ACCOUNT, CONTRACT, CONTRACT, 1n, signer);
    expect(result.hash).toBe("def456");
  });
});
