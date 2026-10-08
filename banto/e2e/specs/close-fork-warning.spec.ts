// **Fork を閉じるときの警告と、AI が閉じた Fork**（決定・2026-10-08、ユーザー。v4-frontend.md §6「Fork を閉じるときの警告」、
// アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 裏の仕事（ここでは人の答えを待つもの。試験用 Module `fixtures/ask-human-module`）が1件ある Fork をサイドバーの「…」から
//      閉じると、小窓に件数・題・Module 名・「閉じても仕事は止まりません…」が出る。「やめる」で閉じない（host でも開いたまま）。
//      「それでも閉じる」で閉じる（サイドバーから外れ、開いていた画面は Base へ戻る）
//   2. 裏の仕事が無い Fork は、小窓を出さずに閉じる
//   3. AI が `close_fork` で閉じた Fork：開いている画面は Base へ飛ばず、帯「この Fork は閉じました（理由）」と「開き直す」が出て、
//      入力欄と Close は消える。サイドバーから外れ、履歴の行に「AI が閉じました：理由」。人が閉じた Fork の行には出ない。
//      「開き直す」で帯が消え、入力欄が戻り、サイドバーに戻る（host でも開いている）
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { confirmForkDialog, createProject, fakeTurn, openApp, settleProjectsInbox, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const STAMP = Date.now();
const MODULE = `e2e-close-ask-${STAMP}`;
const PROJECT_NAME = "E2E Close Fork Warning";
const AI_PROJECT_NAME = "E2E AI Closes Fork";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ask-human-module/server.js");

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
  await settleProjectsInbox(request, [PROJECT_NAME, AI_PROJECT_NAME]);
});

interface HostThread {
  status: string;
  closedBy?: string;
  closedReason?: string;
}

async function hostThread(page: Page, threadId: string): Promise<HostThread> {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as HostThread;
}

/** ヘッダの「Fork を開く」から名前つきで Fork を作り、開いた Fork の id を返す */
async function openNamedFork(page: Page, title: string): Promise<string> {
  await page.getByRole("button", { name: "Fork を開く" }).first().click();
  await confirmForkDialog(page, { title });
  await page.waitForURL(/[?&]fork=[0-9a-f-]+/);
  return new URL(page.url()).searchParams.get("fork")!;
}

function forkRow(page: Page, title: string) {
  return page
    .getByTestId("sidebar-fork-name")
    .filter({ hasText: title })
    .first()
    .locator("xpath=ancestor::*[@data-sortable-id][1]");
}

async function closeFromSidebar(page: Page, title: string): Promise<void> {
  const row = forkRow(page, title);
  await row.hover();
  await row.getByTestId("sidebar-item-more").click();
  await page.getByRole("menuitem", { name: "Close" }).click();
}

test("裏の仕事が残っている Fork を閉じると警告が出る。やめる／それでも閉じる。無ければ確かめずに閉じる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const added = await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers,
    data: { mcpServers: { [MODULE]: { command: "${nodeExec}", args: [SERVER] } } },
  });
  expect(added.status(), `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-close-warning-")));

  // ---- 裏の仕事がある Fork ------------------------------------------------------------------------
  const WITH_WORK = "裏の仕事あり";
  const forkId = await openNamedFork(page, WITH_WORK);
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await forkComposer.fill("承認を頼んで。" + fakeTurn({ tools: [{ server: MODULE, name: "askHuman", args: { what: "閉じる前" } }], then: "頼みました。" }));
  await forkComposer.press("Enter");
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: "頼みました。" }).first()).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await waitTurnEnded(page, forkId, 1);
  // 画面が裏の仕事を知っている（サイドバーの行の下）——小窓はこの写しから出す
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  await expect(sidebar.getByTestId("thread-waiting-human"), "裏の仕事がサイドバーに出ない").toHaveText("試験の承認：閉じる前", {
    timeout: 30_000,
  });

  const warning = page.getByTestId("close-fork-warning");
  await closeFromSidebar(page, WITH_WORK);
  await expect(warning, "裏の仕事があるのに警告が出ない").toBeVisible({ timeout: 10_000 });
  await expect(warning).toContainText(`「${WITH_WORK}」を閉じますか`);
  await expect(warning).toContainText("この Fork が頼んだ仕事が 1 件残っています。");
  await expect(warning).toContainText("閉じても仕事は止まりません。結果はこの Fork に溜まり、開き直すまで AI は読みません。");
  const items = warning.getByTestId("background-summary-item");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute("data-kind", "human");
  await expect(items.first()).toContainText("試験の承認：閉じる前");
  await expect(items.first()).toContainText(new RegExp(`${MODULE}・(いま|\\d+分前)から待っています`));
  await expect(warning.locator('section[data-kind="human"]')).toContainText("あなたの答えを待っているもの（1）");
  await expect(warning.locator('section[data-kind="work"]')).toHaveCount(0);

  // やめる → 閉じない
  await warning.getByRole("button", { name: "やめる" }).click();
  await expect(warning).toBeHidden();
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: WITH_WORK }), "やめたのに一覧から消えた").toHaveCount(1);
  expect((await hostThread(page, forkId)).status, "やめたのに host で閉じている").toBe("active");
  await expect(page).toHaveURL(new RegExp(`fork=${forkId}`));

  // それでも閉じる → 閉じて、開いていた画面は Base へ戻る（人が閉じたとき）
  await closeFromSidebar(page, WITH_WORK);
  await expect(warning).toBeVisible({ timeout: 10_000 });
  await warning.getByRole("button", { name: "それでも閉じる" }).click();
  await expect(warning).toBeHidden();
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: WITH_WORK }), "閉じたのに一覧に残っている").toHaveCount(0, {
    timeout: 15_000,
  });
  await expect.poll(async () => (await hostThread(page, forkId)).status).toBe("closed");
  expect((await hostThread(page, forkId)).closedBy).toBe("human");
  await expect(page, "人が閉じたのに Base へ戻らない").not.toHaveURL(/[?&]fork=/, { timeout: 15_000 });
  await expect(page.getByTestId("fork-closed-banner")).toHaveCount(0);

  // ---- 裏の仕事が無い Fork：確かめずに閉じる -------------------------------------------------------------
  const NO_WORK = "裏の仕事なし";
  const quietId = await openNamedFork(page, NO_WORK);
  await page.getByRole("button", { name: /Base Thread に戻る$/ }).first().click();
  await expect(page).not.toHaveURL(/[?&]fork=/, { timeout: 15_000 });
  await closeFromSidebar(page, NO_WORK);
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: NO_WORK })).toHaveCount(0, { timeout: 15_000 });
  await expect(warning, "裏の仕事が無いのに警告が出た").toHaveCount(0);
  await expect.poll(async () => (await hostThread(page, quietId)).status).toBe("closed");

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("AI が閉じた Fork：開いている画面は飛ばずに帯と「開き直す」、履歴に理由。開き直せる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, AI_PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-ai-close-")));
  const sidebar = page.locator('[data-sidebar="sidebar"]');

  // 比べるために、人が閉じた Fork を1つ置いておく（履歴の行に「AI が閉じました」が出ないこと）
  const HUMAN = "人が閉じる";
  const humanId = await openNamedFork(page, HUMAN);
  await page.getByRole("button", { name: "この Fork Thread を Close" }).click();
  await expect(page).not.toHaveURL(/[?&]fork=/, { timeout: 15_000 });
  await expect.poll(async () => (await hostThread(page, humanId)).status).toBe("closed");

  const TITLE = "AI が閉じる";
  const REASON = "調べ終えました";
  const forkId = await openNamedFork(page, TITLE);
  const forkLayer = page.locator('[data-layer="fork"]');
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await forkComposer.fill(
    "終わったら閉じて。" +
      fakeTurn({ tools: [{ server: "banto-thread", name: "close_fork", args: { reason: REASON } }], then: "この Fork を閉じます。" }),
  );
  await forkComposer.press("Enter");
  await waitTurnEnded(page, forkId, 1);
  await expect.poll(async () => (await hostThread(page, forkId)).status, { message: "AI が閉じたのに host で開いている" }).toBe("closed");
  const host = await hostThread(page, forkId);
  expect(host.closedBy).toBe("ai");
  expect(host.closedReason).toBe(REASON);

  // 開いている画面は Base へ飛ばず、帯と「開き直す」
  const banner = forkLayer.getByTestId("fork-closed-banner");
  await expect(banner, "AI が閉じたのに帯が出ない").toBeVisible({ timeout: 15_000 });
  await expect(banner).toHaveText(new RegExp(`^この Fork は閉じました（${REASON}）\\s*開き直す$`));
  await expect(banner).toHaveAttribute("data-closed-by", "ai");
  await expect(page, "AI が閉じたら Base へ飛んだ").toHaveURL(new RegExp(`fork=${forkId}`));
  // 会話はそのまま読める
  await expect(forkLayer.locator('[data-role="assistant"]').filter({ hasText: "この Fork を閉じます。" })).toBeVisible();
  // 入力欄は開き直すまで使えない。Close も出さない（もう閉じている）
  await expect(forkComposer, "閉じた Fork に入力欄が残っている").toHaveCount(0);
  await expect(page.getByRole("button", { name: "この Fork Thread を Close" })).toHaveCount(0);
  // サイドバーの開いている一覧から外れる
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: TITLE }), "AI が閉じたのにサイドバーに残っている").toHaveCount(0);

  // 履歴：AI が閉じた行に理由、人が閉じた行には出ない
  await page.getByRole("button", { name: "履歴", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  const aiRow = dialog.locator("div.border-b").filter({ hasText: TITLE });
  await expect(aiRow.getByTestId("archive-row-note"), "履歴に AI が閉じた理由が出ない").toHaveText(`AI が閉じました：${REASON}`, {
    timeout: 10_000,
  });
  const humanRow = dialog.locator("div.border-b").filter({ hasText: HUMAN });
  await expect(humanRow).toHaveCount(1);
  await expect(humanRow.getByTestId("archive-row-note"), "人が閉じた Fork に「AI が閉じました」が出ている").toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // 開き直す → 帯が消え、入力欄が戻り、サイドバーに戻る
  await banner.getByRole("button", { name: "開き直す" }).click();
  await expect(banner, "開き直したのに帯が残っている").toHaveCount(0, { timeout: 15_000 });
  await expect(forkComposer, "開き直したのに入力欄が戻らない").toBeVisible();
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: TITLE })).toHaveCount(1, { timeout: 15_000 });
  const reopened = await hostThread(page, forkId);
  expect(reopened.status).toBe("active");
  expect(reopened.closedBy).toBeUndefined();

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
