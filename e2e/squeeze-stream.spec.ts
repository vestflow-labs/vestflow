// Playwright E2E test — squeeze streams happy path (#859)
//
// Covers: open a stream → advance the mocked ledger clock by half a cycle →
// click Squeeze → tx confirmed (mocked Freighter + Soroban RPC) → the
// collectable balance grew by ≈ rate × elapsed seconds and was collected.
//
// The browser clock is pinned to the mocked ledger time with page.clock, so
// the dashboard and the mocked contract views agree on elapsed time and the
// test is deterministic.
//
// Prerequisites:
//   npx playwright install chromium
//   npm run dev (or the app is running on http://localhost:3000)
//
// Run:
//   npx playwright test e2e/squeeze-stream.spec.ts

import { test, expect } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { MOCK_PUBLIC_KEY, mockFreighterAndRpc, type MockRpc } from "./fixtures/sorobanMock";

const NATIVE_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const STROOPS_PER_XLM = 10_000_000;
/** Matches CYCLE_DURATION_SECONDS in components/CycleCountdown.tsx. */
const CYCLE_SECS = 86_400;
const HALF_CYCLE_SECS = CYCLE_SECS / 2;
const RATE_PER_SECOND = 1_000; // stroops/s → 4.32 XLM over half a cycle
const STREAM_ID = 1;
/** Fixed stream open time (2026-01-01T00:00:00Z) so every run sees identical balances. */
const OPENED_AT = Date.UTC(2026, 0, 1) / 1000;

function xlmTextToStroops(text: string): number {
  return Math.round(parseFloat(text) * STROOPS_PER_XLM);
}

test.describe("Squeeze streams happy path", () => {
  let rpc: MockRpc;

  test.beforeEach(async ({ page }) => {
    rpc = await mockFreighterAndRpc(page, "https://soroban-testnet.stellar.org/**", {
      ledgerTime: OPENED_AT,
      stream: {
        id: STREAM_ID,
        grantor: Keypair.random().publicKey(),
        beneficiary: MOCK_PUBLIC_KEY,
        token: NATIVE_TOKEN,
        ratePerSecond: BigInt(RATE_PER_SECOND),
        startTime: OPENED_AT,
        duration: 30 * CYCLE_SECS,
      },
    });
    await page.clock.setFixedTime(OPENED_AT * 1000);
    // Skip the first-visit onboarding tour so its overlay can't intercept clicks.
    await page.addInitScript(() => localStorage.setItem("vestflow-tour-completed", "true"));
  });

  test("advances half a cycle, squeezes, and collects rate × elapsed", async ({ page }) => {
    // ── Open the stream: nothing has dripped yet, so there is nothing to squeeze ──
    await page.goto("/app");
    const card = page
      .locator('[data-tour="schedule-card"]')
      .filter({ hasText: `Schedule #${STREAM_ID}` });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByRole("button", { name: "Squeeze", exact: true })).toHaveCount(0);

    // ── Advance mock time by half a cycle ────────────────────────────────
    rpc.advanceLedgerTime(HALF_CYCLE_SECS);
    await page.clock.setFixedTime((OPENED_AT + HALF_CYCLE_SECS) * 1000);
    await page.reload();

    // ── Squeeze: collectable balance ≈ rate × elapsed seconds ──────────────
    await card.getByRole("button", { name: "Squeeze", exact: true }).click({ timeout: 15_000 });
    const collectable = page
      .getByText("Estimated to collect", { exact: true })
      .locator("xpath=following-sibling::p[1]");
    await expect(collectable).toHaveText(/ XLM$/, { timeout: 10_000 });
    const collectableText = (await collectable.textContent()) ?? "";

    const expectedStroops = RATE_PER_SECOND * HALF_CYCLE_SECS;
    const toleranceStroops = RATE_PER_SECOND * 5; // a few seconds of drift
    expect(Math.abs(xlmTextToStroops(collectableText) - expectedStroops)).toBeLessThanOrEqual(
      toleranceStroops
    );

    await page.getByRole("button", { name: "Squeeze Now" }).click();
    await expect(page.getByText("Stream squeezed!")).toBeVisible({ timeout: 15_000 });

    // ── Collected balance updated in the UI after the tx confirms ────────────
    const claimed = card.getByText("Claimed", { exact: true }).locator("xpath=following-sibling::p[1]");
    await expect(claimed).toHaveText(collectableText, { timeout: 10_000 });
  });
});
