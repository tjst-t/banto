// **サイドバーの1件・会話のカードから、Shell の入口「バックグラウンドのコマンド」がその1件で開く**（v4-modules.md §2.3「人の画面
// ——バックグラウンドのコマンド」の「サイドバーの1件・会話のカードから開く」、アーキ仕様 §4.2「結果で名乗る画面」、Backlog #492）。
// 本番と同じ経路：host → コンテナの中の Shell → コンテナの中の systemd のユーザー単位。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. AI が待たずに2本流す。待つ形も1本流す
//   2. サイドバーの1件（1本目）を押すと、Canvas に入口が `canvasView`＝`{ commandId }` で開き、会話の隣（狭い画面）では一覧ではなく
//      **その1件の中身から**見える（題・コマンドの全文）。「一覧に戻る」で一覧（2本）
//   3. 開いたまま、会話のカード（2本目）の「画面で見る」を押すと、同じ入口が2本目の中身で開く
//   4. 待つ形のカードには「画面で見る」が無い（カードは他の tool と同じ一般のカードのまま）
//   5. 置き場に無い commandId で開くと、一覧と「もう残っていません」の一言
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, CORE_BROWSER_URL } from "../config.js";
import { createProject, openApp, fakeTurn, openToolCards, waitForProjectModule, waitTurnEnded, settleProjectsInbox } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Shell Background View";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const FIRST = { command: "echo first-started; sleep 280", label: "一本目を待たずに流す" };
const SECOND = { command: "echo second-started; sleep 281", label: "二本目を待たずに流す" };
const WAITED = "echo waited-output";

async function sendTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(text);
  await composer.press("Enter");
}

test.afterAll(async ({ request }) => {
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

test("サイドバーの1件・会話のカードの「画面で見る」から、入口がその1件の中身で開く。待つ形のカードはそのまま", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-shell-bgv-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const lastReply = (messages: { role: string; text: string }[]) => messages.filter((m) => m.role === "assistant").at(-1)!.text;

  // ---- 1. 待たずに2本、待つ形を1本 --------------------------------------------------------------------------
  const started: string[] = [];
  for (const [i, c] of [FIRST, SECOND].entries()) {
    await sendTurn(page, `流して。` + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { ...c, runInBackground: true } }] }));
    const turn = await waitTurnEnded(page, threadId, i + 1, 120_000);
    const body = JSON.parse(lastReply(turn.messages)) as { commandId: string; status: string };
    expect(body.status).toBe("running");
    started.push(body.commandId);
  }
  const [firstId, secondId] = started as [string, string];
  await sendTurn(page, "待って流して。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: WAITED } }] }));
  const waited = await waitTurnEnded(page, threadId, 3, 120_000);
  expect((JSON.parse(lastReply(waited.messages)) as { stdout: string }).stdout).toBe("waited-output\n");

  // ---- 2. サイドバーの1件（1本目）から開く ---------------------------------------------------------------------
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const line = sidebar.getByTestId("thread-background");
  await expect(line, "Base Thread の行にバックグラウンドの印が出ない").toHaveCount(1, { timeout: 30_000 });
  await line.click();
  const list = page.getByTestId("background-list");
  const items = list.getByTestId("background-item");
  await expect(items).toHaveCount(2);
  await items.filter({ hasText: FIRST.label }).click();
  await expect(list).toBeHidden();
  await expect(page.getByText(/^Canvas — shell$/), "Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  let url = new URL(page.url());
  expect(url.searchParams.get("canvas")).toBe("shell:ui://banto-shell/commands");
  expect(url.searchParams.get("canvasView")).toBe(JSON.stringify({ commandId: firstId }));
  expect(url.searchParams.get("canvasTool"), "定義に画面の無い tool を toolCallId で開いた").toBeNull();

  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const detail = canvas.locator('[data-role="detail"]');
  // 会話の隣は狭い形——一覧ではなく、その1件の中身から
  await expect(detail, "選んだ1件の中身が開かない").toHaveAttribute("data-command", firstId, { timeout: 60_000 });
  await expect(canvas.locator('[data-role="detail-title"]')).toHaveText(FIRST.label);
  await expect(detail.locator('[data-role="detail-command"]')).toHaveText(FIRST.command);
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("動いています");
  await expect(detail.locator('[data-role="output"] .ln').filter({ hasText: /^first-started$/ })).toHaveCount(1, { timeout: 30_000 });
  const rows = canvas.locator('[data-role="command"]');
  await expect(rows.first(), "狭い形なのに一覧が中身と並んでいる").toBeHidden();
  await canvas.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-role="title"]')).toHaveText([SECOND.label, FIRST.label]);
  await expect(canvas.locator('[data-role="missing"]')).toHaveCount(0);

  // ---- 3. 開いたまま、会話のカード（2本目）の「画面で見る」 -------------------------------------------------------
  // 「画面で見る」のカードは tool の折りたたみの外（畳んだままでも見える）。題は呼び名、説明はコマンド
  const viewCards = page.getByTestId("shell-background-view-card");
  // ---- 4. 待つ形には足さない（待たない形の2枚だけ）。tool のカードは3つとも一般のカードのまま -------------------------
  await expect(viewCards, "「画面で見る」の数が待たない形の呼び出しの数と違う").toHaveCount(2);
  await expect(viewCards.nth(0)).toContainText(FIRST.label);
  await expect(viewCards.nth(0)).toContainText(FIRST.command);
  await expect(viewCards.nth(1)).toContainText(SECOND.label);
  await expect(viewCards.nth(1)).toContainText(SECOND.command);
  // 畳みを開くと、tool のカードは3つとも一般のカード。待つ形の結果は今までどおりその中に出る
  const groups = page.locator('[data-slot="tool-group-trigger"]');
  await expect(groups).toHaveCount(3);
  for (let i = 0; i < 3; i++) if ((await groups.nth(i).getAttribute("aria-expanded")) !== "true") await groups.nth(i).click();
  await expect(page.locator('[data-slot="tool-fallback-trigger"]', { hasText: "runCommand" })).toHaveCount(3);
  await openToolCards(page, "mcp__shell__runCommand");
  const results = page.locator('[data-slot="tool-fallback-result"]');
  await expect(results).toHaveCount(3);
  await expect(results.nth(2)).toContainText("waited-output");
  await expect(results.nth(0)).toContainText(firstId);
  await expect(viewCards).toHaveCount(2);
  const openButtons = viewCards.getByRole("button", { name: "画面で見る" });
  await openButtons.nth(1).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("canvasView"), { timeout: 10_000 }).toBe(JSON.stringify({ commandId: secondId }));
  await expect(detail, "開いていた入口が2本目に替わらない").toHaveAttribute("data-command", secondId, { timeout: 30_000 });
  await expect(canvas.locator('[data-role="detail-title"]')).toHaveText(SECOND.label);
  await expect(detail.locator('[data-role="detail-command"]')).toHaveText(SECOND.command);
  await expect(rows.first()).toBeHidden();

  // 閉じてから、カード（1本目）で開く
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect(page.getByText(/^Canvas — shell$/)).toHaveCount(0);
  await openButtons.nth(0).click();
  await expect(detail).toHaveAttribute("data-command", firstId, { timeout: 60_000 });
  await expect(canvas.locator('[data-role="detail-title"]')).toHaveText(FIRST.label);
  url = new URL(page.url());
  expect(url.searchParams.get("fork")).toBeNull();

  // ---- 5. 置き場に無い commandId ------------------------------------------------------------------------------
  await page.goto(
    `/p/${project.id}?bantoHost=${CORE_BROWSER_URL}&canvas=${encodeURIComponent("shell:ui://banto-shell/commands")}&canvasView=${encodeURIComponent(JSON.stringify({ commandId: "cmd_not_here" }))}`,
  );
  await expect(canvas.locator('[data-role="missing"]'), "置き場に無いのに一言が出ない").toHaveText(
    "開こうとしたコマンドの記録は、もう残っていません（古いものから消えます）。一覧から選んでください。",
    { timeout: 60_000 },
  );
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toBeVisible();
  await expect(detail).toHaveCount(0);
  // 一覧から選べば一言は消える
  await rows.filter({ hasText: FIRST.label }).click();
  await expect(detail).toHaveAttribute("data-command", firstId);
  await canvas.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(canvas.locator('[data-role="missing"]')).toHaveCount(0);

  // 後片付け：2本とも止める（止めた知らせで AI が起きる）
  await sendTurn(
    page,
    "止めて。" +
      fakeTurn({
        tools: [
          { server: "shell", name: "cancelCommand", args: { commandId: firstId } },
          { server: "shell", name: "cancelCommand", args: { commandId: secondId } },
        ],
      }),
  );
  // 止めたターンと、止めた知らせで起きるターン（2本が1回にまとまるかは届く間合いしだい）の数は決まらないので、印が消えるのを待つ
  await expect(line, "止めたのに印が残っている").toHaveCount(0, { timeout: 120_000 });

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
