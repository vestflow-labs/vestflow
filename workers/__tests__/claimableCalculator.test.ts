// @vitest-environment node
// Message protocol of the claimable-calculator Web Worker (#566).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimableRequest, ClaimableResponse } from "@/lib/portfolio/claimable";
import { claimableAt } from "@/lib/portfolio/claimable";
import { BASE, YEAR, makePortfolio } from "@/lib/portfolio/__tests__/fixtures";

interface FakeScope {
  onmessage: ((ev: { data: ClaimableRequest }) => void) | null;
  postMessage(message: ClaimableResponse): void;
}

let scope: FakeScope;
let posted: ClaimableResponse[];

/** Loads the worker module against a stand-in worker global. */
async function loadWorker() {
  posted = [];
  scope = {
    onmessage: null,
    postMessage: (message) => posted.push(message),
  };
  vi.stubGlobal("self", scope);
  vi.resetModules();
  await import("../claimable-calculator.worker");
}

function send(request: ClaimableRequest) {
  scope.onmessage?.({ data: request });
}

beforeEach(async () => {
  await loadWorker();
});

describe("claimable-calculator worker", () => {
  const schedules = makePortfolio(4);

  it("answers a seeded request with one result per schedule", () => {
    send({ cursorLedger: BASE + YEAR / 2, schedules });

    expect(posted).toHaveLength(1);
    expect(posted[0].cursorLedger).toBe(BASE + YEAR / 2);
    expect(posted[0].results.map((r) => r.scheduleId)).toEqual([1, 2, 3, 4]);
  });

  it("matches the main thread's own calculation exactly", () => {
    const cursor = BASE + YEAR / 3;
    send({ cursorLedger: cursor, schedules });

    for (const result of posted[0].results) {
      const schedule = schedules.find((s) => s.id === result.scheduleId)!;
      expect(result.claimableAtCursor).toBe(claimableAt(schedule, cursor));
    }
  });

  it("reuses the cached schedule set for cursor-only messages", () => {
    send({ cursorLedger: BASE, schedules });
    send({ cursorLedger: BASE + YEAR });

    expect(posted).toHaveLength(2);
    expect(posted[1].results).toHaveLength(schedules.length);
    // A year on, everything with no lockup has something claimable.
    expect(posted[1].results.some((r) => r.claimableAtCursor > 0n)).toBe(true);
  });

  it("echoes the request id so stale responses can be discarded", () => {
    send({ cursorLedger: BASE, schedules, requestId: 7 });
    expect(posted[0].requestId).toBe(7);
  });

  it("ignores malformed messages instead of throwing", () => {
    send({ schedules } as unknown as ClaimableRequest);
    scope.onmessage?.({ data: undefined as unknown as ClaimableRequest });
    expect(posted).toHaveLength(0);
  });
});
