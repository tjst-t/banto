// **停止ボタンは押した瞬間に止まる。AI がまだ何も出していなければ、送った発言は入力欄へ戻る**
// （決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）。
//
// 報告：「プロンプトを入れて、あ、間違った！と停止ボタンを押してもなかなか反応しない」。原因は2つあった：
//   1. 画面は host から次のイベントが届くまで止まらなかった（AI が考えている間は何も届かない）
//   2. host のターンは止まらず最後まで走っていた——停止ボタンは「この画面が読むのをやめる」だけだった
import { test, expect, type Locator, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, openApp, fakeTurn } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ viewport: { width: 1280, height: 800 } });

const PROJECT = `Turn Stop ${Date.now()}`;

function baseComposer(page: Page): Locator {
  return page.getByPlaceholder(/Base Thread に送る$/);
}

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop generating" });
}

/** 1ターン送って、終わるまで待つ */
async function sendAndWait(page: Page, composer: Locator, text: string, expectReply: string | RegExp): Promise<void> {
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: expectReply }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 });
}

/** 押してから、停止ボタンが消える（＝画面が止まった）までの時間 */
async function pressStop(page: Page): Promise<number> {
  await expect(stopButton(page)).toBeVisible({ timeout: 30_000 });
  const at = Date.now();
  await stopButton(page).click();
  await expect(stopButton(page)).toHaveCount(0, { timeout: 10_000 });
  return Date.now() - at;
}

test("AI が何も出していないうちに止めると、すぐ止まり、送った発言が入力欄へ戻る（AI の文脈にも残らない）", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT, mkdtempSync(join(tmpdir(), "banto-e2e-")));
  const composer = baseComposer(page);

  // 1ターン目は最後まで走らせる——2ターン目は「続きのセッション」を止める場面になる
  await sendAndWait(page, composer, `ONE を返して${fakeTurn({ say: "ONE-REPLY" })}`, "ONE-REPLY");

  // AI が 60 秒考える（何も出さない）ターン
  const mistaken = `まちがえた依頼${fakeTurn({ thinkMs: 60_000, say: "NEVER-SAID" })}`;
  await composer.fill(mistaken);
  await composer.press("Enter");
  await expect(page.locator('[data-role="user"]').filter({ hasText: "まちがえた依頼" })).toBeVisible({ timeout: 10_000 });
  // host が走らせ始めるのを待つ（送り出す前に止める場面は、別の道で取り消す）
  await page.waitForTimeout(1_500);

  const stoppedIn = await pressStop(page);
  expect(stoppedIn, `停止ボタンを押してから止まるまで ${stoppedIn}ms かかった`).toBeLessThan(1_500);

  // **送る前の状態に戻る**：入力欄に発言が戻り、会話からは消える
  await expect(composer).toHaveValue(mistaken, { timeout: 10_000 });
  await expect(composer).toBeFocused();
  await expect(page.locator('[data-role="user"]').filter({ hasText: "まちがえた依頼" })).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("NEVER-SAID")).toHaveCount(0);

  // host の記録からも消えている（読み込み直しても出ない）
  await page.reload();
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "ONE-REPLY" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-role="user"]').filter({ hasText: "まちがえた依頼" })).toHaveCount(0);

  // **次のターンは、取り消した発言の手前で切って続ける**（AI の文脈にも残さない）。止めたターンはもう走っていない
  // ——すぐ次を送れて、返事が来る
  await composer.fill(`続けて${fakeTurn({ saySession: true })}`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: /resume=\S+ at=fake-uuid-\d+/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 });

  // その次のターンは、もう切らない
  await composer.fill(`もう一度${fakeTurn({ saySession: true })}`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: /resume=\S+ at=\(無し\)/ })).toBeVisible({
    timeout: 30_000,
  });
});

test("AI が書き始めてから止めると、すぐ止まり、出た分が「ここで止めました」と一緒に残る", async ({ page }) => {
  await openApp(page);
  await createProject(page, `${PROJECT} 2`, mkdtempSync(join(tmpdir(), "banto-e2e-")));
  const composer = baseComposer(page);

  const lines = Array.from({ length: 60 }, (_, i) => `[L${i + 1}]`);
  await composer.fill(`長い話をして${fakeTurn({ say: lines.join("\n"), streamMs: 30_000 })}`);
  await composer.press("Enter");
  await expect(page.getByText("[L3]")).toBeVisible({ timeout: 30_000 });

  const stoppedIn = await pressStop(page);
  expect(stoppedIn, `停止ボタンを押してから止まるまで ${stoppedIn}ms かかった`).toBeLessThan(1_500);

  // 発言は戻さない（AI がもう書き始めていた）——入力欄は空のまま、会話に残る
  await expect(composer).toHaveValue("");
  await expect(page.locator('[data-role="user"]').filter({ hasText: "長い話をして" })).toBeVisible();
  // host も止まった：出た分が「ここで止めました」と一緒に記録に残り、続きは流れない
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "（ここで止めました）" })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(2_000);
  await expect(page.getByText("[L60]")).toHaveCount(0);

  // すぐ次を送れる（前のターンを待たされない）
  await sendAndWait(page, composer, `TWO を返して${fakeTurn({ say: "TWO-REPLY" })}`, "TWO-REPLY");
});
