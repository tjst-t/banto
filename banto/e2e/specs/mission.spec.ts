// **任務**（アーキ仕様 §4.4「任務」・v4-frontend.md §6.47、Backlog #421）。
//
// 1つの Project（まとめをオン・「承認をすべて自動で許可する」もオン）の Base Thread で、見ること（画面と host の記録で）：
//   1. AI が start_mission を呼ぶと、自動で許可がオンでも会話に確認のカードが出る（目標・終わりの条件・枠の3つの欄・「始める」
//      「始めない」）。欄で枠を変えて「始める」を押すと、その枠で任務が始まる（答える前には無い）
//   2. schedule_followup（時刻）で予約した時刻に、任務の届けもので起きる（1回目・きっかけ「時刻」）。起きた回は何も無く終わった
//      ので、受信箱に新しいカードは出ない
//   3. 1回目の中で schedule_followup（出来事 banto.turn-decisions、別の Fork の会話）を予約し、その Fork で決めることのある
//      ターンが終わると、出来事の中身を添えて起きる（2回目・きっかけ「出来事」）
//   4. 2回目の中で finish_mission を呼ぶと任務が終わり、受信箱の返ってきた会話のカードに結末（終わった・結果・起きた回数）が添わる
//
// 偽の Runner への指示は、届ける文（予約のメモ）の中に入れ子にする——外側の指示の中の印は `[` で書き、読んだ時点で
// 内側の指示に戻る（`fake-runner.ts` は最後の印を読むので、入れ子のまま書くと外側のターンが内側の指示を読んでしまう）
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";
import { FAKE_RUNNER_MARKER, type FakePlan } from "../fake-runner.js";

test.setTimeout(240_000);

const PROJECT_NAME = "E2E Mission";
const GOAL = "PR の CI を通す";
const DONE_WHEN = "main の CI が緑になった";
const RESULT = "判断の Fork の決めることが出たのを確かめました";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Mission = {
  id: string;
  status: string;
  wakes: number;
  frame: { maxWakes: number; until: string; minIntervalMinutes: number };
  followup?: { at?: string; note: string; event?: { name: string; where?: Record<string, unknown> } };
  history: Array<{ wake: number; cause: string; result?: string }>;
  result?: string;
};
type ThreadDetail = {
  messages: Array<{
    seq: number;
    role: string;
    text: string;
    origin?: { from: string; title: string; hop: number; mission?: { id: string; wake: number; maxWakes?: number; note?: string }; external?: Array<{ event?: { name: string; fields: Record<string, unknown> } }> };
  }>;
  lastTurn?: { outcome?: string };
};
type InboxItem = { id: string; kind: string; threadId?: string; mission?: { status: string; result?: string; wakes: number; maxWakes: number; goal: string } };

/** 入れ子にできる指示（中の印を `[` にして、外側の指示の印と見分ける） */
function nestedTurn(plan: FakePlan): string {
  const json = JSON.stringify(plan).replaceAll(FAKE_RUNNER_MARKER, "\\u005b\\u005bfake-runner]]");
  return `\n${FAKE_RUNNER_MARKER}${json}`;
}

/** まとめ（決めることなし）——任務の会話では予約か終わりのあとに呼ぶ */
const summary = (request: string, headline: string) => ({
  server: "banto-thread",
  name: "report_turn",
  args: { request, outcome: { status: "done", headline, points: [] }, decisions: [] },
});

test("任務：承認のカードで枠を変えて始め、時刻と出来事の予約で2回起き、finish_mission で受信箱に結末が出る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const get = async <T,>(path: string) => (await (await page.request.get(`${CORE_BASE_URL}${path}`, { headers })).json()) as T;

  await openApp(page);
  // 人が「会話を離れる」先（開いている会話のカードは画面が「見た」にして受信箱から外す）
  await createProject(page, `${PROJECT_NAME} 別`, mkdtempSync(join(tmpdir(), "banto-e2e-mission-other-")));
  const elsewhere = currentProjectId(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-mission-")));
  const projectId = currentProjectId(page);
  const baseId = (await get<Array<{ id: string; kind: string }>>(`/api/projects/${projectId}/threads`)).find((t) => t.kind === "base")!.id;
  expect((await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/turn-summary`, { headers, data: { enabled: true } })).status()).toBe(200);
  expect((await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/auto-approve`, { headers, data: { enabled: true } })).status()).toBe(200);
  // 出来事を出す側の会話（決めることのあるターンが終わると banto.turn-decisions が出る）
  const forked = await page.request.post(`${CORE_BASE_URL}/api/threads/${baseId}/fork`, { headers, data: { fresh: true, title: "判断の Fork" } });
  expect(forked.status(), await forked.text()).toBe(201);
  const forkId = ((await forked.json()) as { id: string }).id;
  const mission = async () => (await get<{ mission: Mission | null }>(`/api/threads/${baseId}/mission`)).mission;
  const baseReviews = async () => (await get<InboxItem[]>("/api/inbox")).filter((i) => i.kind === "review" && i.threadId === baseId);

  // 2回目（出来事で起きた回）：終える
  const second = nestedTurn({
    say: "判断が出たので、任務を終えます。",
    tools: [
      { server: "banto-thread", name: "finish_mission", args: { status: "done", result: RESULT } },
      summary("CI を通す任務の2回目", "任務を終えました"),
    ],
  });
  // 1回目（時刻で起きた回）：判断の Fork の出来事を待つ予約をする
  const first = nestedTurn({
    say: "1回目に起きました。判断の Fork を待ちます。",
    tools: [
      {
        server: "banto-thread",
        name: "schedule_followup",
        args: { event: { name: "banto.turn-decisions", where: { thread: forkId } }, note: second },
      },
      summary("CI を通す任務の1回目", "判断の Fork を待つ予約をしました"),
    ],
  });

  await page.goto(`/p/${projectId}`);
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveText("自動で許可中", { timeout: 30_000 });
  const composer = page.getByPlaceholder(/に送る/);
  const cards = page.locator('[data-role="judgment-card"]');

  // ---- 1. 始める：自動で許可がオンでもカードで聞き、欄で変えた枠で始まる ----------------------------------------------
  const at = new Date(Date.now() + 20_000).toISOString();
  await composer.fill(
    "CI が通るまで見ていて。" +
      nestedTurn({
        say: "任務にして見ていきます。",
        tools: [
          { server: "banto-thread", name: "start_mission", args: { goal: GOAL, doneWhen: DONE_WHEN } },
          { server: "banto-thread", name: "schedule_followup", args: { at, note: first } },
          summary("CI が通るまで見る", "任務を始めて、最初の予約をしました"),
        ],
      }),
  );
  await composer.press("Enter");
  const card = cards.filter({ hasText: "この任務を始めてよいですか" });
  await expect(card, "自動で許可がオンなのに、任務を始めるカードが出ない").toHaveCount(1, { timeout: 60_000 });
  // カードが提示している中身（規則14）——目標・終わりの条件・枠の3つの欄（既定の値）・ボタン
  await expect(card).toContainText(GOAL);
  await expect(card).toContainText(DONE_WHEN);
  await expect(card.getByTestId("judgment-field-maxWakes")).toHaveValue("20");
  await expect(card.getByTestId("judgment-field-untilDays")).toHaveValue("3");
  await expect(card.getByTestId("judgment-field-minInterval")).toHaveValue("15");
  await expect(card.getByRole("button", { name: "始める", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "始めない", exact: true })).toBeVisible();
  expect(await mission(), "人が答える前に任務が始まっている").toBeNull();
  // 欄が決まりに合わなければ「始める」は押せない
  await card.getByTestId("judgment-field-maxWakes").fill("500");
  await expect(card.getByTestId("judgment-field-problem")).toContainText("100 以下");
  await expect(card.getByRole("button", { name: "始める", exact: true })).toBeDisabled();
  await card.getByTestId("judgment-field-maxWakes").fill("4");
  await card.getByTestId("judgment-field-minInterval").fill("0");
  await card.getByRole("button", { name: "始める", exact: true }).click();
  await expect(card).toContainText("回答：始める", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 1, 60_000);
  const started = (await mission())!;
  expect(started).toMatchObject({ status: "active", wakes: 0, frame: { maxWakes: 4, minIntervalMinutes: 0 } });
  expect(started.followup?.at, "最初の予約が残っていない").toBe(at);
  // 人は会話を離れて別の Project の会話にいる（開いている会話のカードは画面が「見た」にする——Fork を開くと Base も隣に出る。
  // 前は `/settings` に移していたが、受信箱で結末を読んでいる間に Base の会話が開いてカードが消えた——失敗時の画面の写しに
  // Base の会話が出ていた）。人が送ったターンのカードは片づけておく
  await page.goto(`/p/${elsewhere}`);
  await expect(page.getByPlaceholder(`${PROJECT_NAME} 別 の Base Thread に送る`)).toBeVisible({ timeout: 30_000 });
  for (const r of await baseReviews()) await page.request.post(`${CORE_BASE_URL}/api/inbox/${r.id}/acknowledge`, { headers });
  expect(await mission(), "片づけている間に1回目が起きた（予約の時刻を延ばす）").toMatchObject({ wakes: 0 });

  // ---- 2. 時刻で1回目に起きる。何も無く終わった回は受信箱に出さない --------------------------------------------------
  await expect
    .poll(async () => {
      const m = await mission();
      return m ? `${m.wakes}:${m.history[0]?.cause}:${m.history[0]?.result ?? "-"}:${m.followup?.event?.name ?? "-"}` : "none";
    }, { timeout: 90_000, message: "予約の時刻に起きない（または1回目が出来事の予約をしない）" })
    .toBe("1:time:done:banto.turn-decisions");
  let thread = await get<ThreadDetail>(`/api/threads/${baseId}`);
  const wake1 = thread.messages.find((m) => m.origin?.mission?.wake === 1)!;
  expect(wake1.origin).toMatchObject({ from: "banto", hop: 0, title: `任務「${GOAL}」（1/4 回目）` });
  expect(wake1.text).toContain(`目標：${GOAL}`);
  expect(wake1.text).toContain("きっかけ：予約した時刻になりました。");
  expect(thread.messages.filter((m) => m.role === "assistant").map((m) => m.text)).toContain("1回目に起きました。判断の Fork を待ちます。");
  expect(await baseReviews(), "何も無く終わった任務の回が受信箱に出た").toEqual([]);

  // ---- 3. 判断の Fork で決めることのあるターンが終わると、出来事で2回目に起きる -------------------------------------------
  const decide = await page.request.post(`${CORE_BASE_URL}/api/threads/${forkId}/messages`, {
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
                decisions: [
                  {
                    question: "どちらの並びにしますか",
                    options: [
                      { label: "案A", reply: "案A で。" },
                      { label: "案B", reply: "案B で。" },
                    ],
                  },
                ],
              },
            },
          ],
        }),
    },
  });
  expect(decide.status(), await decide.text()).toBe(200);

  // ---- 4. 2回目で finish_mission → 受信箱の返ってきた会話のカードに結末 ------------------------------------------------
  await expect
    .poll(async () => {
      const m = await mission();
      return m ? `${m.status}:${m.wakes}:${m.history[0]?.cause}` : "none";
    }, { timeout: 90_000, message: "出来事で起きない（または2回目が任務を終えない）" })
    .toBe("done:2:event");
  expect((await mission())!.result).toBe(RESULT);
  thread = await get<ThreadDetail>(`/api/threads/${baseId}`);
  const wake2 = thread.messages.find((m) => m.origin?.mission?.wake === 2)!;
  expect(wake2.text).toContain("きっかけ：待っていた出来事が来ました");
  expect(wake2.origin?.external?.[0]?.event).toMatchObject({ name: "banto.turn-decisions", fields: { thread: forkId } });
  await expect
    .poll(async () => (await baseReviews()).find((r) => r.mission)?.mission, { timeout: 30_000, message: "受信箱に任務の結末が出ない" })
    .toMatchObject({ status: "done", result: RESULT, wakes: 2, maxWakes: 4, goal: GOAL });
  // 返ってきた会話のカードは受信箱の画面にも出ている（別の Project の会話から開く）。結末の見せ方は
  // 任務の画面（v4-frontend.md §6.47、Backlog #422）
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const returned = page.getByRole("dialog", { name: "受信箱" }).getByTestId("inbox-section-returned").getByTestId("inbox-review");
  await expect(returned.filter({ hasText: "任務を終えました" }), "受信箱に返ってきた会話のカードが出ない").toHaveCount(1, { timeout: 30_000 });
  // カードに添えた結末（v4-frontend.md §6.47）。終わった任務に「延ばす」「終える」は出ない
  const outcome = returned.filter({ hasText: "任務を終えました" }).getByTestId("inbox-mission");
  await expect(outcome.getByTestId("inbox-mission-status")).toHaveText("任務が終わりました");
  await expect(outcome.getByTestId("inbox-mission-goal")).toHaveText(`任務：${GOAL}`);
  await expect(outcome.getByTestId("inbox-mission-result")).toHaveText(RESULT);
  await expect(outcome.getByTestId("inbox-mission-wakes")).toHaveText("起きた回数 2/4 回");
  await expect(outcome.getByRole("button")).toHaveCount(0);
  // 任務で起きた回は、会話の頭に薄い1行（上限と前の予約のメモ）。届いたもののカードには出さない
  expect(wake1.origin?.mission, "起きた回の印に上限とメモが無い").toMatchObject({ wake: 1, maxWakes: 4, note: expect.stringContaining("1回目に起きました") });
  await page.goto(`/p/${projectId}`);
  const wakeLines = page.getByTestId("mission-wake-text");
  await expect(wakeLines).toHaveCount(2, { timeout: 30_000 });
  await expect(wakeLines.nth(0)).toContainText("任務で起きました（1/4 回目）——前の予約：");
  await expect(wakeLines.nth(1)).toContainText("任務で起きました（2/4 回目）——前の予約：");
  await expect(wakeLines.nth(1)).toContainText("判断が出たので");
  await expect(page.getByTestId("delivered-message").filter({ hasText: "任務「" })).toHaveCount(0);
  // 終わった任務の札は出さない
  await expect(page.getByTestId("mission-badge")).toHaveCount(0);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
  // 後の spec に受信箱を持ち越さない
  for (const item of await get<InboxItem[]>("/api/inbox")) {
    if (item.kind === "notice" || item.kind === "review") await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
  }
});
