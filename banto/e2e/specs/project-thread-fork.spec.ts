// 既存機能の回帰スイート（ステージ0時点の状態を固定する）。
// Project作成・Base Thread会話・Fork作成・履歴復元・Clearが壊れていないかだけを見る
// ——AIの返信内容そのものは検証しない（非決定的、真実は一箇所の対象外）。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });

// ≥md（デスクトップ幅）だとBase/Fork/Canvasが横に重ねて同時描画され、
// 同じaria-labelの要素が複数出てstrict modeに引っかかる（panel-stack.tsx）。
// <mdなら前面の1枚だけが全画面オーバーレイで出るので、ここではモバイル幅を使う
test.use({ viewport: { width: 390, height: 844 } });

test("Project作成→Base Thread会話→Fork作成→Clear", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-"));

  await openApp(page);

  // Project作成——**Project名まで見て**その Project が開いたことを待つ（規則14）。
  // 「Base Thread —」だけで待つと、**別のProjectのBase Thread**にも一致して
  // しまい、新Projectへの遷移を待たずに次の操作へ進んで前のProjectのcomposerに
  // 入力してしまう（実測・2026-09-05）。手順は helpers.ts に1つだけ持つ
  await createProject(page, "E2E Test Project", projectRoot);

  // 会話（実Agent SDKを叩く）。ページ全体からgetByTextで待つと、送信直後に
  // 出るユーザー自身の発言エコー（プロンプト文字列そのもの）にもマッチして
  // しまい、実際のAI応答を待たずにFork作成が走る（実測——Forkの中身が
  // backend側でまだ空のまま作られていた）。data-role="assistant"のバブルに
  // 絞って、固定文言の返信が出るまで待つ
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("目印として「あいさつ完了789」と1語だけ返してください。");
  await composer.press("Enter");
  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: "あいさつ完了789" }),
  ).toBeVisible({ timeout: 60_000 });

  // Fork作成。**開いた印はヘッダの「戻る」**——題は Fork の名前だけになり
  // 「Fork Thread —」の接頭辞は付かない（改訂・2026-09-09、狭い幅で題が
  // 押し出されるのをやめ、種別はアイコンで示す）
  const forkPanelBack = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await expect(forkPanelBack).toBeVisible({ timeout: 15_000 });

  // **分けた場所に「この Fork を開く」が残る**（決定・2026-09-07、ユーザー要望）。
  // Fork は横のレールからも開けるが、**会話のどこで分けたのか**はそこからは
  // 分からない。閉じてから、会話に残ったカードで開き直せることまで見る
  await forkPanelBack.click();
  await expect(forkPanelBack).toBeHidden({ timeout: 15_000 });
  const forkCard = page.locator('[data-testid="fork-open-card"]');
  await expect(forkCard, "分岐した場所に Fork の入口が残っていない").toBeVisible({ timeout: 15_000 });
  // リロードしても残る（記録から出している——このブラウザの覚えではない）
  await page.reload();
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 30_000 });
  await expect(forkCard, "リロードで Fork の入口が消えた").toBeVisible({ timeout: 30_000 });
  await forkCard.getByRole("button", { name: "開く" }).click();
  await expect(forkPanelBack, "カードから Fork を開けない").toBeVisible({ timeout: 15_000 });

  // Clear（Fork側）——モバイル幅ではBaseパネルもDOM上に残ったまま
  // Fork がoverlayとして重なる（panel-stack.tsx）ので、同じaria-labelが
  // 2つ存在する。overlayはDOM順で後に来るので.last()で前面の1枚を選ぶ
  await page.getByRole("button", { name: "Thread の操作" }).last().click();
  await page.getByRole("menuitem", { name: "Clear" }).click();
  await expect(page.getByText("Clear").first()).toBeVisible({ timeout: 15_000 });
});
