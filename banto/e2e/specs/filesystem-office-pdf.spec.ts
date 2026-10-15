// **pptx を document の画面でスライドとして読む・docx の「元に近い見た目で見る」を PDF に切り替える**（v4-modules.md §2.2
// 「PDF・Office…」の「描き方」、Backlog #305、2026-10-15）。
//
// AI の showFile が pptx を指すと、host は PDF と同じ画面（`ui://banto-filesystem/document`）を選び、画面は変換役（LibreOffice）に
// PDF にしてもらって pdf.js で描く。初めてのときは変換役を入れるので数分かかり、その間は「入れています」と出る。
// 規則14——開けたで終わらせず、画面が出している中身を一つずつ見る：パス・何枚目か（スライドで数える）・スライドの数・
// 各スライドの文字・絵。docx は Word の面から「元に近い見た目で見る」で PDF の面へ、「Word の描き方で見る」で戻る
import { test, expect, type FrameLocator } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";
import { makeJapaneseDocx } from "../docx-fixture.js";
import { makeSlidesPptx } from "../office-fixture.js";

// 初回は道具用のコンテナを作り、LibreOffice 一式（約600MB）を入れる——数分
test.setTimeout(900_000);

const SLIDES = ["一枚目：受信箱の見直し", "二枚目：理由は三つ", "三枚目：やること"];
const DOC = {
  title: "受信箱の見直しについて",
  paragraphs: ["結論を先に書く。理由は三つある。"],
  subtitle: "やること",
  bullets: ["朝に一度だけ開く"],
  table: [
    ["項目", "いま"],
    ["読む回数", "一日二十回"],
  ],
};

async function pageText(view: FrameLocator, n: number): Promise<string> {
  const layer = view.locator(`.pdf-page[data-page="${n}"].rendered .textLayer`);
  await expect(layer, `${n} 枚目の文字の層が出ない`).toBeVisible({ timeout: 60_000 });
  return (await layer.locator("span").allTextContents()).join("").replace(/\s+/g, "");
}

async function inked(view: FrameLocator, n: number): Promise<number> {
  return view.locator(`.pdf-page[data-page="${n}"] canvas`).evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i]! < 128 && data[i + 3]! > 0) dark++;
    return dark;
  });
}

test("AI が見せた pptx をスライドとして読み、docx は「元に近い見た目で見る」で PDF に切り替えて戻れる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fsoffice-"));
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(join(projectRoot, "docs/slides.pptx"), makeSlidesPptx(SLIDES));
  writeFileSync(join(projectRoot, "docs/plan.docx"), makeJapaneseDocx(DOC));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, "E2E FS Office", projectRoot);
  await waitForProjectModule(page, "E2E FS Office", "filesystem");

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("スライドを見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/slides.pptx" } }] }));
  await composer.press("Enter");

  // ---- pptx：document の画面の PDF の面（テキストの画面ではない）。変換を待つ間はそう出る ----------
  await expect(page.locator('[data-testid="inline-module-view"][data-module="filesystem"]')).toBeVisible({ timeout: 120_000 });
  const card = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(card.locator("body")).toHaveAttribute("data-surface", "document", { timeout: 60_000 });
  await expect(card.getByTestId("pdf-view")).toBeVisible();
  await expect(card.getByTestId("docx-view")).toHaveCount(0);
  await expect(card.getByTestId("open-path")).toHaveText("docs/slides.pptx");
  // 変換の途中で出る文は、変換している・入れている・起こしているのどれか（速ければ見えないうちに終わる）
  const converting = await card.getByTestId("pdf-converting").textContent({ timeout: 5_000 }).catch(() => null);
  if (converting !== null) expect(converting).toMatch(/^(LibreOffice で PDF にしています…|変換役を(入れています（初回だけ、数分）|起こしています)。.*)$/);

  // 入れ終わって変換できたら、スライドで数える
  await expect(card.getByTestId("pdf-page-label")).toHaveText("1 / 3 スライド", { timeout: 840_000 });
  await expect(card.getByTestId("pdf-page")).toHaveCount(SLIDES.length);
  await expect(card.getByTestId("pdf-error-state")).toHaveCount(0);
  await expect(card.getByTestId("pdf-converting")).toHaveCount(0);
  // スライドは横長（4:3 で作った）
  const box = await card.locator('.pdf-page[data-page="1"]').boundingBox();
  expect(box!.width / box!.height, "スライドが横長でない（縦のページとして描いている）").toBeGreaterThan(1.2);
  expect(await pageText(card, 1)).toContain(SLIDES[0]!.replace(/\s+/g, ""));
  expect(await inked(card, 1), "1枚目の canvas に何も描かれていない").toBeGreaterThan(50);
  // 探すとそのスライドへ飛ぶ——ほかのスライドの文字も読めている
  const search = card.getByTestId("pdf-search");
  await search.fill("三枚目");
  await search.press("Enter");
  await expect(card.getByTestId("pdf-search-count")).toHaveText("1 / 1 件", { timeout: 60_000 });
  await expect(card.getByTestId("pdf-page-label")).toHaveText("3 / 3 スライド", { timeout: 30_000 });
  expect(await pageText(card, 3)).toContain(SLIDES[2]!.replace(/\s+/g, ""));
  await search.fill("二枚目");
  await search.press("Enter");
  await expect(card.getByTestId("pdf-page-label")).toHaveText("2 / 3 スライド", { timeout: 30_000 });
  expect(await pageText(card, 2)).toContain(SLIDES[1]!.replace(/\s+/g, ""));

  // ---- docx：まず Word の面（docx-preview）。「元に近い見た目で見る」で PDF の面へ ----------------
  await composer.fill("計画の Word を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/plan.docx" } }] }));
  await composer.press("Enter");
  const word = page.frameLocator('[data-testid="module-canvas-frame"] >> nth=-1').frameLocator("iframe");
  await expect(word.getByTestId("docx-view")).toBeVisible({ timeout: 120_000 });
  await expect(word.locator('[data-testid="docx-view"] [data-testid="open-path"]')).toHaveText("docs/plan.docx");
  await expect(word.locator("section.docx article > p").first()).toHaveText(DOC.title, { timeout: 60_000 });
  await expect(word.getByTestId("pdf-view")).toHaveCount(0);

  await word.getByRole("button", { name: "元に近い見た目で見る" }).click();
  await expect(word.getByTestId("pdf-view")).toBeVisible();
  await expect(word.getByTestId("docx-view")).toBeHidden();
  await expect(word.locator('[data-testid="pdf-view"] [data-testid="open-path"]')).toHaveText("docs/plan.docx");
  // 変換役はもう入っている——変換して、ページで数える
  await expect(word.getByTestId("pdf-page-label")).toHaveText("1 / 1 ページ", { timeout: 120_000 });
  await expect(word.getByTestId("pdf-page")).toHaveCount(1);
  const text = await pageText(word, 1);
  for (const s of [DOC.title, DOC.paragraphs[0]!, DOC.subtitle, DOC.bullets[0]!, "読む回数", "一日二十回"]) expect(text, `PDF にした docx に「${s}」が無い`).toContain(s);
  expect(await inked(word, 1)).toBeGreaterThan(50);
  // 押して切り替えたときは、描けなかった理由は出さない
  await expect(word.locator('[data-testid="pdf-view"] > .note')).toBeHidden();

  // ---- 「Word の描き方で見る」で戻る（読み直さず、さっきの面がそのまま出る）------------------------
  await word.getByRole("button", { name: "Word の描き方で見る" }).click();
  await expect(word.getByTestId("docx-view")).toBeVisible();
  await expect(word.getByTestId("pdf-view")).toBeHidden();
  await expect(word.locator("section.docx article > p").first()).toHaveText(DOC.title);
  // もう一度 PDF へ——前に描いたものがそのまま
  await word.getByRole("button", { name: "元に近い見た目で見る" }).click();
  await expect(word.getByTestId("pdf-page-label")).toHaveText("1 / 1 ページ");

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
