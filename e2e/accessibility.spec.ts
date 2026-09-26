// Playwright + axe-core accessibility audit (#468)
//
// Runs an automated axe-core scan against the dashboard and create-schedule
// pages to catch missing ARIA labels, contrast issues, and keyboard
// navigation gaps that manual testing tends to miss.
//
// Run:
//   npx playwright test e2e/accessibility.spec.ts

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Accessibility audit", () => {
  test("dashboard page has no detectable a11y violations", async ({ page }) => {
    await page.goto("/app");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });

  test("create schedule form has no detectable a11y violations", async ({ page }) => {
    await page.goto("/app/create");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  });
});

// axe's default failure message doesn't surface which rule/node failed —
// print a compact summary so a CI failure is actionable without re-running
// the report locally.
function formatViolations(violations: import("axe-core").Result[]): string {
  if (violations.length === 0) return "";
  return violations
    .map(
      (v) =>
        `\n[${v.impact}] ${v.id}: ${v.description}\n  ${v.helpUrl}\n  nodes: ${v.nodes
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    )
    .join("\n");
}
