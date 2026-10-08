// Canvas の色と段は banto が持ち、渡す（決定・2026-09-25、ユーザー——v4-frontend.md §6.27）。
//
// 見るもの（規則14——渡したことではなく、画面に出た色と大きさまで）：
//   1. 開いた画面（FileSystem）の字・地・危ない色・字の大きさ・角が、banto の画面の値と同じ
//   2. 開いたまま明暗を変えると、張り直さずに暗い値へ変わる（渡し直し）
//   3. 暗いときに開いた別の Module の画面（サブエージェント）も、はじめから暗い値
//   4. 渡すのは標準の名前だけ（banto 独自の名前は画面に届いていない）
//
// 期待値は banto の画面から読む——**値をここに書かない**（写しを持つと、いつか食い違う・規則3）。
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, openApp, waitForProjectModule, openPaletteEntry } from "../helpers.js";

test.setTimeout(180_000);

const PROJECT_NAME = "E2E Canvas Styles";

/** 見比べる性質。左が banto の画面（層A の名前）、右が Module の画面（それぞれの局所の名前） */
const PROBES = {
  text: { host: { color: "var(--banto-text)" }, canvas: { color: "var(--ink)" } },
  surface: { host: { backgroundColor: "var(--banto-surface)" }, canvas: { backgroundColor: "var(--bg)" } },
  muted: { host: { color: "var(--banto-text-3)" }, canvas: { color: "var(--ink-3)" } },
  accent: { host: { color: "var(--banto-accent)" }, canvas: { color: "var(--accent)" } },
  danger: { host: { color: "var(--banto-stop)" }, canvas: { color: "var(--danger)" } },
  ok: { host: { color: "var(--banto-ok)" }, canvas: { color: "var(--ok)" } },
  line: { host: { borderTopColor: "var(--banto-line)" }, canvas: { borderTopColor: "var(--line)" } },
  small: { host: { fontSize: "var(--banto-text-sm)" }, canvas: { fontSize: "var(--t-sm)" } },
  radius: { host: { borderTopLeftRadius: "var(--banto-radius-sm)" }, canvas: { borderTopLeftRadius: "var(--r-sm)" } },
} as const;
type Side = "host" | "canvas";

/** 小さな要素に CSS を当てて、計算された値を読む（色は rgb に揃う——書き方の違いで食い違わない） */
function probe(side: Side) {
  return (_: unknown, arg: { probes: typeof PROBES; side: Side }) => {
    const out: Record<string, string> = {};
    for (const [name, sides] of Object.entries(arg.probes)) {
      const el = document.createElement("div");
      el.style.borderTop = "1px solid";
      Object.assign(el.style, sides[arg.side]);
      document.body.append(el);
      const cs = getComputedStyle(el);
      const prop = Object.keys(sides[arg.side])[0]!;
      out[name] = cs.getPropertyValue(prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
      el.remove();
    }
    return out;
  };
}
const hostValues = (page: Page) => page.locator("body").evaluate(probe("host"), { probes: PROBES, side: "host" as const });
const canvasValues = (canvas: FrameLocator) =>
  canvas.locator("body").evaluate(probe("canvas"), { probes: PROBES, side: "canvas" as const });

test("Canvas の色と段は banto が渡す——開いたままでも、明暗を変えると付いてくる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-canvas-styles-"));
  writeFileSync(join(projectRoot, "notes.txt"), "メモ\n");
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  const light = await hostValues(page);

  // ---- 1. 開いた画面の値が、banto の画面の値と同じ -------------------------------------------
  await openPaletteEntry(page, /ファイル/);
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
  const frame = page.locator('[data-testid="module-canvas-frame"]');
  const fs = frame.contentFrame().frameLocator("iframe");
  await expect(fs.locator('.tree-body > .row[data-path="notes.txt"]')).toBeVisible({ timeout: 60_000 });
  expect(await canvasValues(fs)).toEqual(light);
  // 実際に描かれた要素でも見る：ツリーの行の字の大きさ、本文の字の色、大きく開いた地
  await expect(fs.locator('.row[data-path="notes.txt"]')).toHaveCSS("font-size", light.small);
  await expect(fs.locator("body")).toHaveCSS("color", light.text);
  await expect(fs.locator("body")).toHaveCSS("background-color", light.surface);
  // 4. 届いているのは標準の名前だけ
  const names = await fs.locator("html").evaluate((el) => [...(el as HTMLElement).style].filter((n) => n.startsWith("--")));
  expect(names).toContain("--color-text-danger");
  expect(names.filter((n) => n.startsWith("--banto-")), "banto 独自の名前が画面に届いている").toEqual([]);

  // ---- 2. 開いたまま暗くすると、張り直さずに付いてくる -------------------------------------------
  const generation = await frame.getAttribute("data-bridge-generation");
  await page.getByRole("button", { name: "明暗を切り替え" }).click();
  await page.getByRole("menuitem", { name: "ダーク" }).click();
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  const dark = await hostValues(page);
  expect(dark.text, "banto の画面が暗くなっていない（試験の前提）").not.toBe(light.text);
  await expect(fs.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => canvasValues(fs)).toEqual(dark);
  await expect(fs.locator("body")).toHaveCSS("background-color", dark.surface);
  expect(await frame.getAttribute("data-bridge-generation"), "明暗の切り替えで画面を張り直した").toBe(generation);

  // ---- 3. 暗いときに開いた別の Module の画面も、はじめから暗い -----------------------------------
  await openPaletteEntry(page, /サブエージェント/);
  await expect(page.getByText(/^Canvas — subagent$/)).toBeVisible({ timeout: 30_000 });
  const sub = page.locator('[data-testid="module-canvas-frame"]').contentFrame().frameLocator("iframe");
  await expect(sub.locator(".title")).toHaveText("サブエージェント", { timeout: 60_000 });
  await expect(sub.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await canvasValues(sub)).toEqual(dark);
  await expect(sub.locator(".title")).toHaveCSS("color", dark.text);
  await expect(sub.locator('[data-role="agent"]').first()).toHaveCSS("border-top-left-radius", dark.radius);

  // 明るく戻すと、こちらも付いてくる
  await page.getByRole("button", { name: "明暗を切り替え" }).click();
  await page.getByRole("menuitem", { name: "ライト" }).click();
  await expect(sub.locator("html")).toHaveAttribute("data-theme", "light");
  await expect.poll(() => canvasValues(sub)).toEqual(light);

  expect(pageErrors).toEqual([]);
});
