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
  await expect(page.getByRole("button", { name: "新しい Project", exact: true })).toBeVisible();
}
