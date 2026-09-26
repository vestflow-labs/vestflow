// Unit tests for waitForTransaction (#466)
//
// Covers: retry polling, timeout behavior, error propagation,
// success on first FOUND, and custom intervals.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock getTransaction at the RPC server level.
// stellar.ts creates `const server = new StellarRpc.Server(RPC_URL)` at module
// init, so we mock the Server constructor to return our fake.
const mockGetTransaction = vi.fn();

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: function MockServer() {
        return {
          getTransaction: mockGetTransaction,
          getAccount: vi.fn().mockRejectedValue(new Error("not needed")),
          simulateTransaction: vi.fn().mockRejectedValue(new Error("not needed")),
          sendTransaction: vi.fn().mockRejectedValue(new Error("not needed")),
        };
      },
    },
  };
});

// Dynamic import so the mock is applied before module evaluation
const { waitForTransaction } = await import("@/lib/stellar");

// Valid 64-char hex hash
const H =
  "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123ab";

describe("waitForTransaction", () => {
  beforeEach(() => {
    mockGetTransaction.mockReset();
  });

  it("resolves immediately when transaction is already found", async () => {
    mockGetTransaction.mockResolvedValueOnce({
      status: "SUCCESS",
      hash: H,
      latestLedger: 100,
    });

    const result = await waitForTransaction(H);
    expect(result.status).toBe("SUCCESS");
    expect(mockGetTransaction).toHaveBeenCalledTimes(1);
  });

  it("polls until transaction is found", async () => {
    mockGetTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({
        status: "SUCCESS",
        hash: H,
        latestLedger: 105,
      });

    const result = await waitForTransaction(H, { intervalMs: 10 });
    expect(result.status).toBe("SUCCESS");
    expect(mockGetTransaction).toHaveBeenCalledTimes(3);
  });

  it("rejects on NOT_FOUND after timeout", async () => {
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    await expect(
      waitForTransaction(H, { timeoutMs: 100, intervalMs: 20 })
    ).rejects.toThrow(/Timed out/);
  });

  it("rejects immediately on FAILED status", async () => {
    mockGetTransaction.mockResolvedValueOnce({
      status: "FAILED",
      hash: H,
    });

    await expect(waitForTransaction(H)).rejects.toThrow(/failed/);
  });

  it("rejects immediately on error status", async () => {
    mockGetTransaction.mockResolvedValueOnce({
      status: "ERROR",
      hash: H,
      error: "Network error",
    });

    await expect(waitForTransaction(H)).rejects.toThrow(/error/i);
  });

  it("uses custom interval", async () => {
    mockGetTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({
        status: "SUCCESS",
        hash: H,
        latestLedger: 200,
      });

    const start = Date.now();
    await waitForTransaction(H, { intervalMs: 50 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(mockGetTransaction).toHaveBeenCalledTimes(2);
  });

  it("rejects with timeout message including duration", async () => {
    mockGetTransaction.mockResolvedValue({ status: "NOT_FOUND" });

    await expect(
      waitForTransaction(H, { intervalMs: 10, timeoutMs: 100 })
    ).rejects.toThrow(/100ms/);
  });

  it("surfaces server errors as thrown errors", async () => {
    mockGetTransaction.mockRejectedValueOnce(new Error("RPC connection lost"));

    await expect(waitForTransaction(H)).rejects.toThrow(/RPC connection lost/);
  });
});
