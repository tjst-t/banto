// **サイドバーから Fork を作る。Fork からも分けられる**（決定・2026-10-11、ユーザー。v4-frontend.md §6.7・§6.32）。
//
// 見るのは：
//   1. 目次の「＋ 新しい Fork」は名前だけ聞き（始め方は出ない）、まっさらな Fork を作って開く
//   2. Base の行の「…」の「ここから Fork…」は名前だけ聞き、Base の会話を引き継いで分ける
//   3. Fork の行の「…」の「ここから Fork…」で、その Fork を親にした Fork ができる
//   4. 目次に「閉じた Fork（N）」の行は出ない（左下の履歴に任せる）

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const NAME = "サイドバーの Fork の spec";

type ThreadJson = { id: string; kind: string; title?: string; parentThreadId?: string; status?: string; messages: { role: string }[] };

async function openRowMenu(page: Page, row: ReturnType<Page["locator"]>): Promise<void> {
  await row.hover();
  await row.getByTestId("sidebar-item-more").first().click();
}

test("サイドバーから Fork を作れる——＋ はまっさら、「…」はその Thread から引き継ぐ。Fork からも分けられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, NAME, mkdtempSync(join(tmpdir(), "banto-e2e-sidebarfork-")));

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === NAME);
  const listThreads = async () =>
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json()) as ThreadJson[];
  const getThread = async (id: string) =>
    (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${id}`, { headers: HEADERS })).json()) as ThreadJson;
  const baseId = (await listThreads()).find((t) => t.kind === "base")!.id;

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(`返事をください${fakeTurn({ say: "ひとつめの返事" })}`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "ひとつめの返事" })).toBeVisible({ timeout: 60_000 });
  await waitTurnEnded(page, baseId, 1);

  const sidebar = page.locator('[data-slot="sidebar"]');
  const dialog = page.getByTestId("fork-dialog");
  const forkLayer = page.locator('[data-testid="panel-overlay"][data-layer="fork"]');
  const forkRow = (title: string) =>
    sidebar.getByTestId("sidebar-fork-name").filter({ hasText: title }).first().locator("xpath=ancestor::*[@data-sortable-id][1]");

  // ---- 4. 「閉じた Fork（N）」の行は無い ----
  await expect(sidebar.getByText(/閉じた Fork（/)).toHaveCount(0);

  // ---- 1. ＋ 新しい Fork：まっさら ----
  await sidebar.getByTestId("sidebar-new-fork").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radiogroup"), "＋ で始め方を聞いている").toHaveCount(0);
  await dialog.getByLabel("名前").fill("白紙");
  await dialog.getByTestId("fork-dialog-submit").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(forkLayer.getByText("白紙", { exact: true }).first(), "作った Fork が開かない").toBeVisible({ timeout: 15_000 });
  const blank = (await listThreads()).find((t) => t.title === "白紙")!;
  expect(blank.parentThreadId).toBe(baseId);
  expect((await getThread(blank.id)).messages, "＋ の Fork が親の会話を持っている").toHaveLength(0);

  // ---- 2. Base の行の「…」：引き継ぐ ----
  const baseRow = sidebar.getByTestId("sidebar-base-name").first().locator("xpath=ancestor::li[1]");
  await openRowMenu(page, baseRow);
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(["ここから Fork…"]);
  await page.getByRole("menuitem", { name: "ここから Fork…" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
  await dialog.getByLabel("名前").fill("枝");
  await dialog.getByTestId("fork-dialog-submit").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(forkLayer.getByText("枝", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  const branch = (await listThreads()).find((t) => t.title === "枝")!;
  expect(branch.parentThreadId).toBe(baseId);
  expect((await getThread(branch.id)).messages.some((m) => m.role === "assistant"), "Base の会話を引き継いでいない").toBe(true);

  // ---- 3. Fork の行の「…」：その Fork が親 ----
  await openRowMenu(page, forkRow("枝"));
  await page.getByRole("menuitem", { name: "ここから Fork…" }).click();
  await dialog.getByLabel("名前").fill("孫");
  await dialog.getByTestId("fork-dialog-submit").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(forkLayer.getByText("孫", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  const grandchild = (await listThreads()).find((t) => t.title === "孫")!;
  expect(grandchild.parentThreadId, "Fork から分けたのに親が Fork でない").toBe(branch.id);
  expect((await getThread(grandchild.id)).messages.some((m) => m.role === "assistant")).toBe(true);
});
