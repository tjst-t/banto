import { test, expect } from "@playwright/test";

test.describe("Canvas header fixed", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto("http://localhost:4100");
    await page.waitForSelector(".shell", { timeout: 5000 });
  });

  test("canvas tabstrip is sticky", async ({ page }) => {
    const tabstrip = page.locator(".canvas-tabstrip");
    const tabstyle = await tabstrip.evaluate(el => {
      const cs = window.getComputedStyle(el);
      return {
        position: cs.position,
        zIndex: cs.zIndex,
        top: cs.top
      };
    });
    console.log("Canvas tabstrip style:", tabstyle);

    // position should be sticky or fixed
    expect(tabstyle.position).toBe("sticky");

    // z-index should be higher than content
    expect(parseInt(tabstyle.zIndex)).toBeGreaterThan(1);

    await page.screenshot({ path: "test-results/canvas-tab-fixed.png" });
  });
});
