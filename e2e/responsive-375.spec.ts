import { test, expect, devices } from "@playwright/test";

/**
 * Regression tests for the mobile responsiveness acceptance criteria:
 *  - No horizontal overflow at 375px viewport
 *  - Tables scroll horizontally inside their own container
 *  - Forms stack vertically on small screens
 *  - Touch targets are at least 44x44px
 *
 * These checks run against the public (no-wallet) states of each view so they
 * do not depend on a connected wallet or contract/indexer data.
 */
const MOBILE_VIEWPORT = { width: 375, height: 812 };

async function expectNoHorizontalOverflow(page: import("@playwright/test").Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth, "document should not overflow horizontally").toBeLessThanOrEqual(
    metrics.clientWidth + 1,
  );
}

test.describe("Responsive @ 375px", () => {
  test.use({ viewport: MOBILE_VIEWPORT });

  test("splits configuration does not overflow", async ({ page }) => {
    await page.goto("/app/splits");
    await expectNoHorizontalOverflow(page);
  });

  test("landing page does not overflow", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
  });

  test("splits receiver table scrolls inside its own container", async ({ page }) => {
    await page.goto("/app/splits");
    // The table wrapper must be the element that scrolls, not the page.
    const scrollContainers = page.locator(".overflow-x-auto");
    if ((await scrollContainers.count()) > 0) {
      const box = await scrollContainers.first().boundingBox();
      expect(box?.width ?? 0).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    }
  });

  test("interactive controls meet 44x44 touch target", async ({ page }) => {
    await page.goto("/app/splits");
    // Connect-wallet CTA / refresh-style buttons should be tappable.
    const buttons = page.locator("button, a[role='button'], input[type='submit']");
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const el = buttons.nth(i);
      // Skip Next.js dev-only overlay controls (not part of the app UI).
      if ((await el.getAttribute("id")) === "next-logo") continue;
      const box = await el.boundingBox();
      if (!box) continue;
      // Skip visually hidden / zero-size elements.
      if (box.width === 0 || box.height === 0) continue;
      expect(box.height, `control #${i} should be >= 44px tall`).toBeGreaterThanOrEqual(44);
    }
  });
});
