import { test, expect } from "@playwright/test";

test.describe("Desktop layout check", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("http://localhost:4100");
    await page.waitForSelector(".shell", { timeout: 5000 });
  });

  test("desktop has correct layout", async ({ page }) => {
    // Check shell is not fixed on desktop
    const shellStyle = await page.locator(".shell").evaluate(el => {
      const cs = window.getComputedStyle(el);
      return {
        position: cs.position,
        height: cs.height,
        overflow: cs.overflow
      };
    });
    console.log("Desktop shell style:", shellStyle);

    // Check canvas tabstrip is not sticky on desktop
    const tabstripStyle = await page.locator(".canvas-tabstrip").evaluate(el => {
      const cs = window.getComputedStyle(el);
      return {
        position: cs.position,
        zIndex: cs.zIndex
      };
    });
    console.log("Desktop canvas-tabstrip style:", tabstripStyle);

    // Check pane-resizer exists on desktop
    const resizerStyle = await page.locator(".pane-resizer").evaluate(el => {
      const cs = window.getComputedStyle(el);
      return {
        display: cs.display,
        position: cs.position
      };
    });
    console.log("Desktop pane-resizer style:", resizerStyle);

    // Pane resizer should be visible on desktop
    expect(resizerStyle.display).not.toBe("none");

    await page.screenshot({ path: "test-results/desktop-layout.png" });
  });
});
