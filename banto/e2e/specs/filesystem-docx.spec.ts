// **Word（docx）を元の見た目で読む**（v4-modules.md §2.2「PDF・Office…」、Backlog #303、2026-10-15）。
//
// AI の showFile が docx を指すと、host は PDF と同じ画面（`ui://banto-filesystem/document`）を選び、画面は docx-preview で描く。
// 規則14——「開けた」で終わらせず、画面が出している中身を一つずつ見る：見出しのパス・見出し（の大きさ）・本文・箇条書き
// （の印）・表の各セル・大きく開いた画面の中身。描けない docx は理由を出す（docx ではないものは変換役にも渡さない）。
// 「元に近い見た目で見る」で PDF に切り替えるのは `filesystem-office-pdf.spec.ts`
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";
import { makeJapaneseDocx } from "../docx-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const DOC = {
  title: "受信箱の見直しについて",
  paragraphs: ["結論を先に書く。理由は三つある。", "二つ目の段落：返事の要らない知らせは、まとめて読む。"],
  subtitle: "やること",
  bullets: ["朝に一度だけ開く", "返事は三行以内", "迷ったら人に聞く"],
  table: [
    ["項目", "いま", "これから"],
    ["読む回数", "一日二十回", "一日三回"],
    ["返事の長さ", "長い", "三行"],
  ],
};

/** 大きく開いた Word の画面（会話の隣）。枠がいくつあっても、Word が出ている最後の枠を選ぶ */
async function fullscreenDocx(page: Page): Promise<FrameLocator> {
  const frames = page.locator('[data-testid="module-canvas-frame"]');
  let index = -1;
  await expect(async () => {
    const count = await frames.count();
    for (let i = count - 1; i >= 0; i -= 1) {
      const inner = frames.nth(i).contentFrame().frameLocator("iframe");
      const mode = await inner.locator("body").getAttribute("data-mode", { timeout: 1_000 }).catch(() => null);
      if (mode === "fullscreen" && (await inner.getByTestId("docx-view").isVisible().catch(() => false))) {
        index = i;
        return;
      }
    }
    throw new Error(`大きく開いた Word の画面が無い（枠は ${count} 個）`);
  }).toPass({ timeout: 60_000 });
  return frames.nth(index).contentFrame().frameLocator("iframe");
}

/** 描いた文書の中身を、画面に出ている形で一つずつ見る */
async function expectDocument(view: FrameLocator): Promise<void> {
  const body = view.getByTestId("docx-body");
  const article = body.locator("section.docx article");
  await expect(article, "docx-preview の本文（section.docx の article）が出ない").toBeVisible({ timeout: 60_000 });

  // 段落は書いた順に、書いた文字のまま
  const paragraphs = article.locator(":scope > p");
  await expect(paragraphs).toHaveText([DOC.title, ...DOC.paragraphs, DOC.subtitle, ...DOC.bullets, "以上。"]);

  // 見出しは見出しの書式（太字・本文より大きい）
  const size = (i: number) => paragraphs.nth(i).locator("span").first().evaluate((s) => parseFloat(getComputedStyle(s).fontSize));
  const weight = (i: number) => paragraphs.nth(i).locator("span").first().evaluate((s) => getComputedStyle(s).fontWeight);
  const bodySize = await size(1);
  expect(await size(0), "見出し1 が本文より大きくない").toBeGreaterThan(bodySize * 1.5);
  expect(await size(3), "見出し2 が本文より大きくない").toBeGreaterThan(bodySize * 1.2);
  expect(await weight(0)).toBe("700");
  expect(await weight(3)).toBe("700");

  // 箇条書きは印（•）つきで、字下げされている
  for (let i = 4; i < 4 + DOC.bullets.length; i++) {
    const marker = await paragraphs.nth(i).evaluate((p) => getComputedStyle(p, "::before").content);
    expect(marker, `箇条書き ${DOC.bullets[i - 4]} に印が無い`).toContain("•");
  }
  const indent = await paragraphs.nth(4).evaluate((p) => p.getBoundingClientRect().left - p.parentElement!.getBoundingClientRect().left);
  expect(indent, "箇条書きが字下げされていない").toBeGreaterThan(10);

  // 表は行・セルが書いた通り。枠線がある
  const rows = article.locator("table tr");
  await expect(rows).toHaveCount(DOC.table.length);
  for (const [r, cells] of DOC.table.entries()) await expect(rows.nth(r).locator("td")).toHaveText(cells);
  const borderTop = await rows.nth(0).locator("td").first().evaluate((td) => getComputedStyle(td).borderTopStyle);
  expect(borderTop).toBe("solid");
}

test("AI が見せた日本語の docx（見出し・表・箇条書き）を会話の中で読み、大きく開いても読める", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fsdocx-"));
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(join(projectRoot, "docs/plan.docx"), makeJapaneseDocx(DOC));
  writeFileSync(join(projectRoot, "docs/broken.docx"), Buffer.from("これは docx ではない"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, "E2E FS DOCX", projectRoot);
  await waitForProjectModule(page, "E2E FS DOCX", "filesystem");

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("計画の Word を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/plan.docx" } }] }));
  await composer.press("Enter");

  // ---- 会話の中：document の画面の Word の面（テキストの画面でも PDF の面でもない）---------------
  const embed = page.locator('[data-testid="inline-module-view"][data-module="filesystem"]');
  await expect(embed).toBeVisible({ timeout: 120_000 });
  const card = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(card.locator("body")).toHaveAttribute("data-surface", "document", { timeout: 60_000 });
  await expect(card.getByTestId("docx-view")).toBeVisible();
  await expect(card.getByTestId("pdf-view")).toHaveCount(0);
  await expect(card.getByTestId("open-path")).toHaveText("docs/plan.docx");
  await expect(card.getByRole("button", { name: "大きく表示" })).toBeVisible();
  // 変換役で PDF にする口（押したときの中身は filesystem-office-pdf.spec.ts）
  await expect(card.getByRole("button", { name: "元に近い見た目で見る" })).toBeVisible();
  await expectDocument(card);
  await expect(card.getByTestId("docx-error-state")).toHaveCount(0);
  // ページの幅は会話の中のカードに収まる（横にはみ出さない）。左端も見る——ページは中央寄せなので、縮め足りないと
  // 左にもはみ出し、そちらは scrollWidth に載らない（負の位置はスクロールで届かない）
  const fit = await card.getByTestId("docx-scroller").evaluate((s) => {
    const page = s.querySelector("section.docx")!.getBoundingClientRect();
    const box = s.getBoundingClientRect();
    return { overflow: s.scrollWidth - s.clientWidth, left: page.left - box.left, right: box.left + s.clientWidth - page.right };
  });
  expect(fit.overflow, "Word のページがカードから横にはみ出している").toBeLessThanOrEqual(1);
  expect(fit.left, "Word のページの左端が切れている").toBeGreaterThanOrEqual(0);
  expect(fit.right, "Word のページの右端が切れている").toBeGreaterThanOrEqual(0);
  // 本文の文字を選べる
  const selected = await card.locator("section.docx article > p").nth(1).evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selected).toBe(DOC.paragraphs[0]);

  // ---- 大きく開く：同じ文書が画面いっぱいに出る ---------------------------------------
  await card.getByRole("button", { name: "大きく表示" }).click();
  await expect(page.getByText(/^Canvas — filesystem$/)).toBeVisible({ timeout: 30_000 });
  const full = await fullscreenDocx(page);
  await expect(full.getByTestId("open-path")).toHaveText("docs/plan.docx");
  await expect(full.getByRole("button", { name: "大きく表示" })).toBeHidden();
  await expectDocument(full);

  // ---- 描けない docx は理由を出す（白い画面のままにしない）--------------------------------
  await page.getByRole("button", { name: "閉じる" }).first().click().catch(() => undefined);
  await composer.fill("壊れた Word を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/broken.docx" } }] }));
  await composer.press("Enter");
  const cards = page.frameLocator('[data-testid="module-canvas-frame"] >> nth=-1').frameLocator("iframe");
  await expect(cards.getByTestId("open-path")).toHaveText("docs/broken.docx", { timeout: 120_000 });
  await expect(cards.getByTestId("docx-error")).toHaveText("Word 文書を描けませんでした：docx として読めませんでした（壊れているか、docx ではありません）", { timeout: 60_000 });
  await expect(cards.locator("section.docx")).toHaveCount(0);
  // zip ですらないものは変換役に渡さない（LibreOffice は中身で形を当て、別の物として PDF にしてしまう）
  await expect(cards.getByTestId("pdf-view")).toHaveCount(0);

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
