// **banto.turn-decisions と判断役**（アーキ仕様 §4.3「`banto.turn-decisions` と判断役」、Backlog #348）。
//
// 1つの Project（まとめをオン・「承認をすべて自動で許可する」もオン）に判断役（banto.turn-decisions を待つ自動化、専用の Fork）を
// 作り、Base Thread のターンがまとめで決めることを出すたびに判断役が動くのを見る（host の記録で。画面は Backlog #349）：
//   0. 判断役の届け先に既存の Thread は選べない。作るときの案内に「自動許可は判断役の会話には効かない」
//   1. 判断役が answer_decision で選ぶ→元の会話に、選んだ選択肢の reply が「判断役が選んだ答え」として届き、元の会話が続く。
//      カードは「判断役が決めました」になり、続いたターンのカードに引き継がれる
//   2. 判断役が人に任せる→何も届かない。カードに「人に任せました：理由」
//   3. 判断役の会話の tool の承認は、自動許可がオンでも聞かれる（判断待ちが答えられずに残る）。聞かれている間に人が元の会話で
//      答えたら、判断役の answer_decision は「人がもう答えました」で断られ、何も届かない
import { test, expect } from "../test-base.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { fakeTurn } from "../helpers.js";

test.setTimeout(300_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const PROJECT_NAME = "E2E Turn Decisions";
const JUDGE = "判断役";
const CONTINUED = "判断役の答えで進めました";

type Message = { seq: number; role: string; text: string; origin?: { from: string; title: string; hop: number } };
type Thread = { messages: Message[]; lastTurn?: { turnId: string; outcome?: string } };
type Judge = { kind: string; automation: { name: string }; answers?: Array<{ question: number; choice: number; label: string; reason: string }>; reason?: string };
type InboxItem = {
  kind: string;
  id: string;
  threadId: string;
  liveness?: string;
  message?: string;
  judge?: Judge;
  carriedJudge?: Judge;
  judgeWatching?: { name: string };
};
type Automation = { id: string; target: { threadId?: string }; runs: Array<{ runId: string; result: string; cause: string }> };

const summary = (n: number) => ({
  request: `並びを決める（${n}）`,
  outcome: { status: "partial", headline: `案を2つ作った（${n}）`, points: [] },
  decisions: [
    {
      question: `どちらの並びにしますか（${n}）`,
      options: [
        { label: "案A", reply: "案A で進めて。", recommended: true },
        // 元の会話の偽の AI は、届いた答えの「」の語をそのまま返す（fake-runner の既定の返事）
        { label: "案B", reply: `案B で進めて。「${CONTINUED}」と返して` },
      ],
    },
  ],
});

/** Event Store に積まれた出来事（判断役の答えがカードに付いた記録を見る） */
function storedEvents(type: string): Array<{ payload: Record<string, unknown> }> {
  return readFileSync(join(DATA_DIR, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes(`"${type}"`))
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

test("判断役が選ぶと元の会話に答えが届いて続き、人に任せると何も届かず、人が先に答えたら断られる。判断役の会話の承認は自動許可でも聞かれる", async ({ page }) => {
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${CORE_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const project = (await call("/api/projects", { method: "POST", body: { name: PROJECT_NAME, root: mkdtempSync(join(tmpdir(), "banto-e2e-turn-decisions-")) } })).body as { id: string };
  const base = (await call(`/api/projects/${project.id}/threads`, { method: "POST" })).body as { id: string };
  expect(base.id, "Base Thread が立たない").toBeTruthy();
  expect((await call(`/api/projects/${project.id}/turn-summary`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
  expect((await call(`/api/projects/${project.id}/auto-approve`, { method: "PUT", body: { enabled: true } })).status).toBe(200);

  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Thread;
  const inbox = async () => (await call("/api/inbox")).body as unknown as InboxItem[];
  const baseCard = async () => (await inbox()).find((i) => i.kind === "review" && i.threadId === base.id);
  const api = `/api/projects/${project.id}/automations`;
  const automation = async (id: string) => (await call(`${api}/${id}`)).body as unknown as Automation;
  /** 人が Base Thread で送り、そのターンが終わるまで読み切る */
  const send = async (prompt: string) => {
    const res = await call(`/api/threads/${base.id}/messages`, { method: "POST", body: { prompt } });
    expect(res.status, res.text).toBe(200);
    expect((await thread(base.id)).lastTurn?.outcome).toBe("completed");
  };
  const decide = (n: number) =>
    send(`並びを決めて（${n}）` + fakeTurn({ say: `案を作りました（${n}）`, tools: [{ server: "banto-thread", name: "report_turn", args: summary(n) }] }));
  const answer = (args: Record<string, unknown>) => ({
    server: "banto-thread",
    name: "answer_decision",
    args: { thread: "$eventField:thread", turnId: "$eventField:turnId", question: 1, ...args },
  });
  const setPlan = async (id: string, plan: Parameters<typeof fakeTurn>[0]) => {
    const res = await call(`${api}/${id}`, { method: "PATCH", body: { instruction: "届いた決めることに答えて。" + fakeTurn(plan) } });
    expect(res.status, res.text).toBe(200);
  };
  const decisionDeliveries = async () => (await thread(base.id)).messages.filter((m) => m.origin?.title.startsWith("判断役（自動化"));

  // ---- 0. 判断役を作る ----------------------------------------------------------------------------------
  const source = { kind: "event", event: "banto.turn-decisions", batchSeconds: 0 };
  const onThread = await call(api, { method: "POST", body: { name: "x", instruction: "x", source, target: { kind: "thread", threadId: base.id } } });
  expect(onThread.status).toBe(400);
  expect(onThread.body.error).toContain("専用の Fork だけ");
  const created = await call(api, {
    method: "POST",
    body: { name: JUDGE, instruction: "x", source, target: { kind: "dedicated", mode: "continue" } },
  });
  expect(created.status, created.text).toBe(201);
  expect(created.body.notices).toEqual([expect.stringContaining("判断役の会話には効きません")]);
  const judge = created.body as unknown as Automation;
  const judgeFork = judge.target.threadId!;
  expect(judgeFork, "専用の Fork が立っていない").toBeTruthy();
  const judgeRuns = async () => (await automation(judge.id)).runs.filter((r) => r.cause === "event");

  // ---- 1. 判断役が選ぶ→元の会話に届いて続く -------------------------------------------------------------------
  await setPlan(judge.id, { tools: [answer({ choice: 2, reason: "案B のほうが今の画面に近い" })] });
  await decide(1);
  const decidedTurn = (await thread(base.id)).lastTurn!.turnId;
  await expect.poll(async () => (await judgeRuns()).map((r) => r.result), { timeout: 60_000, message: "判断役が動かない" }).toEqual(["done"]);
  await expect.poll(async () => (await decisionDeliveries()).length, { timeout: 60_000, message: "判断役の答えが元の会話に届かない" }).toBe(1);
  const delivered = (await decisionDeliveries())[0]!;
  expect(delivered.origin!.title).toBe(`判断役（自動化「${JUDGE}」）が選んだ答え`);
  expect(delivered.origin!.hop, "ホップは元のターン＋2").toBe(2);
  expect(delivered.text).toContain("どちらの並びにしますか（1）");
  expect(delivered.text).toContain("選んだもの：案B");
  expect(delivered.text, "判断役の理由が届いていない").toContain("理由：案B のほうが今の画面に近い");
  expect(delivered.text).toContain(`案B で進めて。「${CONTINUED}」と返して`);
  expect(delivered.text, "選ばなかった選択肢が届いた").not.toContain("案A で進めて");
  // 元の会話が判断役の答えで続いた
  await expect
    .poll(async () => {
      const t = await thread(base.id);
      return t.lastTurn?.turnId !== decidedTurn && t.lastTurn?.outcome === "completed" ? t.messages.filter((m) => m.seq > delivered.seq && m.role === "assistant").map((m) => m.text) : undefined;
    }, { timeout: 60_000, message: "元の会話が判断役の答えで続かない" })
    .toEqual([CONTINUED]);
  // カード：決めたターンのカードに「判断役が決めました」が付き、続いたターンのカードがそれを引き継ぐ
  const judged = storedEvents("inbox.review_judged").map((e) => e.payload.judge as Judge);
  expect(judged.map((j) => j.kind)).toEqual(["decided-by-automation"]);
  expect(judged[0]!.answers).toEqual([{ question: 1, choice: 2, label: "案B", reason: "案B のほうが今の画面に近い" }]);
  expect(judged[0]!.automation.name).toBe(JUDGE);
  await expect.poll(async () => (await baseCard())?.carriedJudge?.kind, { message: "続いたターンのカードが判断役の決めを引き継がない" }).toBe("decided-by-automation");
  expect((await baseCard())!.carriedJudge!.answers![0]!.label).toBe("案B");
  expect((await baseCard())!.judge).toBeUndefined();

  // ---- 2. 人に任せる→何も届かない ---------------------------------------------------------------------------
  await setPlan(judge.id, { tools: [answer({ defer: true, reason: "設計の向きを変える" })] });
  await decide(2);
  await expect.poll(async () => (await judgeRuns()).map((r) => r.result), { timeout: 60_000 }).toEqual(["done", "done"]);
  await expect.poll(async () => (await baseCard())?.judge, { message: "カードに「人に任せました」が付かない" }).toEqual(
    expect.objectContaining({ kind: "deferred", reason: "設計の向きを変える", automation: expect.objectContaining({ name: JUDGE }) }),
  );
  expect(await decisionDeliveries(), "人に任せたのに届いた").toHaveLength(1);
  expect((await thread(base.id)).lastTurn?.outcome).toBe("completed");

  // ---- 3. 判断役の会話の承認は聞かれる。その間に人が答えたら断られる -----------------------------------------------------
  await setPlan(judge.id, {
    tools: [{ server: "banto-thread", name: "list_threads", args: {} }, answer({ choice: 1, reason: "おすすめに異論が無い" })],
  });
  await decide(3);
  let approval: InboxItem | undefined;
  await expect
    .poll(async () => (approval = (await inbox()).find((i) => i.kind === "judgment" && i.threadId === judgeFork))?.liveness, {
      timeout: 60_000,
      message: "判断役の会話で承認が聞かれない（自動許可で通った？）",
    })
    .toBe("live");
  expect(approval!.message).toBe("tool呼び出しの承認: mcp__banto-thread__list_threads");
  // 判断役が見ている間は、カードに「判断役が見ています」
  expect((await baseCard())?.judgeWatching).toEqual({ id: judge.id, name: JUDGE });
  // 人が元の会話で先に答える
  await send("案A で");
  expect((await call(`/api/inbox/${approval!.id}/answer`, { method: "POST", body: { answer: { behavior: "allow" } } })).status).toBe(200);
  await expect.poll(async () => (await judgeRuns()).map((r) => r.result), { timeout: 60_000 }).toEqual(["done", "done", "done"]);
  const judgeSaid = (await thread(judgeFork)).messages.filter((m) => m.role === "assistant").at(-1)!.text;
  expect(judgeSaid).toContain("もう進んでいます（人がもう答えました）");
  expect(await decisionDeliveries(), "人が先に答えたのに届いた").toHaveLength(1);
});
