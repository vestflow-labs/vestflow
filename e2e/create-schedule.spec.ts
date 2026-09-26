// Playwright E2E test — create schedule happy path (#463)
//
// Covers: connect wallet → fill form → submit → see schedule on dashboard.
//
// Prerequisites:
//   npx playwright install chromium
//   npm run dev (or the app is running on http://localhost:3000)
//
// Run:
//   npx playwright test e2e/create-schedule.spec.ts

import { test, expect } from "@playwright/test";

test.describe("Create Schedule happy path", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the app — the wallet connect flow is mocked in CI.
    await page.goto("/app");
  });

  test("connects wallet, fills form, submits, and sees schedule on dashboard", async ({
    page,
  }) => {
    // ── Step 1: Connect wallet ──────────────────────────────────────────
    // The app shows a "Connect Wallet" button when no wallet is connected.
    const connectBtn = page.getByRole("button", { name: /connect/i });
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
      // In a real E2E test this would open a wallet modal. For CI we mock
      // the wallet provider so clicking connect auto-connects.
      await expect(connectBtn).toBeHidden({ timeout: 10_000 });
    }

    // ── Step 2: Navigate to create page ─────────────────────────────────
    await page.goto("/app/create");
    await expect(page.getByRole("heading", { name: /create.*schedule/i })).toBeVisible();

    // ── Step 3: Fill the form ───────────────────────────────────────────
    // Beneficiary address (a valid Stellar address placeholder).
    const beneficiaryInput = page.getByLabel(/beneficiary/i);
    await beneficiaryInput.fill("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");

    // Amount.
    const amountInput = page.getByLabel(/amount/i);
    await amountInput.fill("1000");

    // Duration — select "6 months" or fill custom.
    const durationSelect = page.getByLabel(/duration/i);
    if (await durationSelect.isVisible()) {
      await durationSelect.selectOption({ label: "6 months" });
    } else {
      // Custom duration input (days).
      const durationInput = page.getByLabel(/duration.*day/i);
      await durationInput.fill("180");
    }

    // ── Step 4: Submit ──────────────────────────────────────────────────
    const submitBtn = page.getByRole("button", { name: /create|submit|confirm/i });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Wait for the transaction to be submitted and confirmed.
    // The app should show a success message or redirect to the dashboard.
    await expect(
      page.getByText(/success|created|confirmed/i)
    ).toBeVisible({ timeout: 30_000 });

    // ── Step 5: Verify schedule appears on dashboard ────────────────────
    await page.goto("/app");
    // The dashboard should list at least one schedule.
    await expect(
      page.getByText(/schedule.*#|vesting.*schedule/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("validates required fields before submission", async ({ page }) => {
    await page.goto("/app/create");

    // Try to submit without filling anything.
    const submitBtn = page.getByRole("button", { name: /create|submit|confirm/i });
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
      // Should show validation errors.
      await expect(
        page.getByText(/required|invalid|must be/i)
      ).toBeVisible({ timeout: 5_000 });
    }
  });
});
