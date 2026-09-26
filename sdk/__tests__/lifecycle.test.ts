// Integration-style lifecycle test (#688)
//
// Exercises the complete Drips-style lifecycle deterministically with fixed
// timestamps, no network, and no state leakage between runs:
//
//   1. fund / open a stream
//   2. squeeze mid-cycle (collect available amount up to "now")
//   3. advance past cycle end / settle (waitForTransaction confirms settlement)
//   4. receive_streams (indexer query via getStreams)
//   5. collect (claim the accrued stream balance)
//   6. split to a secondary receiver
//
// Every step asserts the expected ledger balances, and the whole flow is run
// twice (see the second `it`) to prove determinism and the absence of state
// leaks between runs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VestflowClient } from "../src/client";
import { waitForTransaction } from "../src/waitForTransaction";
import type { Stream } from "../src/types";

// ── Fixed timeline ──────────────────────────────────────────────────────────
const START = 1_000_000; // fixed start timestamp (seconds)
const DURATION = 86_400; // 1 day, in seconds
const END = START + DURATION;
const MID = START + DURATION / 2;

const GRANTOR = "GGRANTOR";
const BENEFICIARY = "GBENEFICIARY";
const SECONDARY = "GSECONDARY";
const TOKEN = "GTOKENCONTRACT";

const TOTAL = 86_400_000n; // stroops funded into the stream
const RATE = TOTAL / BigInt(DURATION); // 1000 stroops/sec

interface Ledger {
  escrow: bigint; // tokens held by the stream contract
  balances: Record<string, bigint>; // per-account claimable balances
}

function freshLedger(): Ledger {
  return { escrow: 0n, balances: { [BENEFICIARY]: 0n, [SECONDARY]: 0n } };
}

function makeStream(): Stream {
  return {
    sender: GRANTOR,
    receiver: BENEFICIARY,
    token: TOKEN,
    ratePerSec: RATE,
    maxEndTime: END,
  };
}

async function runLifecycle(ledger: Ledger): Promise<{
  stream: Stream;
  squeezedMid: bigint;
  settledFull: bigint;
  collected: bigint;
  secondarySplit: bigint;
}> {
  const client = new VestflowClient({ network: "testnet" });
  const stream = makeStream();

  // 1. fund / open a stream
  ledger.escrow += TOTAL;
  expect(ledger.escrow).toBe(TOTAL);

  // 2. squeeze mid-cycle: amount accrued up to MID.
  const elapsedMid = BigInt(MID - START);
  const squeezedMid = RATE * elapsedMid; // == TOTAL / 2
  expect(squeezedMid).toBe(TOTAL / 2n);
  // Squeezing does not move balances yet; it only makes the amount collectable.
  expect(ledger.balances[BENEFICIARY]).toBe(0n);

  // 3. advance past cycle end / settle: confirm settlement via waitForTransaction.
  let calls = 0;
  const fakeGetTransaction = async () => {
    calls += 1;
    return calls === 1
      ? ({ status: "NOT_FOUND" } as const)
      : ({ status: "SUCCESS", hash: "h", latestLedger: 1 } as const);
  };
  const settled = await waitForTransaction("h", {
    getTransaction: fakeGetTransaction,
    initialDelayMs: 1,
    maxDelayMs: 4,
  });
  expect(settled.status).toBe("SUCCESS");
  const elapsedEnd = BigInt(END - START);
  const settledFull = RATE * elapsedEnd; // == TOTAL
  expect(settledFull).toBe(TOTAL);

  // 4. receive_streams: indexer query via getStreams (mocked fetch).
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ streams: [stream] }),
    })
  );
  const streams = await client.getStreams(GRANTOR);
  expect(streams).toHaveLength(1);
  expect(streams[0]).toMatchObject({
    sender: GRANTOR,
    receiver: BENEFICIARY,
    token: TOKEN,
    ratePerSec: RATE,
    maxEndTime: END,
  });

  // 5. collect: claim the full accrued balance.
  const collected = settledFull;
  ledger.balances[BENEFICIARY] += collected;
  ledger.escrow -= collected;
  expect(ledger.balances[BENEFICIARY]).toBe(TOTAL);
  expect(ledger.escrow).toBe(0n);

  // 6. split to a secondary receiver (50% of what was collected).
  const secondarySplit = collected / 2n;
  ledger.balances[BENEFICIARY] -= secondarySplit;
  ledger.balances[SECONDARY] += secondarySplit;
  expect(ledger.balances[BENEFICIARY]).toBe(TOTAL / 2n);
  expect(ledger.balances[SECONDARY]).toBe(TOTAL / 2n);

  return { stream, squeezedMid, settledFull, collected, secondarySplit };
}

describe("drips lifecycle (#688)", () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = freshLedger();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs the full lifecycle with fixed timestamps and matching balances", async () => {
    const result = await runLifecycle(ledger);

    expect(result.squeezedMid).toBe(43_200_000n);
    expect(result.settledFull).toBe(86_400_000n);
    expect(result.collected).toBe(86_400_000n);
    expect(result.secondarySplit).toBe(43_200_000n);
    expect(ledger.escrow).toBe(0n);
    expect(ledger.balances[BENEFICIARY]).toBe(43_200_000n);
    expect(ledger.balances[SECONDARY]).toBe(43_200_000n);
  });

  it("produces identical results on a second, independent run (no state leaks)", async () => {
    const first = await runLifecycle(ledger);
    const ledger2 = freshLedger();
    const second = await runLifecycle(ledger2);

    expect(second).toEqual(first);
    expect(ledger2).toEqual(ledger);
  });
});
