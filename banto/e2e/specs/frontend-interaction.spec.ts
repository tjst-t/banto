// レビューで「要確認」のまま残っていた動作依存の指摘を、実ブラウザで確かめて
// 直したぶんの回帰試験（`frontend-interaction-hardening`、2026-09-10。指摘は
// `docs/notes/2026-09-09-repo-review.md` §3.2）。
//
// 実測の結果と、直さなかったものの記録は
// `docs/notes/2026-09-10-frontend-interaction-hardening.md`。
// 4件目（同じ SSE を2つの run が食い合う）は単体試験で見る
// （`banto/apps/frontend/lib/backend/live-turn-guard.test.ts`）。

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, confirmForkDialog } from "../helpers.js";

test.setTimeout(300_000);

test("Escape は前面の1枚だけを閉じる——背面のパネルは巻き添えにしない", async ({ page }) => {
  await openApp(page);
  await createProject(page, "Escape の spec", mkdtempSync(join(tmpdir(), "banto-e2e-esc-")));

  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  await expect(back).toBeVisible({ timeout: 15_000 });

  // 前面に Command Palette（Radix の dialog）を開く
  await page.keyboard.press("Control+k");
  const dialog = page.locator('[role="dialog"][data-state="open"]');
  await expect(dialog.first()).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Escape");
  // 閉じるのは前面だけ。**実測（直す前）：前面は開いたまま、背面の Fork が閉じた**
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  await expect(back, "Escape で背面の Fork まで閉じた").toBeVisible();

  // **Ctrl-K をもう一度押すと閉じる**（決定・2026-09-30、ユーザー要望）。閉じたときの検索語は残さず、背面の Fork は閉じない
  await page.keyboard.press("Control+k");
  await expect(dialog.first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type("検索語");
  await page.keyboard.press("Control+k");
  await expect(dialog, "Ctrl-K をもう一度押しても閉じない").toHaveCount(0, { timeout: 10_000 });
  await expect(back, "Ctrl-K で閉じたら背面の Fork まで閉じた").toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.locator("[cmdk-input]"), "閉じたときの検索語が残っている").toHaveValue("", { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  // パレットは閉じても消える動き（100ms）の間は画面に残り、入力欄が焦点を持ったまま——その間の Escape は
  // パレットの側が受け取る（実測・2026-10-03：data-state=closed の中身に焦点があり、Escape は defaultPrevented で届いた）。
  // 人が2回目を押すのは消えたあとなので、消えるのを待ってから押す
  await expect(page.locator('[data-slot="dialog-content"]'), "閉じたパレットが画面から消えない").toHaveCount(0, {
    timeout: 10_000,
  });

  // もう一度押せば、こんどは Fork が閉じる（前面がもう無いので）
  await page.keyboard.press("Escape");
  await expect(back).toBeHidden({ timeout: 10_000 });
});

test("実 Thread には、やり直し（Edit・Reload・分岐）を出さない", async ({ page }) => {
  await openApp(page);
  await createProject(page, "やり直しの spec", mkdtempSync(join(tmpdir(), "banto-e2e-branch-")));

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("「印123」とだけ返して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "印123" })).toBeVisible({
    timeout: 90_000,
  });
  // **ターンが終わってから見る**——走行中は操作の帯そのものが出ない（hideWhenRunning）
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden({ timeout: 90_000 });

  await page.locator('[data-role="user"]').last().hover();
  await expect(
    page.locator(".aui-user-action-edit"),
    "実 Thread に Edit が出ている（host は分岐を持たないので、押すと直列に追記される）",
  ).toHaveCount(0);

  await page.locator('[data-role="assistant"]').last().hover();
  // 帯そのものは出ている（Copy がある）——「帯ごと消えた」ではないことを示す
  await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Refresh" }), "実 Thread に Reload が出ている").toHaveCount(0);
  await expect(page.locator(".aui-branch-picker-root")).toHaveCount(0);
});

test("Canvas の橋は、親が何度再描画されても張り直さない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-bridge-"));
  const marker = `bridge-marker-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, marker), "見えているはず\n");

  await openApp(page);
  await createProject(page, "橋の spec", projectRoot);
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("この Project の直下の一覧を取ってください。" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }] }));
  await composer.press("Enter");
  // **自分のカードを名指しで押す**（改訂・2026-09-21）。同じ host を他の spec と
  // 共有していて、**答え待ちのカードが複数並ぶことがある**——名前で引くと
  // 別のターンのカードを許可してしまい、こちらは待ち続ける（実際に、まとめて
  // 走らせたときだけ落ちた）
  const myCard = page
    .locator('[data-role="judgment-card"]')
    .filter({ hasText: "mcp__filesystem__listDirectory" })
    .last();
  await expect(myCard).toBeVisible({ timeout: 90_000 });
  await myCard.getByRole("button", { name: "許可する" }).click();

  const embed = page.locator('[data-testid="inline-module-view"]');
  await expect(embed).toBeVisible({ timeout: 120_000 });
  const frame = page.locator('[data-testid="module-canvas-frame"]');
  const inner = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(inner.getByText(marker)).toBeVisible({ timeout: 60_000 });
  await expect(frame).toHaveAttribute("data-bridge-generation", "1");

  // ターンが終わるまで待つ（流れている間じゅう会話は描き直される）
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === "橋の spec");
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()
  )[0].id;
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json())
            .messages ?? []
        ).filter((m: { role: string }) => m.role === "assistant").length,
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);

  // 親（project-panels → ThreadPanel）を何度も描き直させる。
  // **Fork は親の履歴をそのまま持つ**ので、同じ toolCallId の画面が Fork にも出る
  // ——直す前は、これで Base の画面が「Fork のもの」に化けて橋が張り直されていた
  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "Fork を開く" }).click();
    await confirmForkDialog(page);
    await expect(back).toBeVisible({ timeout: 15_000 });
    await back.click();
    await expect(back).toBeHidden({ timeout: 15_000 });
  }

  // **張り直していない**（実測・直す前：Canvas を1つ出して Fork を2回開閉すると 9 回）
  await expect(frame, "親の再描画で橋を張り直している").toHaveAttribute("data-bridge-generation", "1");
  // 張り直していないだけでなく、まだ効いている（画面から tool を呼べる）
  await inner.getByRole("button", { name: "この場所を読み直す" }).click({ timeout: 15_000 });
  await expect(inner.getByText(marker)).toBeVisible({ timeout: 30_000 });
});
