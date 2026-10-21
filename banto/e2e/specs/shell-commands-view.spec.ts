// **入口「バックグラウンドのコマンド」**（決定・2026-10-20、ユーザー、案A。v4-modules.md §2.3「人の画面——バックグラウンドのコマンド」、
// Backlog #491）。Command Palette の「Module の入口」から、AI を介さずに開く。本番と同じ経路：host → コンテナの中の Shell →
// コンテナの中の systemd のユーザー単位。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. AI が待たずに流したコマンドが、入口の一覧に出る——呼び名（label）・状態「動いています」・経った時間
//   2. 選ぶと中身（会話の隣は狭い形——一覧と中身を行き来する）：全文・作業場所・始めた時刻・秘密・出力のファイルのパス・
//      **出力（開いたままで増える）**
//   3. 「止める」は確かめの一言を出し、押すと「人が止めました」。頼んだ会話には「人が画面で止めました」が届いて AI が起き、
//      AI の listCommands にも止めた者（human）が出る
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded, settleProjectsInbox } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Shell Commands View";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const COMMAND = 'for i in $(seq 1 300); do echo "count-$i"; sleep 1; done';
const LABEL = "数を数える";

interface HostMessage {
  role: string;
  text: string;
  origin?: { from: string; title: string; hop: number };
}

async function hostMessages(page: Page, threadId: string): Promise<HostMessage[]> {
  return ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as { messages: HostMessage[] })
    .messages;
}

async function sendTurn(page: Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(text);
  await composer.press("Enter");
}

test.afterAll(async ({ request }) => {
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

test("入口「バックグラウンドのコマンド」：一覧・中身・増える出力が見え、人が止めると AI に「人が画面で止めました」が届く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-shell-view-")));
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  // ---- AI が待たずに流す --------------------------------------------------------------------------------
  await sendTurn(
    page,
    "数を数えて。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: COMMAND, runInBackground: true, label: LABEL } }] }),
  );
  const first = await waitTurnEnded(page, threadId, 1, 120_000);
  const started = JSON.parse(first.messages.filter((m) => m.role === "assistant").at(-1)!.text) as { commandId: string; outputFile: string; status: string };
  expect(started.status).toBe("running");

  // ---- 1. 入口から開く（AI には頼まない）----------------------------------------------------------------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /^バックグラウンドのコマンド/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("AI が待たずに流したコマンドの一覧・出力を見て、止める");
  await entry.click();
  await expect(page.getByText(/^Canvas — shell$/), "入口から Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const row = canvas.locator(`[data-role="command"][data-command="${started.commandId}"]`);
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await expect(canvas.locator('[data-role="command"]')).toHaveCount(1);
  await expect(canvas.locator(".list-label")).toHaveText(["動いている1"]);
  await expect(row.locator('[data-role="title"]')).toHaveText(LABEL);
  await expect(row.locator('[data-role="status"]')).toHaveText("動いています");
  await expect(row.locator('[data-role="elapsed"]')).toHaveText(/^\d+(秒|分(\d+秒)?)$/);
  await expect(canvas.locator('[data-role="running-count"]')).toHaveText("1件 動いています");

  // ---- 2. 中身（狭い形：選ぶと一覧が隠れ、「一覧に戻る」で戻る）--------------------------------------------------
  await row.click();
  const detail = canvas.locator('[data-role="detail"]');
  await expect(detail, "狭い形で中身が開かない").toBeVisible();
  await expect(row, "狭い形なのに一覧が中身と並んでいる").toBeHidden();
  await expect(canvas.locator('[data-role="detail-title"]')).toHaveText(LABEL);
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("動いています");
  await expect(detail.locator('[data-role="detail-command"]')).toHaveText(COMMAND);
  await expect(detail.locator('[data-role="detail-cwd"]')).toHaveText(".");
  await expect(detail.locator('[data-role="detail-exit"]')).toHaveText("—");
  await expect(detail.locator('[data-role="detail-secrets"]')).toHaveText("なし");
  await expect(detail.locator('[data-role="detail-started"]')).toHaveText(/\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d\d:\d\d/);
  await expect(detail.locator('[data-role="output-file"]')).toHaveText(started.outputFile);
  const lines = detail.locator('[data-role="output"] .ln');
  await expect(lines.filter({ hasText: /^count-1$/ })).toHaveCount(1, { timeout: 30_000 });
  // **開いたままで出力が増える**（2 秒ごとに読み足す）
  const before = await lines.count();
  await expect.poll(() => lines.count(), { timeout: 30_000, message: "開いたままの画面で出力が増えない" }).toBeGreaterThan(before + 2);
  // 行は順に並び、欠けない（読み足しの切れ目で行が割れない）
  const texts = await lines.allTextContents();
  expect(texts.map((t) => t.replace(/^count-/, ""))).toEqual(texts.map((_, i) => String(i + 1)));
  await expect(detail.locator('[data-role="output-size"]')).toHaveText(/^\d+ B$/);
  await canvas.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(row).toBeVisible();
  await row.click();

  // ---- 3. 人が止める ------------------------------------------------------------------------------------------
  await canvas.locator('[data-role="stop"]').click();
  await expect(canvas.locator('[data-role="stop-confirm-text"]')).toHaveText("止めると、頼んだ会話に「人が画面で止めました」が届きます。");
  // やめれば何も起きない
  await canvas.locator('[data-role="stop-cancel"]').click();
  await expect(canvas.locator('[data-role="stop-confirm-box"]')).toHaveCount(0);
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("動いています");
  await canvas.locator('[data-role="stop"]').click();
  await canvas.locator('[data-role="stop-confirm"]').click();
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("人が止めました", { timeout: 60_000 });
  await expect(canvas.locator('[data-role="stop"]'), "止まったのに「止める」が残っている").toHaveCount(0);
  await expect(canvas.locator('[data-role="error"]')).toHaveCount(0);
  await expect(canvas.locator('[data-role="running-count"]')).toHaveCount(0);

  // 頼んだ会話に「人が画面で止めました」が届き、AI が起きる（止めたターンは無いので、起きたターンが2つめ）
  await expect(page.getByTestId("delivered-title").last()).toHaveText(`コマンドを人が画面で止めました：${LABEL}`, { timeout: 60_000 });
  await waitTurnEnded(page, threadId, 2, 120_000);
  const report = (await hostMessages(page, threadId)).filter((m) => m.origin).at(-1)!;
  expect(report.origin).toMatchObject({ from: "shell", title: `コマンドを人が画面で止めました：${LABEL}` });
  const body = JSON.parse(report.text) as { status: string; cancelledBy?: string; commandId: string; tail: string; note?: string };
  expect(body).toMatchObject({ status: "cancelled", cancelledBy: "human", commandId: started.commandId });
  expect(body.tail).toContain("count-1");
  expect(body.note).toContain("人が画面（バックグラウンドのコマンド）で止めました");

  // AI の一覧にも止めた者
  await sendTurn(page, "一覧を見せて。" + fakeTurn({ tools: [{ server: "shell", name: "listCommands", args: {} }] }));
  const listed = await waitTurnEnded(page, threadId, 3, 60_000);
  const commands = (JSON.parse(listed.messages.filter((m) => m.role === "assistant").at(-1)!.text) as {
    commands: Array<{ commandId: string; status: string; cancelledBy?: string }>;
  }).commands;
  expect(commands.map((c) => [c.commandId, c.status, c.cancelledBy])).toEqual([[started.commandId, "cancelled", "human"]]);

  // 一覧は「終わった」へ移り、何分前に終わったかが出る
  await canvas.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(canvas.locator(".list-label")).toHaveText(["終わった1"]);
  await expect(row.locator('[data-role="status"]')).toHaveText("人が止めました");
  await expect(row.locator('[data-role="ended"]')).toHaveText(/^(いま|\d+分前に)終わりました$/);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
