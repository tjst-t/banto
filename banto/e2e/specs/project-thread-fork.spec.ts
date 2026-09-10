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

  // **ターンが終わるまで待ってから分ける**（追加・2026-09-10）。返事のバブルは
  // 流れている途中で出るので、ここで分けると**まだ resume-point が立っていない**
  // 親から分岐することがある（この spec 自身が上で心配している「中身が空のまま
  // 作られる」の、backend 側の姿）。host の記録で区切る
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === "E2E Test Project");
  const baseThreadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()
  )[0].id;
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`${CORE_BASE_URL}/api/threads/${baseThreadId}`, { headers })
          ).json()) as { resumePoint?: string }
        ).resumePoint,
      { timeout: 60_000, message: "1ターン目が終わって resume-point が立つまで" },
    )
    .toBeTruthy();

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
  //
  // **「Clear という文字が見えている」で終わらせない**（改訂・2026-09-10、規則14）。
  // 以前は `getByText("Clear").first()` を見ていたが、これは**いま押したメニュー項目の
  // 文字**にも当たる——Clear が何もしなくても通ってしまっていた。見るのは
  // ①会話に横線が入ったこと ②host 側で resume-point が切れたこと（次のターンが
  // 新しいセッションで始まる、アーキ仕様 §2.2）の2つ。
  const threads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })
  ).json();
  const fork = threads.find((t: { kind: string }) => t.kind === "fork");
  const forkState = async () =>
    (await (
      await page.request.get(`${CORE_BASE_URL}/api/threads/${fork.id}`, { headers })
    ).json()) as { resumePoint?: string; markers?: { kind: string }[] };

  // Clear の前：親から借りた resume-point を持っている（＝切るものがある）
  expect((await forkState()).resumePoint, "Clear する前から resume-point が無い（試験が壊れている）").toBeTruthy();

  await page.getByRole("button", { name: "Thread の操作" }).last().click();
  await page.getByRole("menuitem", { name: "Clear" }).click();

  // ① 会話に Clear の横線が入る（メニューの文字ではなく、印そのものを指す）
  const overlay = page.locator('[data-testid="panel-overlay"][data-layer="fork"]');
  await expect(
    overlay.locator('[data-testid="thread-marker"][data-kind="clear"]'),
    "Clear の横線が会話に出ていない",
  ).toBeVisible({ timeout: 15_000 });

  // ② host 側で本当に切れた
  await expect
    .poll(async () => (await forkState()).resumePoint, { timeout: 15_000, message: "resume-point が切れていない" })
    .toBeUndefined();
  expect(
    (await forkState()).markers?.some((m) => m.kind === "clear"),
    "Clear が記録に残っていない",
  ).toBe(true);
});
