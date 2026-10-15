// **時刻のきっかけ**（アーキ仕様 §4.3「時計」、Backlog #316）。
//
// 見ること（自動化の画面は automation-canvas で作るので、作るのは HTTP の口から）：
//   1. 毎日の時刻（UTC、次の分）の自動化を作ると、その時刻が来た刻みで専用の Fork に届いてターンが走る
//      ——台帳の回は cause「clock」・予定の時刻つきで done、会話には届いたものと AI の返事
//   2. 同じ時刻ではもう動かない（刻みが続いても回は1つ）
//   3. 画面：サイドバーに専用の Fork が自動化の名前で出て、開くと届いたもの（題・送り手）と AI の返事が出る
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";

test.setTimeout(180_000);

const PROJECT_NAME = "E2E Automation Clock";
const AUTOMATION_NAME = "時刻の見回り";
const REPLY = "見回りました：異常はありません。";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Run = { runId: string; result: string; reason?: string; threadId?: string; cause: string; scheduledFor?: string };
type Automation = { id: string; target: { kind: string; threadId?: string }; runs: Run[] };
type ThreadDetail = {
  messages: Array<{ seq: number; role: string; text: string; origin?: { from: string; title: string; automation?: { id: string; runId: string } } }>;
};

test("時刻が来たら時計が専用の Fork を動かし、同じ時刻ではもう動かない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-automation-clock-")));
  const projectId = currentProjectId(page);
  const api = `${CORE_BASE_URL}/api/projects/${projectId}/automations`;
  const automation = async (id: string) => (await (await page.request.get(`${api}/${id}`, { headers })).json()) as Automation;

  // ---- 1. 次の分（UTC）に毎日動く自動化を作る。境目の直前なら、その次の分 ----------------------------------------
  const now = Date.now();
  let slot = Math.ceil(now / 60_000) * 60_000;
  if (slot - now < 10_000) slot += 60_000;
  const at = new Date(slot);
  const time = `${at.getUTCHours()}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const createdRes = await page.request.post(api, {
    headers,
    data: {
      name: AUTOMATION_NAME,
      instruction: "Service の様子を見て報告してください。" + fakeTurn({ say: REPLY }),
      source: { kind: "time", repeat: { kind: "daily", time }, timeZone: "UTC" },
    },
  });
  expect(createdRes.status(), await createdRes.text()).toBe(201);
  const created = (await createdRes.json()) as Automation;
  const forkId = created.target.threadId;
  expect(forkId, "作ったのに専用の Fork が立っていない").toBeTruthy();
  expect(created.runs).toEqual([]);

  // 時刻の前は動かない
  if (slot - Date.now() > 5_000) {
    await page.waitForTimeout(3_000);
    expect((await automation(created.id)).runs, "時刻の前に動いた").toEqual([]);
  }

  // ---- 2. 時刻が来た刻みで動き、結末が done ---------------------------------------------------------------------
  await expect
    .poll(async () => (await automation(created.id)).runs.map((r) => r.result), {
      message: "時刻が来ても時計が動かさない（または結末が出ない）",
      timeout: slot - Date.now() + 60_000,
    })
    .toEqual(["done"]);
  const run = (await automation(created.id)).runs[0]!;
  expect(run).toMatchObject({ cause: "clock", threadId: forkId, scheduledFor: at.toISOString() });
  expect(Date.parse((run as Run & { at: string }).at)).toBeGreaterThanOrEqual(slot);
  const afterRun = await waitTurnEnded(page, forkId!, 1);
  expect(afterRun.messages.filter((m) => m.role === "assistant").at(-1)!.text).toContain(REPLY);
  const fork = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${forkId}`, { headers })).json()) as ThreadDetail;
  const delivered = fork.messages.find((m) => m.origin?.automation);
  expect(delivered?.origin).toMatchObject({ from: "banto", title: `自動化「${AUTOMATION_NAME}」`, automation: { id: created.id, runId: run.runId } });

  // 同じ時刻ではもう動かない（刻みは2秒ごと）
  await page.waitForTimeout(6_000);
  expect((await automation(created.id)).runs.map((r) => r.runId), "同じ時刻でもう一度動いた").toEqual([run.runId]);

  // ---- 3. 画面：サイドバーに専用の Fork、開くと届いたものと AI の返事 ------------------------------------------------
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: AUTOMATION_NAME }), "サイドバーに専用の Fork が出ない").toHaveCount(1, {
    timeout: 30_000,
  });
  await page.goto(`/p/${projectId}?fork=${forkId}`);
  const deliveredCard = page.locator('[data-testid="delivered-message"]').filter({ hasText: `自動化「${AUTOMATION_NAME}」` });
  await expect(deliveredCard, "届いたものが会話に出ない").toBeVisible({ timeout: 30_000 });
  await expect(deliveredCard.getByTestId("delivered-from")).toHaveText("banto から届きました");
  await expect(deliveredCard.getByTestId("delivered-title")).toHaveText(`自動化「${AUTOMATION_NAME}」`);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: REPLY })).toBeVisible();

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
