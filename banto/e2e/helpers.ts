// specから共通で使う手順。真実は一箇所（規則3）——同じ待ちを各specに写さない。
import { expect, type Page } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "./config.js";

/**
 * アプリを開き、**行き先が決まりきるまで待つ**。
 *
 * `/` は実Projectの読み込みが終わってから「先頭のProjectへ」自動で移る
 * （components/banto/project/home-content.tsx）。`/` と `/p/[id]` は
 * **それぞれ別の AppShell を持つ**ので、この移動でトップバーが作り直される
 * ——移動前に「新しい Project」を開くと、入力の途中でダイアログごと消える。
 *
 * Projectが増えるほど読み込みが伸びるため、**後ろのspecほど**この競走に
 * 負けていた（実測・2026-09-06、`作成する` が element detached で押せない）。
 * ここで決着を待ってから操作を始める。
 *
 * 待ち条件は「何秒か待つ」ではなく**実際に決着した印**で書く（規則6）：
 * Projectが有れば `/p/...` へ移り終わっていること、0件なら空状態が出ること。
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await Promise.race([
    page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 30_000 }),
    page.getByText("まだ Project がありません").waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  // **URL が変わっただけでは、まだ着いていない**（改訂・2026-09-12、間欠 3/7 の
  // 調査）。`/` から先頭の Project へは `router.replace` で移るので、**URL は
  // 即座に変わるが、新しい画面が描き終わっているとは限らない**。
  // `/` と `/p/[id]` は別の AppShell を持つ（下の `createProject` のコメント参照）ので、
  // その差の間に開いたダイアログは作り直しに巻き込まれる。
  // **実際に期待する中身が出るまで待つ**（規則6）——会話の入力欄は
  // `/p/[id]` 側にしか無い
  if (/\/p\/[0-9a-f-]+/.test(page.url())) {
    await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  }
  // ナビの入口があること。**幅で場所が変わる**（改訂・2026-09-09）——
  // デスクトップはサイドバーに、モバイルはヘッダの ≡（押すと Drawer）に出る
  await expect(
    isMobileViewport(page)
      ? page.getByRole("button", { name: "Project と Thread の一覧を開く" }).first()
      : page.getByRole("button", { name: "新しい Project", exact: true }),
  ).toBeVisible();
}

/** md 未満（携帯幅）か。ナビの出方がここで変わる */
function isMobileViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/**
 * ナビ（Project 一覧・新しい Project・履歴・設定）を触れる状態にする。
 *
 * **入口は幅で変わる**（改訂・2026-09-09、モバイルの上部バーを廃止した）——
 * デスクトップはサイドバーに出ているのでそのまま。モバイルはパネルのヘッダの
 * ≡ を押して Drawer を開く。開いた Drawer は行き先を選ぶと自分で閉じる。
 */
export async function openNav(page: Page): Promise<void> {
  if (!isMobileViewport(page)) return;
  const newProject = page.getByRole("button", { name: "新しい Project", exact: true });
  if (await newProject.isVisible().catch(() => false)) return; // すでに開いている
  await page.getByRole("button", { name: "Project と Thread の一覧を開く" }).first().click();
  await expect(newProject).toBeVisible({ timeout: 10_000 });
}

/**
 * その Project の Base Thread が開いていること。**題は Project 名だけ**
 * （改訂・2026-09-11、ユーザー要望——「Base Thread —」の接頭辞をやめた。
 * その面が何かは、いま開いているもので分かる）。待ち条件は各 spec に
 * 写さずここ1箇所に持つ（規則3）。
 */
export async function expectProjectOpen(
  page: Page,
  projectName: string,
  message?: string,
): Promise<void> {
  await expect(page.getByText(projectName, { exact: true }).first(), message).toBeVisible({
    timeout: 15_000,
  });
}

/** Project を1つ作り、その Base Thread が開くまで待つ（どの spec も同じ手順を踏む） */
export async function createProject(
  page: Page,
  projectName: string,
  projectRoot: string,
): Promise<void> {
  await openNav(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  const nameInput = page.getByLabel("Project 名");
  const pathInput = page.getByLabel("Root パス");
  const submit = page.getByRole("button", { name: "作成する" });

  await nameInput.fill(projectName);
  await pathInput.fill(projectRoot);

  // **打ったものが残っているか、その場で見る**（追加・2026-09-12）。
  //
  // ここは間欠で落ち続けていた箇所（通算 3/7、`docs/notes/2026-09-11-wide-project-root.md`）。
  // 症状は「`作成する` が**無効のまま** 5 分」——ボタンは消えていないので
  // `element detached` ではなく、**打った値が画面の state に無い**。
  // 原因は測り切れていないが、**待って時間切れになるより、その場で
  // 何が起きたかを言うほうがよい**（規則2・規則6——次に出たとき一発で分かる）。
  //
  // 5分の沈黙ではなく、10秒で「DOM に入っているのに押せない」まで言う。
  const enabled = await submit.isEnabled().catch(() => false);
  if (!enabled) {
    await expect
      .poll(async () => submit.isEnabled().catch(() => false), { timeout: 10_000 })
      .toBe(true)
      .catch(async () => {
        const [nameValue, pathValue, dialogs] = await Promise.all([
          nameInput.inputValue().catch(() => "(読めない)"),
          pathInput.inputValue().catch(() => "(読めない)"),
          page.locator('[role="dialog"]').count(),
        ]);
        throw new Error(
          "「作成する」が無効のまま。" +
            `入力欄の中身: 名前=${JSON.stringify(nameValue)} / Root=${pathValue ? "有" : "空"}、` +
            `開いているダイアログ=${dialogs}、URL=${page.url()}。` +
            (nameValue && pathValue
              ? "**DOM には入っているのに押せない**——画面の state に届いていない（作り直しに巻き込まれた疑い）"
              : "**DOM にも入っていない**——入力欄そのものが入れ替わった疑い"),
        );
      });
  }

  await submit.click();
  await expectProjectOpen(page, projectName);
}

/**
 * 設定の面を開く（改訂・2026-09-11——**会話ヘッダの歯車は無くした**。
 * 同じ機能への入口をサイドバーと2つ持たない、規則3）。
 *
 * 入口はサイドバーの「設定」——いま開いている Project の層も一緒に出る
 * （`docs/specs/v4-frontend.md` §6.16）。`section` を渡すと、その節まで開く。
 */
export async function openProjectSettings(page: Page, section?: string): Promise<void> {
  if (!page.url().includes("/settings")) {
    await openNav(page);
    await page.getByRole("link", { name: "設定", exact: true }).first().click();
    await page.waitForURL(/\/settings/, { timeout: 20_000 });
  }
  if (section) {
    await page.getByRole("button", { name: section, exact: true }).click();
  }
}
