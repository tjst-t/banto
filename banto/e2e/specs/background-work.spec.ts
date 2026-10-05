// **サイドバーのバックグラウンドの印**（決定・2026-10-03、ユーザー。v4-frontend.md §6.33）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 待たずに2つ頼むと、Base Thread の行の名前の下に「バックグラウンドで 2 件」
//   2. リロードしても出ている（繋いだときの hello から）
//   3. 押すと一覧：見出しの件数・2件の題（カードと同じ「fake に頼んだ仕事」）・頼んだ内容・Module 名
//   4. 1件を押すと、Canvas にサブエージェントの画面が開き、その仕事が選ばれている
//   5. 別の Project を開くと、元の Project の行の頭文字の右下に「2」。いま開いている Project の行には出ない。
//      押すと一覧が Thread ごと（「Base Thread」の見出し）に出て、1件を押すと元の Project でその仕事が開く
//   6. 1つ届くと「fake に頼んだ仕事」（1件のときは題）に、全部届くと印が消える（開いたままの画面で）
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

const PROJECT_NAME = "E2E Background Work";
const OTHER_NAME = "E2E Background Other";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const FIRST = "[slow 70] 一つ目の仕事";
const SECOND = "[slow 120] 二つ目の仕事";

async function assistantCount(page: Page, threadId: string): Promise<number> {
  const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: { role: string }[];
  };
  return thread.messages.filter((m) => m.role === "assistant").length;
}

test("待たずに頼んだ仕事が、どの Thread で動いているかサイドバーに出て、押すとその仕事が開く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-bg-work-")));
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const line = sidebar.getByTestId("thread-background");
  const list = page.getByTestId("background-list");
  const items = list.getByTestId("background-item");
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const detailPrompt = canvas.locator('[data-role="detail"] [data-role="detail-prompt"]');

  // ---- 1. 待たずに2つ頼む ----------------------------------------------------------------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "2つ待たずに頼んで。" +
      fakeTurn({
        tools: [
          { server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: FIRST, runInBackground: true } },
          { server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: SECOND, runInBackground: true } },
        ],
      }),
  );
  await composer.press("Enter");
  // 鍵を使うエージェントは初回に Vault の在りかを聞く（Project ごとに1回）
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) {
      await allow.last().click();
    }
    await expect(page.getByText(/待たずに頼みました/)).toHaveCount(2, { timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await expect.poll(() => assistantCount(page, threadId), { timeout: 60_000, message: "最初のターンが終わらない" }).toBe(1);

  await expect(line, "Base Thread の行にバックグラウンドの印が出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(line).toHaveText("バックグラウンドで 2 件");

  // ---- 2. リロードしても出ている（hello） ------------------------------------------------------------
  await page.reload();
  await expect(line, "リロードしたら印が消えた（hello に載っていない）").toHaveText("バックグラウンドで 2 件", { timeout: 60_000 });

  // ---- 3. 押すと一覧 ---------------------------------------------------------------------------------
  await line.click();
  await expect(list).toBeVisible();
  await expect(list).toContainText("バックグラウンドで動いているもの（2）");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("fake に頼んだ仕事");
  await expect(items.nth(0)).toContainText(FIRST);
  await expect(items.nth(0)).toContainText(/subagent・(いま|\d+分前)に頼んだ/);
  await expect(items.nth(1)).toContainText("fake に頼んだ仕事");
  await expect(items.nth(1)).toContainText(SECOND);
  await expect(list, "開いている Thread の一覧に Thread の見出しが出ている").not.toContainText("Base Thread");

  // ---- 4. 1件を押すと、その仕事が開く ------------------------------------------------------------------
  await items.nth(0).click();
  await expect(list).toBeHidden();
  await expect(page.getByText(/^Canvas — subagent$/), "Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/canvasTool=toolu_fake_/);
  await expect(detailPrompt, "開いた画面でその仕事が選ばれていない").toHaveText(FIRST, { timeout: 60_000 });
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();

  // ---- 5. 別の Project から見る ----------------------------------------------------------------------
  // createProject は、作った Project が開くまで待つ
  await createProject(page, OTHER_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-bg-other-")));
  const badge = sidebar.getByTestId("project-background");
  await expect(badge, "開いていない Project の行に数が出ない／開いている Project にも出ている").toHaveCount(1, { timeout: 30_000 });
  await expect(badge).toHaveText("2");
  await expect(badge).toHaveAccessibleName(`${PROJECT_NAME}のバックグラウンドで動いているもの（2件）を見る`);
  await expect(line, "開いていない Project の Thread の行が見えている").toHaveCount(0);
  await badge.click();
  await expect(list).toContainText("バックグラウンドで動いているもの（2）");
  await expect(list).toContainText("Base Thread");
  await expect(items).toHaveCount(2);
  await items.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/p/${project.id}\\?`));
  await expect(detailPrompt, "別の Project から押して、その仕事が開かない").toHaveText(SECOND, { timeout: 60_000 });
  await expect(badge, "開いた Project の行に数が残っている").toHaveCount(0);
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();

  // ---- 6. 届くと減り、全部届くと消える（開いたままの画面で） ----------------------------------------------
  await expect(line, "1つ届いたのに減らない").toHaveText("fake に頼んだ仕事", { timeout: 120_000 });
  await line.click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(SECOND);
  await page.keyboard.press("Escape");
  await expect(line, "全部届いたのに印が残っている").toHaveCount(0, { timeout: 150_000 });

  // ---- 後片づけ：この試験の仕事の完了のお知らせを「確認した」にする ---------------------------------------
  // 同じ回の後の spec（inbox.spec）は受信箱のバッジの数を見る。残すとそちらが落ちる（実測・2026-10-03）
  type InboxItem = { id: string; kind: string; projectId?: string; threadId?: string };
  const mine = (item: InboxItem) => item.kind === "notice" && (item.projectId === project.id || item.threadId === threadId);
  const inbox = async () => (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as InboxItem[];
  for (const item of (await inbox()).filter(mine)) {
    expect((await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers })).ok()).toBe(true);
  }
  expect((await inbox()).filter(mine), "お知らせが片づかない").toEqual([]);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
