// Playwright E2E test — bulk-create happy path (#567)
//
// Covers: upload a 10-row CSV → client-side validation → fee simulation →
// submit all batches (mocked Freighter + Soroban RPC) → all 10 rows green.
//
// Prerequisites:
//   npx playwright install chromium
//   npm run dev (or the app is running on http://localhost:3000)
//
// Run:
//   npx playwright test e2e/bulk-create.spec.ts

import { test, expect } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { mockFreighterAndRpc } from "./fixtures/sorobanMock";

const NATIVE_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function buildValidCsv(rowCount: number): string {
  const startTimeIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const header = "beneficiary,token,amount_xlm,start_time_iso,duration_days,cliff_days,kind,revocable";
  const rows = Array.from({ length: rowCount }, () => {
    const beneficiary = Keypair.random().publicKey();
    return `${beneficiary},${NATIVE_TOKEN},100,${startTimeIso},365,0,Linear,true`;
  });
  return [header, ...rows].join("\n");
}

test.describe("Bulk Create happy path", () => {
  test.beforeEach(async ({ page }) => {
    await mockFreighterAndRpc(page, "https://soroban-testnet.stellar.org/**");
  });

  test("uploads a 10-row CSV, simulates fees, submits, and all rows turn green", async ({ page }) => {
    await page.goto("/app/bulk-create");
    await expect(page.getByRole("heading", { name: /bulk create schedules/i })).toBeVisible({
      timeout: 15_000,
    });

    const csv = buildValidCsv(10);
    await page.setInputFiles('input[type="file"]', {
      name: "beneficiaries.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });

    // ── Validation ───────────────────────────────────────────────────────
    await expect(page.getByText(/10 valid/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/0.*errors/i)).toBeVisible();

    // ── Fee simulation, shown before the submit button is enabled ──────────
    await expect(page.getByText(/batch 1: 10 schedules/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/simulating fees/i)).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/total estimated fee/i)).toBeVisible();

    const submitBtn = page.getByRole("button", { name: /submit all batches/i });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // ── Submission: all 10 rows turn green ──────────────────────────────
    await expect(page.getByText(/10 ok/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("✓ Created")).toHaveCount(10);
  });
});
