// **自動化の回の受信箱**（アーキ仕様 §4.3「受信箱」、Backlog #317）。
//
// 見ること（host の記録と画面で。自動化の画面は automation-canvas で作るので、作る・動かすは HTTP の口から）：
//   1. 「受信箱に出さない」自動化の、何も無く完了した回は出ない
//   2. 決めること（まとめの decisions）のある回は「出さない」でも出る——受信箱の「決めることがあります」に
//   3. その後に何も無い回が2回終わっても、そのカードは消えず置き換わらない。カードは決めることのある回の中身のまま、
//      「この会話には、まだ見ていない回が 3 回あります」を添える
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp } from "../helpers.js";

test.setTimeout(180_000);

const PROJECT_NAME = "E2E Automation Inbox";
const AUTOMATION_NAME = "毎朝の見回り";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Run = { runId: string; result: string };
type Automation = { id: string; target: { threadId?: string }; runs: Run[] };
type InboxItem = {
  kind: string;
  id: string;
  threadId: string;
  automation?: { runId: string; attention?: string };
  unseenRuns?: number;
  turn?: { reply?: string; summary?: { decisions?: unknown[] } };
};

const PLAIN = "見回りました。変わったことはありません。";
const DECIDE = "見回りました。古い依存が1つあります。";
const summary = {
  request: "毎朝の見回り",
  outcome: { status: "done", headline: "古い依存が1つあります", points: ["lodash が古い"] },
  decisions: [
    {
      question: "lodash を上げますか？",
      options: [
        { label: "上げる", reply: "lodash を上げて。" },
        { label: "今は上げない", reply: "今は上げないで。" },
      ],
    },
  ],
};

test("「出さない」自動化：何も無い回は出ず、決めることのある回は出て、後の何も無い回で消えない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-automation-inbox-")));
  const projectId = currentProjectId(page);
  const api = `${CORE_BASE_URL}/api/projects/${projectId}/automations`;
  const ok = await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/turn-summary`, { headers, data: { enabled: true } });
  expect(ok.status(), await ok.text()).toBe(200);
  const inboxItems = async () => (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as InboxItem[];
  const automation = async (id: string) => (await (await page.request.get(`${api}/${id}`, { headers })).json()) as Automation;
  const setInstruction = async (id: string, instruction: string) => {
    const res = await page.request.patch(`${api}/${id}`, { headers, data: { instruction } });
    expect(res.status(), await res.text()).toBe(200);
  };
  /** 今すぐ動かして、その回が終わる（結末が台帳に出る）まで待つ */
  const runToEnd = async (id: string, result: string) => {
    const res = await page.request.post(`${api}/${id}/run`, { headers });
    expect(res.status(), await res.text()).toBe(202);
    const run = (await res.json()) as Run;
    expect(run.result).toBe("running");
    await expect
      .poll(async () => (await automation(id)).runs.find((r) => r.runId === run.runId)?.result, { timeout: 60_000, message: "回の結末が台帳に出ない" })
      .toBe(result);
    return run.runId;
  };
  const plainInstruction = "見回ってください。" + fakeTurn({ say: PLAIN });
  const decideInstruction =
    "見回ってください。" + fakeTurn({ say: DECIDE, tools: [{ server: "banto-thread", name: "report_turn", args: summary }] });

  const createdRes = await page.request.post(api, {
    headers,
    data: {
      name: AUTOMATION_NAME,
      instruction: plainInstruction,
      source: { kind: "time", repeat: { kind: "daily", time: "9:00" }, timeZone: "Asia/Tokyo" },
      reviewOnDone: false,
    },
  });
  expect(createdRes.status(), await createdRes.text()).toBe(201);
  const created = (await createdRes.json()) as Automation;
  const forkId = created.target.threadId!;
  const forkReviews = async () => (await inboxItems()).filter((i) => i.kind === "review" && i.threadId === forkId);

  // ---- 1. 何も無く完了した回は出ない ------------------------------------------------------------------------
  await runToEnd(created.id, "done");

  // ---- 2. 決めることのある回は出る ---------------------------------------------------------------------------
  await setInstruction(created.id, decideInstruction);
  const decideRun = await runToEnd(created.id, "done");
  await expect.poll(async () => (await forkReviews()).map((r) => r.automation?.runId), { message: "決めることのある回が受信箱に出ない" }).toEqual([decideRun]);
  // 1回目の何も無い回は出ていない（出ていれば2件、または決めることのある回に置き換えられた跡が残る）
  const card = (await forkReviews())[0]!;
  expect(card.automation?.attention).toBe("decisions");
  expect(card.unseenRuns).toBe(1);

  // ---- 3. 後の何も無い回が2回終わっても消えない ---------------------------------------------------------------
  await setInstruction(created.id, plainInstruction);
  await runToEnd(created.id, "done");
  await runToEnd(created.id, "done");
  const after = await forkReviews();
  expect(after.map((r) => r.id), "決めることのあるカードが後の何も無い回で置き換わった").toEqual([card.id]);
  expect(after[0]!.unseenRuns).toBe(3);
  expect(after[0]!.turn?.reply, "残したカードが後の回の中身を出している").toBe(DECIDE);
  expect(after[0]!.turn?.summary?.decisions).toHaveLength(1);

  // ---- 画面：受信箱の「決めることがあります」に1件、決めることのある回の中身と、まだ見ていない回の数 -------------------
  await openApp(page);
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  await expect(inbox).toBeVisible();
  const decideSection = inbox.getByTestId("inbox-section-decide");
  const decideCard = decideSection.getByTestId("inbox-review").filter({ has: page.getByTestId("inbox-card-thread").getByText(AUTOMATION_NAME, { exact: true }) });
  await expect(decideCard, "決めることのある回のカードが出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(decideCard.getByTestId("inbox-card-project")).toHaveText(PROJECT_NAME);
  await expect(decideCard.getByTestId("inbox-turn-request")).toHaveText(summary.request);
  await expect(decideCard.getByTestId("inbox-turn-headline")).toHaveText(summary.outcome.headline);
  await expect(decideCard.getByTestId("inbox-turn-point")).toHaveText(["lodash が古い"]);
  await expect(decideCard.getByTestId("inbox-turn-decision")).toContainText("lodash を上げますか？");
  await expect(decideCard.getByTestId("inbox-turn-option")).toHaveText(["上げる", "今は上げない"]);
  await expect(decideCard.getByTestId("inbox-unseen-runs")).toHaveText("この会話には、まだ見ていない回が 3 回あります");
  await decideCard.getByTestId("inbox-turn-reply-toggle").click();
  await expect(decideCard.getByTestId("inbox-turn-reply")).toContainText(DECIDE);
  // 同じ会話の何も無い回のカードは、返ってきた会話の側にも出ていない
  await expect(
    inbox.getByTestId("inbox-section-returned").getByTestId("inbox-review").filter({ has: page.getByTestId("inbox-card-thread").getByText(AUTOMATION_NAME, { exact: true }) }),
  ).toHaveCount(0);

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
