// **任務の画面**（v4-frontend.md §6.47、Backlog #422）。仕組み（start_mission・予約・起こし方）は mission.spec.ts が見る。
//
// 1つの Project の Base Thread で、見ること（画面と host の記録で）：
//   1. 「…」の「任務にする」のダイアログで始めると、ヘッダの題の横に「任務」の札・サイドバーの行の下に「任務：…」の1行が出る。
//      札の面に目標・終わりの条件・枠・次の予約・ボタンが出て、「…」から「任務にする」が消える
//   2. 面の「枠を延ばす」で回数の上限が変わる（host・面・サイドバー）。「今すぐ起こす」で起き、会話の頭に薄い1行「任務で起きました
//      （1/3 回目）」、予約の無いまま終わると「止まっています」（札・サイドバーが人の番の色、面に起きた記録）。面から延ばすと動いている
//      任務に戻り、「止める」で止まる（札・1行が消え、「任務にする」が戻る）
//   3. 受信箱の返ってきた会話のカードに任務の結末（止まっています・目標・起きた回数）と「延ばす」「終える」。カードから延ばす・終えるが効く
//   4. 任務を持つ会話の「決めることがある」カードに「枠を延ばす」。カードから延ばすと host の枠が変わる
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";

test.setTimeout(240_000);

const PROJECT_NAME = "E2E Mission UI";
const GOAL = "リリースノートを仕上げる";
const DONE_WHEN = "PR がマージされた";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Mission = {
  id: string;
  status: string;
  wakes: number;
  frame: { maxWakes: number; until: string; minIntervalMinutes: number };
  history: Array<{ wake: number; cause: string; result?: string }>;
};
type InboxItem = {
  id: string;
  kind: string;
  threadId?: string;
  acknowledged?: boolean;
  mission?: { id: string; status: string; wakes: number; maxWakes: number; goal: string };
};

/** 「…」の「任務にする」から始める */
async function startFromMenu(page: Page, goal: string, maxWakes: string): Promise<void> {
  await page.getByRole("button", { name: "Thread の操作" }).first().click();
  await page.getByRole("menuitem", { name: "任務にする" }).click();
  const dialog = page.getByTestId("mission-start-dialog");
  await expect(dialog).toBeVisible();
  // 既定の枠（AI の start_mission のカードと同じ欄・同じ既定）
  await expect(dialog.getByTestId("mission-start-field-maxWakes")).toHaveValue("20");
  await expect(dialog.getByTestId("mission-start-field-untilDays")).toHaveValue("3");
  await expect(dialog.getByTestId("mission-start-field-minInterval")).toHaveValue("15");
  await expect(dialog.getByRole("button", { name: "始める", exact: true })).toBeDisabled();
  await dialog.getByTestId("mission-start-goal").fill(goal);
  await dialog.getByTestId("mission-start-done-when").fill(DONE_WHEN);
  await dialog.getByTestId("mission-start-field-maxWakes").fill(maxWakes);
  await dialog.getByRole("button", { name: "始める", exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

test("任務の画面：札と面・サイドバーの1行・会話の薄い1行・受信箱の結末と「枠を延ばす」。面とカードから延ばす・止めるが効く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const get = async <T,>(path: string) => (await (await page.request.get(`${CORE_BASE_URL}${path}`, { headers })).json()) as T;

  await openApp(page);
  // 人が「会話を離れて」いる場所（開いている会話のカードは画面が「見た」にする。設定の画面は受信箱の上に重なる）
  await createProject(page, `${PROJECT_NAME} 別`, mkdtempSync(join(tmpdir(), "banto-e2e-mission-ui-other-")));
  const elsewhere = currentProjectId(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-mission-ui-")));
  const projectId = currentProjectId(page);
  const baseId = (await get<Array<{ id: string; kind: string }>>(`/api/projects/${projectId}/threads`)).find((t) => t.kind === "base")!.id;
  const mission = async () => (await get<{ mission: Mission | null }>(`/api/threads/${baseId}/mission`)).mission;
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const badge = page.getByTestId("mission-badge");
  const line = sidebar.getByTestId("thread-mission");
  const panel = page.getByTestId("mission-panel");

  // ---- 1. 「…」の「任務にする」で始める → 札・面・サイドバーの1行 ------------------------------------------------------
  await page.goto(`/p/${projectId}`);
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 30_000 });
  await expect(badge, "任務の無い会話に札が出ている").toHaveCount(0);
  await expect(line).toHaveCount(0);
  await startFromMenu(page, GOAL, "2");
  await expect.poll(async () => (await mission())?.status, { message: "任務が始まらない" }).toBe("active");
  expect(await mission()).toMatchObject({ wakes: 0, frame: { maxWakes: 2, minIntervalMinutes: 15 } });
  await expect(badge).toHaveText("任務");
  await expect(badge).toHaveAttribute("data-status", "active");
  await expect(line).toHaveText("任務：動いています（0/2）");
  await badge.click();
  await expect(panel.getByTestId("mission-panel-status")).toHaveText("任務・動いています");
  await expect(panel.getByTestId("mission-panel-goal")).toHaveText(GOAL);
  await expect(panel.getByTestId("mission-panel-done-when")).toHaveText(DONE_WHEN);
  await expect(panel.getByTestId("mission-panel-frame")).toContainText("0/2 回");
  await expect(panel.getByTestId("mission-panel-frame")).toContainText("最短の間隔 15 分");
  await expect(panel.getByTestId("mission-panel-next")).toHaveText("まだありません（いまの回が予約します）");
  await expect(panel.getByTestId("mission-panel-history")).toHaveCount(0);
  await expect(panel.getByRole("button")).toHaveText(["今すぐ起こす", "枠を延ばす", "止める"]);

  // ---- 2. 面から延ばす → 今すぐ起こす → 止まっている → 延ばして戻す → 止める ------------------------------------------------
  await panel.getByRole("button", { name: "枠を延ばす" }).click();
  await expect(panel.getByTestId("mission-extend-field-maxWakes")).toHaveValue("2");
  await panel.getByTestId("mission-extend-field-maxWakes").fill("3");
  await panel.getByRole("button", { name: "この枠に延ばす" }).click();
  await expect(panel.getByTestId("mission-panel-frame")).toContainText("0/3 回");
  expect((await mission())!.frame.maxWakes, "面で延ばした枠が host に無い").toBe(3);
  await expect(line).toHaveText("任務：動いています（0/3）");

  await panel.getByRole("button", { name: "今すぐ起こす" }).click();
  // 予約の無いまま回が終わる → 止まっている
  await expect.poll(async () => { const m = await mission(); return `${m?.status}:${m?.wakes}:${m?.history[0]?.cause}`; }, { timeout: 60_000, message: "起きない・止まらない" }).toBe("stalled:1:human");
  await expect(badge).toHaveAttribute("data-status", "stalled", { timeout: 15_000 });
  await expect(line).toHaveText("任務：止まっています");
  await expect(line).toHaveClass(/text-turn/);
  const wakeLine = page.getByTestId("mission-wake-text");
  await expect(wakeLine, "会話の頭に任務で起きた1行が出ない").toHaveText("任務で起きました（1/3 回目）", { timeout: 30_000 });
  if (!(await panel.isVisible())) await badge.click();
  await expect(panel.getByTestId("mission-panel-status")).toHaveText("任務・止まっています");
  await expect(panel.getByTestId("mission-panel-history-item")).toHaveCount(1);
  await expect(panel.getByTestId("mission-panel-history-item")).toContainText("1 回目");
  await expect(panel.getByTestId("mission-panel-history-item")).toContainText("人が起こした・何も無く終わった");
  await expect(panel.getByTestId("mission-panel-result")).toHaveText("予約も終わりも無いままターンが終わりました");
  await expect(panel.getByRole("button")).toHaveText(["枠を延ばす", "止める"]);
  await panel.getByRole("button", { name: "枠を延ばす" }).click();
  await panel.getByRole("button", { name: "この枠に延ばす" }).click();
  await expect(panel.getByTestId("mission-panel-status")).toHaveText("任務・動いています");
  expect(await mission(), "延ばしても動いている任務に戻らない").toMatchObject({ status: "active", wakes: 1, frame: { maxWakes: 3 } });
  await expect(line).toHaveText("任務：動いています（1/3）");
  await panel.getByRole("button", { name: "止める" }).click();
  await expect.poll(async () => (await mission())?.status, { message: "面の「止める」が効かない" }).toBe("stopped");
  await expect(badge, "止めた任務の札が残っている").toHaveCount(0);
  await expect(line).toHaveCount(0);

  // ---- 3. 受信箱：返ってきた会話のカードの結末と「延ばす」「終える」 ---------------------------------------------------------
  // 「任務にする」が戻っている。人は会話を離れる（開いている会話のカードは画面が「見た」にする）
  await startFromMenu(page, GOAL, "5");
  await expect.poll(async () => (await mission())?.status).toBe("active");
  await page.goto(`/p/${elsewhere}`);
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 30_000 });
  await expect(badge, "別の Project の会話に任務の札が出ている").toHaveCount(0);
  const reviews = async () => (await get<InboxItem[]>("/api/inbox")).filter((i) => i.kind === "review" && i.threadId === baseId && !i.acknowledged);
  for (const r of await reviews()) await page.request.post(`${CORE_BASE_URL}/api/inbox/${r.id}/acknowledge`, { headers });
  const wake = async () => expect((await page.request.post(`${CORE_BASE_URL}/api/threads/${baseId}/mission/wake`, { headers })).status()).toBe(200);
  await wake();
  await expect.poll(async () => (await mission())?.status, { timeout: 60_000 }).toBe("stalled");
  await expect.poll(async () => (await reviews()).find((r) => r.mission)?.mission?.status, { timeout: 30_000, message: "受信箱に任務の結末が出ない" }).toBe("stalled");

  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  const outcome = inbox.getByTestId("inbox-section-returned").getByTestId("inbox-mission");
  await expect(outcome).toHaveCount(1, { timeout: 30_000 });
  await expect(outcome.getByTestId("inbox-mission-status")).toHaveText("止まっています");
  await expect(outcome.getByTestId("inbox-mission-goal")).toHaveText(`任務：${GOAL}`);
  await expect(outcome.getByTestId("inbox-mission-result")).toHaveText("予約も終わりも無いままターンが終わりました");
  await expect(outcome.getByTestId("inbox-mission-wakes")).toHaveText("起きた回数 1/5 回");
  await expect(outcome.getByRole("button")).toHaveText(["延ばす", "終える"]);
  await outcome.getByTestId("inbox-mission-extend").click();
  await outcome.getByTestId("mission-extend-field-maxWakes").fill("6");
  await outcome.getByRole("button", { name: "この枠に延ばす" }).click();
  await expect(outcome.getByTestId("inbox-mission-now")).toHaveText("いまは：動いています");
  expect(await mission(), "カードで延ばした枠が host に無い").toMatchObject({ status: "active", frame: { maxWakes: 6 } });

  // もう1回止まらせて、カードの「終える」
  await wake();
  await expect.poll(async () => (await mission())?.status, { timeout: 60_000 }).toBe("stalled");
  await expect(outcome.getByTestId("inbox-mission-stop")).toBeVisible({ timeout: 30_000 });
  await expect(outcome.getByTestId("inbox-mission-wakes")).toHaveText("起きた回数 2/6 回");
  await outcome.getByTestId("inbox-mission-stop").click();
  await expect.poll(async () => (await mission())?.status, { message: "カードの「終える」が効かない" }).toBe("stopped");
  await expect(outcome.getByTestId("inbox-mission-now")).toHaveText("いまは：止めました");
  for (const r of await reviews()) await page.request.post(`${CORE_BASE_URL}/api/inbox/${r.id}/acknowledge`, { headers });

  // ---- 4. 任務を持つ会話の「決めることがある」カードの「枠を延ばす」 ------------------------------------------------------------
  const started = await page.request.post(`${CORE_BASE_URL}/api/threads/${baseId}/mission`, {
    headers,
    data: { goal: GOAL, doneWhen: DONE_WHEN, maxWakes: 4 },
  });
  expect(started.status(), await started.text()).toBe(201);
  expect((await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/turn-summary`, { headers, data: { enabled: true } })).status()).toBe(200);
  const decide = await page.request.post(`${CORE_BASE_URL}/api/threads/${baseId}/messages`, {
    headers,
    data: {
      prompt:
        "並びを決めて。" +
        fakeTurn({
          say: "案を作りました。",
          tools: [
            {
              server: "banto-thread",
              name: "report_turn",
              args: {
                request: "並びを決める",
                outcome: { status: "partial", headline: "案が2つあります", points: [] },
                decisions: [{ question: "どちらの並びにしますか", options: [{ label: "案A", reply: "案A で。" }, { label: "案B", reply: "案B で。" }] }],
              },
            },
          ],
        }),
    },
  });
  expect(decide.status(), await decide.text()).toBe(200);
  await waitTurnEnded(page, baseId, (await get<{ messages: Array<{ role: string }> }>(`/api/threads/${baseId}`)).messages.filter((m) => m.role === "assistant").length);
  const decideCard = inbox.getByTestId("inbox-section-decide").getByTestId("inbox-review");
  await expect(decideCard, "決めることのカードが出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(decideCard.getByTestId("inbox-turn-option")).toHaveText(["案A", "案B"]);
  const extendRow = decideCard.getByTestId("inbox-decision-mission");
  await expect(extendRow).toContainText("任務の枠：0/4 回");
  await extendRow.getByTestId("inbox-decision-mission-extend").click();
  await expect(extendRow.getByTestId("mission-extend-field-maxWakes")).toHaveValue("4");
  await extendRow.getByTestId("mission-extend-field-maxWakes").fill("8");
  await extendRow.getByRole("button", { name: "この枠に延ばす" }).click();
  await expect(extendRow).toContainText("任務の枠：0/8 回", { timeout: 15_000 });
  expect(await mission(), "決めることのカードで延ばした枠が host に無い").toMatchObject({ status: "active", frame: { maxWakes: 8 } });

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
  // 後の spec に受信箱と任務を持ち越さない
  await page.request.patch(`${CORE_BASE_URL}/api/threads/${baseId}/mission`, { headers, data: { stop: true } });
  for (const item of await get<InboxItem[]>("/api/inbox")) {
    if (item.kind === "notice" || item.kind === "review") await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
  }
});
