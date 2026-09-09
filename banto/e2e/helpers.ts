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
 * その Project の Base Thread が開いていること。**題は幅で変わる**
 * （改訂・2026-09-09——モバイルは段が1つなので、接頭辞を落として Project 名だけ）
 * ので、待ち条件を各 spec に写さずここ1箇所に持つ（規則3）。
 */
export async function expectProjectOpen(
  page: Page,
  projectName: string,
  message?: string,
): Promise<void> {
  const title = isMobileViewport(page) ? projectName : `Base Thread — ${projectName}`;
  await expect(page.getByText(title, { exact: true }).first(), message).toBeVisible({
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
  await page.getByLabel("Project 名").fill(projectName);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expectProjectOpen(page, projectName);
}
