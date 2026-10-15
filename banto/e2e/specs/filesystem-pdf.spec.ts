// **PDF を元の見た目で読む**（v4-modules.md §2.2「PDF・Office…」、Backlog #302、2026-10-15）。
//
// AI の showFile が PDF を指すと、host は別の画面（`ui://banto-filesystem/document`、pdf.js を Worker 無しで同梱）を選ぶ。
// 規則14——「開けた」で終わらせず、画面が出している中身を一つずつ見る：見出しのパス・ページ数・1ページ目の文字の層の
// 文字・選んだ文字・探した件数と飛んだ先のページ・描いているページが見えている周りだけであること・大きく開いた画面の中身。
// 日本語は埋め込まないフォントで書く（pdf.js 同梱の CMap が要る——Canvas は fetch できないので `readPdfAsset` を通る）。
// 大きな PDF は 50MB を超え、ページの物は詰め物の後ろにある——範囲で読めなければ開けない
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";
import { makeJapanesePdf } from "../pdf-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const CHAPTERS = Array.from({ length: 100 }, (_, i) => [`第${i + 1}章 受信箱の見直し`, `本文その${i + 1}：結論を先に書く。`]);

/** 大きく開いた PDF の画面（会話の隣）。枠がいくつあっても、PDF が出ている最後の枠を選ぶ */
async function fullscreenPdf(page: Page): Promise<FrameLocator> {
  const frames = page.locator('[data-testid="module-canvas-frame"]');
  let index = -1;
  await expect(async () => {
    const count = await frames.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const inner = frames.nth(i).contentFrame().frameLocator("iframe");
      const mode = await inner.locator("body").getAttribute("data-mode", { timeout: 1_000 }).catch(() => null);
      if (mode === "fullscreen" && (await inner.getByTestId("pdf-view").isVisible().catch(() => false))) {
        index = i;
        return;
      }
    }
    throw new Error(`大きく開いた PDF の画面が無い（枠は ${count} 個）`);
  }).toPass({ timeout: 60_000 });
  return frames.nth(index).contentFrame().frameLocator("iframe");
}

/** その画面の1ページ目の文字の層が出るまで待ち、つないだ文字を返す */
async function pageText(view: FrameLocator, n: number): Promise<string> {
  const layer = view.locator(`.pdf-page[data-page="${n}"].rendered .textLayer`);
  await expect(layer, `${n} ページの文字の層が出ない`).toBeVisible({ timeout: 60_000 });
  return (await layer.locator("span").allTextContents()).join("");
}

test("AI が見せた 100 ページの日本語 PDF を会話の中で読み、文字を選び、探し、大きく開いても読める", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fspdf-"));
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(join(projectRoot, "docs/plan.pdf"), makeJapanesePdf(CHAPTERS));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, "E2E FS PDF", projectRoot);
  await waitForProjectModule(page, "E2E FS PDF", "filesystem");

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("計画の PDF を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/plan.pdf" } }] }));
  await composer.press("Enter");

  // ---- 会話の中：PDF の画面（テキストの画面ではない）------------------------------
  const embed = page.locator('[data-testid="inline-module-view"][data-module="filesystem"]');
  await expect(embed).toBeVisible({ timeout: 120_000 });
  const card = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(card.locator("body")).toHaveAttribute("data-surface", "document", { timeout: 60_000 });
  await expect(card.getByTestId("pdf-view")).toBeVisible();
  await expect(card.getByTestId("open-path")).toHaveText("docs/plan.pdf");
  await expect(card.getByTestId("pdf-page-label")).toHaveText("1 / 100 ページ", { timeout: 60_000 });
  await expect(card.getByTestId("pdf-page")).toHaveCount(100);
  await expect(card.getByRole("button", { name: "大きく表示" })).toBeVisible();

  // ---- 1ページ目の文字が読める（埋め込まない日本語のフォント——CMap を通っている）-------------
  expect(await pageText(card, 1)).toBe("第1章 受信箱の見直し本文その1：結論を先に書く。");
  // 絵も描けている（canvas が真っ白ではない）
  const inked = await card.locator('.pdf-page[data-page="1"] canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 128 && data[i + 3]! > 0) dark++;
    return dark;
  });
  expect(inked, "1ページ目の canvas に何も描かれていない").toBeGreaterThan(50);

  // ---- 文字を選べる -------------------------------------------------------------
  const selected = await card.locator('.pdf-page[data-page="1"] .textLayer').evaluate((layer) => {
    const spans = [...layer.querySelectorAll("span")].filter((s) => s.textContent);
    const range = document.createRange();
    range.setStartBefore(spans[0]!);
    range.setEndAfter(spans[2]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return { text: selection.toString(), userSelect: getComputedStyle(spans[0]!).userSelect, color: getComputedStyle(spans[0]!).color };
  });
  expect(selected.text).toBe("第1章 受信箱の見直し");
  expect(selected.userSelect).toBe("text");
  expect(selected.color, "文字の層の字が透けていない（絵の上に字が二重に出る）").toBe("rgba(0, 0, 0, 0)");

  // ---- 見えているページとその前後だけ描く -----------------------------------------
  await expect.poll(() => card.locator(".pdf-page.rendered").count(), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await card.locator(".pdf-page canvas").count(), "見えていないページまで描いている").toBeLessThanOrEqual(4);
  await expect(card.locator('.pdf-page[data-page="50"] canvas')).toHaveCount(0);

  // ---- 探す：当たった数・飛んだ先のページ・印の付いた文字 -----------------------------
  const search = card.getByTestId("pdf-search");
  await search.fill("受信箱");
  await search.press("Enter");
  await expect(card.getByTestId("pdf-search-count")).toHaveText("1 / 100 件", { timeout: 60_000 });
  await search.fill("第37章");
  await search.press("Enter");
  await expect(card.getByTestId("pdf-search-count")).toHaveText("1 / 1 件", { timeout: 60_000 });
  await expect(card.getByTestId("pdf-page-label")).toHaveText("37 / 100 ページ", { timeout: 30_000 });
  await expect(card.locator('.pdf-page[data-page="37"] .textLayer .highlight.selected')).toHaveText("第37章", { timeout: 30_000 });
  expect(await pageText(card, 37)).toBe("第37章 受信箱の見直し本文その37：結論を先に書く。");
  // 1ページ目は見えなくなった——描いたものは捨てている
  await expect(card.locator('.pdf-page[data-page="1"] canvas')).toHaveCount(0);
  expect(await card.locator(".pdf-page canvas").count()).toBeLessThanOrEqual(4);
  await search.fill("見つからない語");
  await search.press("Enter");
  await expect(card.getByTestId("pdf-search-count")).toHaveText("見つかりません", { timeout: 60_000 });

  // ---- 大きく開く：同じ PDF が画面いっぱいに出て、1ページ目から読める -------------------
  await card.getByRole("button", { name: "大きく表示" }).click();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
  const full = await fullscreenPdf(page);
  await expect(full.getByTestId("open-path")).toHaveText("docs/plan.pdf");
  await expect(full.getByTestId("pdf-page-label")).toHaveText("1 / 100 ページ", { timeout: 60_000 });
  await expect(full.getByRole("button", { name: "大きく表示" })).toBeHidden();
  expect(await pageText(full, 1)).toBe("第1章 受信箱の見直し本文その1：結論を先に書く。");
  await full.getByTestId("pdf-search").fill("第100章");
  await full.getByTestId("pdf-search").press("Enter");
  await expect(full.getByTestId("pdf-search-count")).toHaveText("1 / 1 件", { timeout: 60_000 });
  await expect(full.getByTestId("pdf-page-label")).toHaveText("100 / 100 ページ", { timeout: 30_000 });
  expect(await pageText(full, 100)).toBe("第100章 受信箱の見直し本文その100：結論を先に書く。");

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("50MB を超える PDF も、中身を全部は運ばずに開いて1ページ目が読める", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fspdfbig-"));
  const big = makeJapanesePdf([["大きな PDF の1ページ目"], ["2ページ目の本文"], ["3ページ目の本文"]], { padBytes: 52 * 1024 * 1024 });
  expect(big.length).toBeGreaterThan(50 * 1024 * 1024);
  writeFileSync(join(projectRoot, "big.pdf"), big);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, "E2E FS PDF Big", projectRoot);
  await waitForProjectModule(page, "E2E FS PDF Big", "filesystem");

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("大きな PDF を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "big.pdf" } }] }));
  await composer.press("Enter");

  const card = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(card.locator("body")).toHaveAttribute("data-surface", "document", { timeout: 120_000 });
  await expect(card.getByTestId("open-path")).toHaveText("big.pdf");
  await expect(card.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });
  expect(await pageText(card, 1)).toBe("大きな PDF の1ページ目");
  await card.getByTestId("pdf-search").fill("3ページ目");
  await card.getByTestId("pdf-search").press("Enter");
  await expect(card.getByTestId("pdf-search-count")).toHaveText("1 / 1 件", { timeout: 60_000 });
  expect(await pageText(card, 3)).toBe("3ページ目の本文");

  // 大きく開いても読める
  await card.getByRole("button", { name: "大きく表示" }).click();
  const full = await fullscreenPdf(page);
  await expect(full.getByTestId("pdf-page-label")).toHaveText("1 / 3 ページ", { timeout: 60_000 });
  expect(await pageText(full, 1)).toBe("大きな PDF の1ページ目");
  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
