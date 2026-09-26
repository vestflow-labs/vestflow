import { describe, it, expect, vi } from "vitest";
import { VestflowClient } from "../src/client";

describe("getAllSchedules timeout (#449)", () => {
  it("rejects with a clear error if the RPC never responds within timeoutMs", async () => {
    const client = new VestflowClient({ network: "testnet" });

    // Simulate an RPC that hangs forever.
    vi.spyOn(client, "getScheduleCount").mockReturnValue(new Promise(() => {}));

    await expect(client.getAllSchedules(undefined, 20)).rejects.toThrow(
      /getAllSchedules timed out after 20ms/
    );
  });

  it("resolves normally when the RPC responds before the deadline", async () => {
    const client = new VestflowClient({ network: "testnet" });

    vi.spyOn(client, "getScheduleCount").mockResolvedValue(0);

    await expect(client.getAllSchedules(undefined, 5_000)).resolves.toEqual([]);
  });
});
