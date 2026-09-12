// ステージ1（A8）の回帰。Fork Threadを畳む→履歴に出る→再度開く→
// 会話が読み返せる、をブラウザで一通り確認する。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, openNav } from "../helpers.js";

test.describe.configure({ mode: "serial" });

// ≥mdだとBase/Forkが横に重ねて同時描画され、同じaria-labelの要素が
// 複数出てstrict modeに引っかかる（panel-stack.tsx）。<mdなら前面の1枚だけが
// 全画面オーバーレイで出るので、ここではモバイル幅を使う
test.use({ viewport: { width: 390, height: 844 } });

test("Fork Threadを畳む→履歴に出る→再度開く→会話が読み返せる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-lifecycle-"));

  await openApp(page);

  await createProject(page, "E2E Lifecycle Project", projectRoot);

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

  // Fork作成。**開いた印はヘッダの「戻る」**——題は Fork の名前だけになり
  // 「Fork Thread —」の接頭辞は付かない（改訂・2026-09-09）
  const forkPanelBack = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await expect(forkPanelBack).toBeVisible({ timeout: 15_000 });

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
  await page.getByRole("button", { name: "この Fork Thread を Close" }).click();
  await expect(forkPanelBack).not.toBeVisible();

  // 履歴（Archive）に出る。**入口は幅で変わる**（改訂・2026-09-09）——
  // モバイルはナビの Drawer の中、デスクトップはサイドバーとBaseパネルヘッダの
  // 両方にあるので .first() で固定する
  await openNav(page);
  // **名前は exact で取る**——部分一致だと、別の spec が作った Project 名
  // （「…履歴…」）にも当たってしまう（実測・2026-09-12）
  await page.getByRole("button", { name: "履歴", exact: true }).first().click();
  // **既定は Fork のタブ**（改訂・2026-09-12、§6.20——見出しは検索のときだけ出る）
  await expect(page.getByTestId("archive-tab-forks"), "Fork のタブが選ばれていない").toHaveAttribute(
    "data-state",
    "active",
    { timeout: 10_000 },
  );
  const forkRow = page.getByText(/^Fork \d+$/).first();
  await expect(forkRow).toBeVisible();

  // 概要の会話件数が畳む直前の会話を反映している（0件のまま古くなっていないか）
  await forkRow.click();
  await expect(page.getByText("0件のやり取り")).not.toBeVisible();
  await expect(page.getByText(/[1-9]\d*件のやり取り/)).toBeVisible();

  // 再度開く
  await page.getByRole("button", { name: "再度開く" }).click();

  // Fork Threadが開き、**その Fork でした会話**が読み返せる。
  //
  // **前面の1枚の中だけを見る**（改訂・2026-09-10、規則14）。以前は画面全体から
  // 「めじるし123」——**Base でした会話**——を探していた。Fork は Base の上に
  // 重なるオーバーレイで、`toBeVisible` は覆いを見ないので、**再度開いた Fork が
  // 空でも背面の Base の文字に当たって通っていた**（規則14 の由来になった穴と同型）。
  // 見るのは Fork でしか出ない語（フォークめじるし456）と、前面の1枚に限った探索。
  await expect(forkPanelBack).toBeVisible({ timeout: 15_000 });
  const forkPanel = page.locator('[data-testid="panel-overlay"][data-layer="fork"]');
  await expect(forkPanel, "Fork のパネルが前面に出ていない").toBeVisible({ timeout: 15_000 });
  await expect(
    forkPanel.getByText("フォークめじるし456").first(),
    "再度開いた Fork に、その Fork でした会話が戻っていない",
  ).toBeVisible({ timeout: 15_000 });
});
