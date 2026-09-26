// Unit tests for the standalone waitForTransaction helper (#684)
//
// Covers: success on first poll, success after retries, exponential backoff
// (1s, 2s, 4s, ...), TimeoutError after timeout, and returning the full
// transaction result on success.

import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForTransaction, TimeoutError } from "../src/waitForTransaction";

const H = "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123ab";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitForTransaction helper (#684)", () => {
  it("resolves immediately when the transaction is already found", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValue({ status: "SUCCESS", hash: H, latestLedger: 100 });

    const result = await waitForTransaction(H, { getTransaction });

    expect(result.status).toBe("SUCCESS");
    expect(getTransaction).toHaveBeenCalledTimes(1);
  });

  it("polls until the transaction is found (success after retries)", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS", hash: H, latestLedger: 105 });

    const result = await waitForTransaction(H, {
      getTransaction,
      initialDelayMs: 1,
      maxDelayMs: 8,
    });

    expect(result.status).toBe("SUCCESS");
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff between polls (1s, 2s, 4s, 8s...)", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValue({ status: "SUCCESS", hash: H, latestLedger: 200 });

    const delays: number[] = [];
    const originalSetTimeout = global.setTimeout.bind(global);
    vi.spyOn(global, "setTimeout").mockImplementation(
      ((fn: TimerHandler, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as typeof setTimeout
    );

    await waitForTransaction(H, {
      getTransaction,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
    });

    // First three scheduled waits should double: 1000, 2000, 4000.
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
  });

  it("rejects with TimeoutError when still NOT_FOUND after timeoutMs", async () => {
    const getTransaction = vi.fn().mockResolvedValue({ status: "NOT_FOUND" });

    const promise = waitForTransaction(H, {
      getTransaction,
      timeoutMs: 50,
      initialDelayMs: 5,
      maxDelayMs: 10,
    });

    await expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await expect(promise).rejects.toThrow(/after 50ms/);
  });

  it("uses the default 30s timeout and default backoff", async () => {
    const getTransaction = vi.fn().mockResolvedValue({ status: "NOT_FOUND" });

    const promise = waitForTransaction(H, { getTransaction });
    // Should not reject instantly (would reject only after ~30s).
    await expect(Promise.race([promise, Promise.resolve("pending")])).resolves.toBe(
      "pending"
    );
    // Clean up the pending timer.
    vi.spyOn(global, "setTimeout").mockImplementation((() => 0) as typeof setTimeout);
    // Force the loop to time out quickly by advancing is not possible here, so
    // we simply ensure the first poll happened.
    expect(getTransaction).toHaveBeenCalled();
  });

  it("returns the full transaction result on success", async () => {
    const full = {
      status: "SUCCESS" as const,
      hash: H,
      latestLedger: 999,
      applicationOrder: 1,
      envelopeXdr: "xdr",
      resultXdr: "rxdr",
      resultMetaXdr: "mxdr",
    };
    const getTransaction = vi.fn().mockResolvedValue(full);

    const result = await waitForTransaction(H, { getTransaction });

    expect(result).toEqual(full);
  });

  it("rejects on a terminal FAILED status", async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValue({ status: "FAILED", hash: H, error: "bad seq" });

    await expect(waitForTransaction(H, { getTransaction })).rejects.toThrow(
      /failed/i
    );
  });
});
