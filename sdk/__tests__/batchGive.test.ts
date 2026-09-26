import { describe, it, expect, vi } from "vitest";
import { VestflowClient } from "../src/client";

const ACCOUNT = "GDZ2GDLBPUCEXA3I5U7WN5E3CNQ3JBP5FK464EMLTHPCX6KVB5N4A4YT";
const RECEIVER_B = "GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const signer = vi.fn();

describe("batchGive (#851)", () => {
  it("submits a batch_give transaction for two receivers", async () => {
    const client = new VestflowClient({ network: "testnet" });
    const spy = vi
      .spyOn(client as any, "submitAndSettle")
      .mockResolvedValue({ hash: "batchhash", status: "SUCCESS" });

    const result = await client.batchGive(
      ACCOUNT,
      [ACCOUNT, RECEIVER_B],
      [100n, 200n],
      CONTRACT,
      signer
    );

    expect(result).toEqual({ hash: "batchhash", status: "SUCCESS" });
    expect(spy).toHaveBeenCalledWith(
      ACCOUNT,
      "batch_give",
      expect.any(Array),
      signer
    );
  });

  it("rejects when receivers and amounts lengths differ", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.batchGive(ACCOUNT, [ACCOUNT, RECEIVER_B], [100n], CONTRACT, signer)
    ).rejects.toThrow(/same length/i);
  });

  it("rejects when any amount is not positive", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.batchGive(ACCOUNT, [ACCOUNT], [0n], CONTRACT, signer)
    ).rejects.toThrow(/greater than 0/i);
    await expect(
      client.batchGive(ACCOUNT, [ACCOUNT], [-1n], CONTRACT, signer)
    ).rejects.toThrow(/greater than 0/i);
  });

  it("rejects an invalid receiver address", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.batchGive(ACCOUNT, ["not-an-address"], [1n], CONTRACT, signer)
    ).rejects.toThrow(/receivers\[0\]/i);
  });

  it("rejects an empty receivers list", async () => {
    const client = new VestflowClient({ network: "testnet" });
    await expect(
      client.batchGive(ACCOUNT, [], [], CONTRACT, signer)
    ).rejects.toThrow(/empty/i);
  });
});
