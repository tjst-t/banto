// サイドバー（決定・2026-09-09、ユーザー指摘「幅が狭くてアイコンしか出ないので
// Project 名が読めない」）の回帰。**デスクトップ幅**で、
//   - Project 名が読めること
//   - その下に Thread の目次（Base Thread ＋ 開いている Fork）が並ぶこと
//   - 目次から Base ⇄ Fork を行き来できること
//   - 畳む／開くが効き、**別のルートへ移っても畳んだままである**こと
// を見る。Base/Fork が横に並ぶ幅なので、同じ名前の要素が複数出る
// （panel-stack.tsx）——探すときは必ずサイドバーの中に絞る。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, expectProjectOpen, openApp, openNav, openProjectSettings } from "../helpers.js";
import type { Locator } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const PROJECT_NAME = "E2E Sidebar Project";

/** 幅は200msかけて変わる（transition-[width]）——止まるまで待ってから測る
 *  （待ち時間を決め打ちしない、規則6） */
async function expectSidebarWidth(sidebar: Locator, expected: number): Promise<void> {
  await expect
    .poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0), { timeout: 5_000 })
    .toBe(expected);
}

test("サイドバー：Project 名と Thread の目次が読めて、畳んだ状態が残る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-"));

  await openApp(page);

  await createProject(page, PROJECT_NAME, projectRoot);

  const sidebar = page.locator('[data-slot="sidebar-container"]');

  // ---- 名前が読める（アイコンだけではない）--------------------------------
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByRole("link", { name: "Base Thread" })).toBeVisible();
  await expectSidebarWidth(sidebar, 256);

  // ---- Fork を作ると、目次に並ぶ ------------------------------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  const forkRow = sidebar.getByRole("link", { name: "Fork 1" });
  await expect(forkRow, "目次に Fork が出ていない").toBeVisible({ timeout: 15_000 });
  // いま開いている行が選択中として出る（どこにいるかが目次で分かる）
  await expect(forkRow).toHaveAttribute("data-active", "true");
  await expect(sidebar.getByRole("link", { name: "Base Thread" })).toHaveAttribute(
    "data-active",
    "false",
  );

  // ---- 目次から Base Thread へ戻れる --------------------------------------
  await sidebar.getByRole("link", { name: "Base Thread" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+$/, { timeout: 15_000 });
  await expect(sidebar.getByRole("link", { name: "Base Thread" })).toHaveAttribute(
    "data-active",
    "true",
  );

  // ---- 畳む／開く ---------------------------------------------------------
  await sidebar.getByRole("button", { name: "サイドバーを折りたたむ" }).click();
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeHidden({ timeout: 5_000 });
  await expectSidebarWidth(sidebar, 58);

  // **別のルートへ移っても畳んだまま**——/settings と /p/[id] はレイアウトが
  // 別なので、覚えていないと行き来のたびに開いてしまう（実装：localStorage）
  await sidebar.getByRole("link", { name: "設定" }).click();
  // 設定は1つの面で、いま開いている Project の層も一緒に出す（§6.16）
  // ——歯車は `?project=` を連れていく
  await expect(page).toHaveURL(/\/settings(\?|$)/, { timeout: 15_000 });
  await expectSidebarWidth(sidebar, 58);

  await sidebar.getByRole("button", { name: "サイドバーを開く（⌘B / Ctrl-B）" }).click();
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeVisible({ timeout: 5_000 });
  await expectSidebarWidth(sidebar, 256);

  // ---- ドラッグで幅を変える（決定・2026-09-09、ユーザー要望）--------------
  const handle = sidebar.getByRole("separator", { name: "サイドバーの幅" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(360, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 360);

  // 上限で止まる（画面いっぱいまで広がらない）
  await page.mouse.move(360, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(900, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 480);

  // 下限で止まる
  await page.mouse.move(480, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(20, box.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 200);

  // 変えた幅はリロードしても残る（畳んだ状態と同じ扱いで覚える）
  await page.reload();
  await expect(sidebar.getByRole("link", { name: PROJECT_NAME })).toBeVisible({ timeout: 30_000 });
  await expectSidebarWidth(sidebar, 200);

  // キーボードでも動かせる（マウスでしか変えられない寸法にしない）
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expectSidebarWidth(sidebar, 216);

  // ダブルクリックで既定に戻る
  await handle.dblclick();
  await expectSidebarWidth(sidebar, 256);

  // ---- 別の Project へ移っても、幅は**一瞬も**既定に戻らない ---------------
  // （ユーザー報告・2026-09-09：一度既定の幅になってから変更した幅に直っていた。
  //  `/p/[projectId]` はルートごとに layout を持ち、Project を移ると AppShell が
  //  作り直される——幅を React の state に置いて effect で読み直していたため）
  // 掴む場所は**その時点で**測り直す——幅が変わると境界も動いている
  const movedBox = (await handle.boundingBox())!;
  await page.mouse.move(movedBox.x + movedBox.width / 2, movedBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(320, movedBox.y + 200, { steps: 10 });
  await page.mouse.up();
  await expectSidebarWidth(sidebar, 320);

  const secondRoot = mkdtempSync(join(tmpdir(), "banto-e2e-"));
  await createProject(page, `${PROJECT_NAME} 2`, secondRoot);

  // 毎フレーム測り続ける見張りを仕込む（クライアント遷移では文書は同じなので残る）。
  // 要素は毎回引き直す——遷移でサイドバーは作り直されるため
  await page.evaluate(() => {
    const widths: number[] = [];
    (window as { __sidebarWidths?: number[] }).__sidebarWidths = widths;
    const tick = () => {
      const el = document.querySelector('[data-slot="sidebar-container"]');
      if (el) widths.push(Math.round(el.getBoundingClientRect().width));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // 行の読み上げ名は「頭文字 ＋ Project 名」——**末尾一致**で1つ目に絞る
  // （前方一致だと「… 2」にも当たる）
  await sidebar.getByRole("link", { name: new RegExp(`${PROJECT_NAME}$`) }).click();
  await expect(page.getByText(PROJECT_NAME, { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  const observed = await page.evaluate(
    () => (window as { __sidebarWidths?: number[] }).__sidebarWidths ?? [],
  );
  expect(observed.length, "見張りが1フレームも測れていない").toBeGreaterThan(5);
  expect(
    [...new Set(observed)],
    "Project を移る途中で幅が変わった（既定に戻ってから直っている）",
  ).toEqual([320]);
});

test("設定は1つの面——層は線で分かれ、開いたまま Project を切り替えられる", async ({ page }) => {
  // 決定・2026-09-11（モックで確認、`docs/specs/v4-frontend.md` §6.16）：
  // 設定画面は1つ。左メニューを見出しで層に分け、層の変わり目に線を引く。
  // サイドバーで**別の** Project を押したら設定のまま切り替え、**いま見ている**
  // Project を押したら設定を閉じて会話へ戻る。
  await openApp(page);
  await createProject(page, "設定の層A", mkdtempSync(join(tmpdir(), "banto-e2e-layer-a-")));
  await createProject(page, "設定の層B", mkdtempSync(join(tmpdir(), "banto-e2e-layer-b-")));

  // 会話のヘッダの歯車から入る——**同じ面**（ダイアログではない）
  await openProjectSettings(page);
  await page.waitForURL(/\/settings\?project=/, { timeout: 20_000 });
  await expect(page.locator('[role="dialog"]'), "設定がダイアログで出ている").toHaveCount(0);
  await expect(page.locator('[data-slot="sidebar"]'), "設定を開いたらレールが消えた").toBeVisible();

  // 層の見出しが並び、**Project の層の前に線が入る**（見た目は値で確かめる）
  const layers = await page.evaluate(() =>
    [...document.querySelectorAll("p.tracking-wide")].map((el) => {
      const box = el.closest("div")!;
      const cs = getComputedStyle(box);
      return { label: el.textContent!.trim(), border: cs.borderTopWidth, marginTop: cs.marginTop };
    }),
  );
  expect(layers.map((l) => l.label), "層の見出しが出ていない").toContain("banto 全体");
  const projectLayer = layers.find((l) => l.label.includes("設定の層B"));
  expect(projectLayer, "この Project の層が出ていない").toBeTruthy();
  expect(projectLayer!.border, "層の変わり目に線が無い").not.toBe("0px");

  // **別の Project を押す**——設定は閉じず、その Project の層になる
  await openNav(page);
  await page.getByTestId("sidebar-project-name").filter({ hasText: "設定の層A" }).first().click();
  await page.waitForURL(/\/settings\?project=/, { timeout: 20_000 });
  await expect(
    page.locator("p.tracking-wide").filter({ hasText: "設定の層A" }),
    "別の Project を押したら、その Project の層にならなかった",
  ).toBeVisible({ timeout: 15_000 });

  // **いま見ている Project を押す**——設定を閉じて会話へ戻る
  await openNav(page);
  await page.getByTestId("sidebar-project-name").filter({ hasText: "設定の層A" }).first().click();
  await page.waitForURL(/\/p\/[0-9a-f-]+$/, { timeout: 20_000 });
  await expectProjectOpen(page, "設定の層A");
});
