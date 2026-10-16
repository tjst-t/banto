// PDF の文字を**人と同じマウスのドラッグで**選ぶ（追加・2026-10-16、ユーザー報告「選ぶのがまず全然うまく動かない」）。
//
// 文字の層の span は位置を指定して置くので、余白や行間（span の無い所）にマウスが出ると、何もしなければブラウザは選択の端を
// 層の先頭や末尾に跳ばす——行の右へ出ただけで下の段落まで全部選ばれていた。pdf.js 本家のビューアと同じ「終わり」の div で
// 防ぐ（`ui/text-selection.ts`）。これまでの試験は範囲をプログラムで作っていて、ドラッグを一度も試していなかった。

import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, fakeTurn, openApp, waitForProjectModule, waitTurnEnded } from "../helpers.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { makeJapanesePdf } from "../pdf-fixture.js";

test.setTimeout(240_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E PDF Select";
const LINES = ["第1章 受信箱の見直し", "一行目：結論を先に書く", "二行目：理由をあとに書く", "三行目：図の凡例を直す", "四行目：まとめ"];

async function baseThreadId(page: Page): Promise<string> {
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json();
  return threads[0].id;
}

function card(page: Page): FrameLocator {
  return page.locator('[data-testid="inline-module-view"][data-module="filesystem"]').frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
}

/** その行の span（文字の層の中で、その文字列で始まるもの） */
async function lineBox(view: FrameLocator, text: string) {
  const span = view.locator('.pdf-page[data-page="1"] .textLayer span').filter({ hasText: text }).first();
  return (await span.boundingBox())!;
}

async function selection(view: FrameLocator): Promise<string> {
  return view.locator("body").evaluate(() => window.getSelection()?.toString() ?? "");
}

/**
 * 押して、途中の点を通って、離す（人のドラッグと同じく少しずつ動かす）。前に選んだ文字の上から押すとブラウザはその文字を
 * 引きずって運ぶ動き（drag and drop）にするので、始める前に選択を外す
 */
async function drag(page: Page, view: FrameLocator, points: Array<[number, number]>): Promise<void> {
  await view.locator("body").evaluate(() => window.getSelection()?.removeAllRanges());
  const [first, ...rest] = points;
  await page.mouse.move(first![0], first![1]);
  await page.mouse.down();
  for (const [x, y] of rest) {
    await page.mouse.move(x, y, { steps: 6 });
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
}

test("PDF の文字をドラッグで選ぶと、余白や行間を通っても選んだ所までで止まり、そのままコメントの引用になる", async ({ page }) => {
  // 会話の中のカード（ページの枠は 520px）が画面に収まる高さにする——ドラッグする点が画面の外だと届かない
  await page.setViewportSize({ width: 1280, height: 1400 });
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-pdfselect-"));
  mkdirSync(join(projectRoot, "docs"));
  writeFileSync(join(projectRoot, "docs/plan.pdf"), makeJapanesePdf([LINES, ["第2章", "次のページ"]]));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "filesystem");
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "showFile", args: { path: "docs/plan.pdf" } }] }));
  await composer.press("Enter");
  await waitTurnEnded(page, await baseThreadId(page), 1, 120_000);

  const view = card(page);
  await expect(view.locator('.pdf-page[data-page="1"].rendered .textLayer span').first()).toBeVisible({ timeout: 60_000 });
  await expect(view.locator('.pdf-page[data-page="1"] .textLayer .endOfContent')).toHaveCount(1);

  const l1 = await lineBox(view, "一行目");
  const l2 = await lineBox(view, "二行目");
  const pageBox = (await view.locator('.pdf-page[data-page="1"]').boundingBox())!;
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;

  // ---- 1. 行の途中から右の余白へ出る：その行の残りだけ（下の行に跳ばない）-----------------------------------------
  await drag(page, view, [
    [l1.x + l1.width * 0.45, mid(l1)],
    [l1.x + l1.width + 40, mid(l1)],
    [pageBox.x + pageBox.width - 20, mid(l1)],
  ]);
  const toMargin = await selection(view);
  expect(toMargin.length, `余白へ出たら下まで選ばれた：${JSON.stringify(toMargin)}`).toBeLessThan(LINES[1]!.length);
  expect(LINES[1]!.endsWith(toMargin.trim()), JSON.stringify(toMargin)).toBe(true);
  expect(toMargin).not.toContain("二行目");

  // ---- 2. 行の途中から行間を通って次の行の途中まで：2行の間だけ ----------------------------------------------------
  await drag(page, view, [
    [l1.x + l1.width * 0.45, mid(l1)],
    [l1.x + l1.width * 0.5, l1.y + l1.height + (l2.y - l1.y - l1.height) / 2],
    [l2.x + l2.width * 0.5, mid(l2)],
  ]);
  const across = (await selection(view)).replace(/\s/g, "");
  expect(across, JSON.stringify(across)).toContain("先に書く");
  expect(across).toContain("二行目");
  expect(across).not.toContain("三行目");
  expect(across).not.toContain("第1章");

  // ---- 3. 会話の中のカードはコメントモードが既定でオフ：選んでも「コメント」は出ず、コピーできるだけ ------------------
  await expect(view.getByTestId("comments-toggle")).toHaveAttribute("aria-pressed", "false");
  await drag(page, view, [
    [l2.x + 1, mid(l2)],
    [l2.x + l2.width + 30, mid(l2)],
  ]);
  expect((await selection(view)).replace(/\s/g, "")).toBe(LINES[2]!.replace(/\s/g, ""));
  await page.waitForTimeout(300);
  await expect(view.getByTestId("comment-chip")).toBeHidden();
  await expect(view.getByTestId("comment-for-page")).toHaveCount(2);
  await expect(view.getByTestId("comment-for-page").first()).toBeHidden();
  await expect(view.getByTestId("comment-margin")).toBeHidden();

  // ---- 4. コメントモードに入ると、選び終えた横に「コメント」が出て、押すと選んだ文がそのまま引用になる -------------------
  await view.getByTestId("comments-toggle").click();
  await expect(view.getByTestId("comments-toggle")).toHaveAttribute("aria-pressed", "true");
  await drag(page, view, [
    [l2.x + 1, mid(l2)],
    [l2.x + l2.width + 30, mid(l2)],
  ]);
  expect((await selection(view)).replace(/\s/g, "")).toBe(LINES[2]!.replace(/\s/g, ""));
  const chip = view.getByTestId("comment-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("コメント");
  // 選んだ所の右上（行の右端の近く、行より上）に出る
  const chipBox = (await chip.boundingBox())!;
  expect(chipBox.x, "「コメント」が選んだ行の右に出ていない").toBeGreaterThan(l2.x + l2.width * 0.5);
  expect(chipBox.y + chipBox.height, "「コメント」が選んだ行の上に出ていない").toBeLessThanOrEqual(mid(l2) + 2);
  await chip.click();
  await expect(view.getByTestId("comment-draft-anchor")).toHaveText(`1ページ「${LINES[2]}」`);
  await expect(chip).toBeHidden();
  // 書いている対象の印（蛍光ペン）が選んだ行に出る
  const draftMark = view.locator('.pdf-page[data-page="1"] [data-testid="comment-mark"][data-kind="text"][data-state="draft"]');
  await expect(draftMark.first()).toBeVisible();
  const markBox = (await draftMark.first().boundingBox())!;
  expect(Math.abs(markBox.y - l2.y), "印が選んだ行の高さに無い").toBeLessThan(l2.height);

  // ---- 5. 離したら「終わり」は元に戻る（次のドラッグや範囲を囲むのを邪魔しない）--------------------------------------
  await expect(view.locator('.pdf-page[data-page="1"] .textLayer.selecting')).toHaveCount(0);
});
