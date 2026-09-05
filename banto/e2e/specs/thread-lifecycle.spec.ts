// ステージ1（A8）の回帰。Fork Threadを畳む→履歴に出る→再度開く→
// 会話が読み返せる、をブラウザで一通り確認する。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";

test.describe.configure({ mode: "serial" });

// ≥mdだとBase/Forkが横に重ねて同時描画され、同じaria-labelの要素が
// 複数出てstrict modeに引っかかる（panel-stack.tsx）。<mdなら前面の1枚だけが
// 全画面オーバーレイで出るので、ここではモバイル幅を使う
test.use({ viewport: { width: 390, height: 844 } });

test("Fork Threadを畳む→履歴に出る→再度開く→会話が読み返せる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-lifecycle-"));

  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);

  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Lifecycle Project");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(/Base Thread —/)).toBeVisible({ timeout: 15_000 });

  // 会話を残す（再度開いたときに読み返せることを見るための下準備）。
  // ページ全体からgetByTextで待つと、送信直後に出るユーザー自身の発言
  // エコー（プロンプト文字列そのもの）にもマッチしてしまい、実際のAI応答を
  // 待たずに次の操作（Fork作成等）が走る（実測——Forkの中身がbackend側で
  // まだ空のまま作られていた）。data-role="assistant"のバブルに絞って
  // 返信テキストが出るまで待つことで、ターンが本当に終わったことを見る
  const assistantBubble = page.locator('[data-role="assistant"]');
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("目印として「めじるし123」と1語だけ返してください。");
  await composer.press("Enter");
  await expect(assistantBubble.filter({ hasText: "めじるし123" })).toBeVisible({ timeout: 60_000 });

  // Fork作成
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await expect(page.getByText(/Fork Thread —/)).toBeVisible({ timeout: 15_000 });

  // Fork Thread自身の中でも会話する——畳む直前までの会話が概要（件数）に
  // 反映されるかを見る（指摘・2026-09-04：畳む直前の会話がArchiveの概要で
  // 「0件のやり取り」のまま古くなっていた。realMessagesがFork作成時点で
  // 固定され、以降の会話で更新されていなかったのが原因）
  // Baseパネルの入力欄もDOM上に残ったままなので（panel-stack.tsx、モバイルは
  // overlay方式）、Forkの正確なplaceholderで一意に絞る
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await forkComposer.fill("目印として「フォークめじるし456」と1語だけ返してください。");
  await forkComposer.press("Enter");
  await expect(assistantBubble.filter({ hasText: "フォークめじるし456" })).toBeVisible({ timeout: 60_000 });

  // Fork Threadを畳む
  await page.getByRole("button", { name: "この Fork Thread を畳む" }).click();
  await expect(page.getByText(/Fork Thread —/)).not.toBeVisible();

  // 履歴（Archive）に出る——MobileTopBarとBaseパネルヘッダの両方に「履歴」
  // ボタンがあるので.first()で固定する
  await page.getByRole("button", { name: "履歴" }).first().click();
  await expect(page.getByText("この Project の閉じた Fork Thread")).toBeVisible({ timeout: 10_000 });
  const forkRow = page.getByText(/^Fork \d+$/).first();
  await expect(forkRow).toBeVisible();

  // 概要の会話件数が畳む直前の会話を反映している（0件のまま古くなっていないか）
  await forkRow.click();
  await expect(page.getByText("0件のやり取り")).not.toBeVisible();
  await expect(page.getByText(/[1-9]\d*件のやり取り/)).toBeVisible();

  // 再度開く
  await page.getByRole("button", { name: "再度開く" }).click();

  // Fork Threadが開き、直前の会話（めじるし123）が読み返せる
  await expect(page.getByText(/Fork Thread —/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("めじるし123").first()).toBeVisible({ timeout: 15_000 });
});
