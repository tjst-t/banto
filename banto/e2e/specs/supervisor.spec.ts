// **番頭**（アーキ仕様 §4.5「番頭の作り」「問いの種類」、Backlog #507）。
//
// 1つの Project（まとめをオン）に番頭を API で置き、Base Thread のターンがまとめで決めることを出すたびに番頭が動くのを見る
// （host の記録で。画面は Backlog の §6.54 の仕事）。番頭の手順は Project の方針の文に書く（番頭の回に届く文は host が組むので）：
//   0. 番頭は専用の Fork 1本（番頭の印つき）に自動化4件。自動化の一覧には出ない
//   1. 手順（kind: rerun-tests）の問い→番頭が answer_decision で選び、元の会話に「番頭が選んだ答え」が届いて続く。記録に「選んだ」
//   2. 仕様の向き（kind: spec）の問い→host が番頭の選択を断り、何も届かず、カードは人に残る（揃わず人に回った）。記録に「断られた」
//   3.（Backlog #508）失敗したターンで止まった会話を、番頭の見回りの回が list_stalled_threads で見つけ、instruct_thread（retry-turn）で
//      頼み、その会話のターンが進む。届けものは番頭の印つき、記録に「頼んだ」、受信箱のカードに「番頭が頼んだ」
import type { Page } from "@playwright/test";
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN, FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn } from "../helpers.js";

test.setTimeout(300_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const PROJECT_NAME = "E2E Supervisor";
const CONTINUED = "番頭の答えで流し直しました";

type Message = { seq: number; role: string; text: string; origin?: { from: string; title: string; hop: number } };
type Thread = { restriction?: string; messages: Message[]; lastTurn?: { turnId: string; outcome?: string } };
type Judge = { kind: string; automation: { id: string; name: string }; answered?: number; total?: number };
type InboxItem = { kind: string; threadId: string; judge?: Judge };
type Run = { runId: string; result: string; cause: string };
type Act = { kind: string; threadId: string; question?: number; choice?: number; decisionKind?: string; reason: string };
type Supervisor = {
  id: string;
  threadId: string;
  paused: boolean;
  automations: Array<{ id: string; name: string; source: { kind: string; event?: string }; target: { threadId?: string }; runs: Run[] }>;
  acts: Act[];
};

const summary = (n: number, kind: string) => ({
  request: `試験を通す（${n}）`,
  outcome: { status: "partial", headline: `試験が1つ落ちた（${n}）`, points: [] },
  decisions: [
    {
      question: `どうしますか（${n}）`,
      kind,
      options: [
        // 元の会話の偽の AI は、届いた答えの「」の語をそのまま返す（fake-runner の既定の返事）
        { label: "流し直す", reply: `試験を流し直して。「${CONTINUED}」と返して`, recommended: true },
        { label: "待つ", reply: "待って" },
      ],
    },
  ],
});

const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Record<string, unknown> };
};

/** **人の口**（番頭を置く・消す・方針を書く・今すぐ見回るは人のセッションだけ）——ログインしたブラウザの文脈から呼ぶ */
const humanCall = (page: Page) => async (path: string, method: string, body?: unknown) => {
  const res = await page.context().request.fetch(`${CORE_BROWSER_URL}${path}`, {
    method,
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(body !== undefined ? { data: body } : {}),
  });
  const text = await res.text();
  return { status: res.status(), text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

test("番頭は手順の問いに答えて元の会話を進め、仕様の向きの問いは host に断られて人に残る", async ({ page }) => {
  const human = humanCall(page);
  const project = (await call("/api/projects", { method: "POST", body: { name: PROJECT_NAME, root: mkdtempSync(join(tmpdir(), "banto-e2e-supervisor-")) } })).body as { id: string };
  const base = (await call(`/api/projects/${project.id}/threads`, { method: "POST" })).body as { id: string };
  expect(base.id, "Base Thread が立たない").toBeTruthy();
  expect((await call(`/api/projects/${project.id}/turn-summary`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
  // 番頭の手順（偽の AI への指示）は方針の文に書く——届いた出来事の問いに選択肢 1 で答える
  const plan = fakeTurn({
    tools: [
      {
        server: "banto-thread",
        name: "answer_decision",
        args: { thread: "$eventField:thread", turnId: "$eventField:turnId", question: 1, choice: 1, reason: "手順なので流し直す" },
      },
    ],
  });
  // 機械の合言葉では書けない（人の画面だけ）
  expect((await call(`/api/projects/${project.id}/supervisor-policy`, { method: "PUT", body: { note: "x" } })).status).toBe(403);
  const policy = await human(`/api/projects/${project.id}/supervisor-policy`, "PUT", { note: `番頭の手順。${plan}` });
  expect(policy.status, policy.text).toBe(200);

  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Thread;
  const inbox = async () => (await call("/api/inbox")).body as unknown as InboxItem[];
  const baseCard = async () => (await inbox()).find((i) => i.kind === "review" && i.threadId === base.id);
  const supervisor = async () => (await call(`/api/projects/${project.id}/supervisor`)).body as unknown as Supervisor;
  const decideRuns = async () => (await supervisor()).automations.find((a) => a.source.event === "banto.turn-decisions")!.runs;
  /** 人が Base Thread で送り、そのターンが終わるまで読み切る */
  const send = async (prompt: string) => {
    const res = await call(`/api/threads/${base.id}/messages`, { method: "POST", body: { prompt } });
    expect(res.status, res.text).toBe(200);
    expect((await thread(base.id)).lastTurn?.outcome).toBe("completed");
  };
  const decide = (n: number, kind: string) =>
    send(`試験を通して（${n}）` + fakeTurn({ say: `止まりました（${n}）`, tools: [{ server: "banto-thread", name: "report_turn", args: summary(n, kind) }] }));
  const answers = async () => (await thread(base.id)).messages.filter((m) => m.origin?.title === "番頭が選んだ答え");

  // ---- 0. 番頭を置く ----------------------------------------------------------------------------------------
  expect((await call(`/api/projects/${project.id}/supervisor`, { method: "POST", body: {} })).status, "機械の合言葉で番頭を置けた").toBe(403);
  const created = await human(`/api/projects/${project.id}/supervisor`, "POST", {});
  expect(created.status, created.text).toBe(201);
  const s = created.body as unknown as Supervisor;
  expect(s.automations.map((a) => a.source.event ?? a.source.kind)).toEqual(["banto.turn-decisions", "factory.item-stopped", "factory.run-finished", "time"]);
  expect(new Set(s.automations.map((a) => a.target.threadId))).toEqual(new Set([s.threadId]));
  expect((await thread(s.threadId)).restriction, "番頭の Fork に番頭の印が無い").toBe("supervisor");
  expect(((await call(`/api/projects/${project.id}/automations`)).body.automations as unknown[]).length, "番頭の自動化が自動化の一覧に出た").toBe(0);
  expect((await human(`/api/projects/${project.id}/supervisor`, "POST", {})).status, "2つ目の番頭を置けた").toBe(409);

  try {
    // ---- 1. 手順の問い→番頭が選び、元の会話が進む ---------------------------------------------------------------
    await decide(1, "rerun-tests");
    const decidedTurn = (await thread(base.id)).lastTurn!.turnId;
    // 出来事は30秒まとめてから届く
    await expect.poll(async () => (await decideRuns()).map((r) => r.result), { timeout: 120_000, message: "番頭が動かない" }).toEqual(["done"]);
    await expect.poll(async () => (await answers()).length, { timeout: 60_000, message: "番頭の答えが元の会話に届かない" }).toBe(1);
    const delivered = (await answers())[0]!;
    expect(delivered.text).toContain("どうしますか（1）");
    expect(delivered.text).toContain("選んだもの：流し直す");
    expect(delivered.text).toContain("理由：手順なので流し直す");
    expect(delivered.text, "選ばなかった選択肢が届いた").not.toContain("待って");
    await expect
      .poll(async () => {
        const t = await thread(base.id);
        return t.lastTurn?.turnId !== decidedTurn && t.lastTurn?.outcome === "completed"
          ? t.messages.filter((m) => m.seq > delivered.seq && m.role === "assistant").map((m) => m.text)
          : undefined;
      }, { timeout: 60_000, message: "元の会話が番頭の答えで続かない" })
      .toEqual([CONTINUED]);
    const answered = (await supervisor()).acts;
    expect(answered.map((a) => [a.kind, a.decisionKind, a.choice])).toEqual([["answered", "rerun-tests", 1]]);
    // 番頭の会話はまとめを出さない（決めることも出ない）
    expect((await thread(s.threadId)).messages.some((m) => m.text.includes("report_turn")), "番頭の会話がまとめを出した").toBe(false);

    // ---- 2. 仕様の向きの問い→断られて人に残る ----------------------------------------------------------------------
    await decide(2, "spec");
    await expect.poll(async () => (await decideRuns()).map((r) => r.result), { timeout: 120_000, message: "番頭が2回目に動かない" }).toEqual(["done", "done"]);
    await expect.poll(async () => (await supervisor()).acts.map((a) => a.kind), { message: "断った記録が無い" }).toEqual(["refused", "answered"]);
    const refused = (await supervisor()).acts[0]!;
    expect(refused.decisionKind).toBe("spec");
    expect(refused.reason).toContain("人が決めます");
    const said = (await thread(s.threadId)).messages.filter((m) => m.role === "assistant").at(-1)!.text;
    expect(said, "番頭に断りの理由が返っていない").toContain("番頭はこの問いを選べません");
    // 何も届かず、カードは人に残る（揃わずに人に回った）
    await expect.poll(async () => (await baseCard())?.judge?.kind, { message: "カードに「人に回った」が付かない" }).toBe("incomplete");
    expect(await answers(), "断ったのに届いた").toHaveLength(1);
    expect((await thread(base.id)).lastTurn?.outcome).toBe("completed");
  } finally {
    // 同じ core で後に流れる spec に番頭を残さない
    expect((await human(`/api/projects/${project.id}/supervisor`, "DELETE")).status).toBe(200);
  }
});

test("番頭の見回りは、失敗したターンで止まった会話を list_stalled_threads で見つけ、instruct_thread（retry-turn）で頼んで進める", async ({ page }) => {
  const human = humanCall(page);
  const project = (await call("/api/projects", { method: "POST", body: { name: `${PROJECT_NAME} 見回り`, root: mkdtempSync(join(tmpdir(), "banto-e2e-supervisor-patrol-")) } })).body as { id: string };
  const base = (await call(`/api/projects/${project.id}/threads`, { method: "POST" })).body as { id: string };
  expect(base.id, "Base Thread が立たない").toBeTruthy();
  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Thread;
  const supervisor = async () => (await call(`/api/projects/${project.id}/supervisor`)).body as unknown as Supervisor;
  const patrolRuns = async () => (await supervisor()).automations.find((a) => a.source.kind === "time")!.runs;
  /** 番頭の手順（偽の AI への指示）を方針の文に書く */
  const plan = async (tools: Array<{ name: string; args: Record<string, unknown> }>) => {
    const res = await human(`/api/projects/${project.id}/supervisor-policy`, "PUT", {
      note: `番頭の手順。${fakeTurn({ tools: tools.map((t) => ({ server: "banto-thread", ...t })) })}`,
    });
    expect(res.status, res.text).toBe(200);
  };
  /** 今すぐ見回り、その回が終わるまで待つ。番頭の最後の発言（最後の tool の結果）を返す */
  const patrol = async (n: number) => {
    const res = await human(`/api/projects/${project.id}/supervisor/patrol`, "POST");
    expect(res.status, res.text).toBe(202);
    await expect.poll(async () => (await patrolRuns()).filter((r) => r.result === "done").length, { timeout: 60_000, message: `見回りの ${n} 回目が終わらない` }).toBe(n);
    const s = await supervisor();
    return (await thread(s.threadId)).messages.filter((m) => m.role === "assistant").at(-1)!.text;
  };

  // ---- 失敗したターンで止まった会話 ----------------------------------------------------------------------------
  const failed = await call(`/api/threads/${base.id}/messages`, { method: "POST", body: { prompt: `試験を通して${fakeTurn({ say: "試験を流します", fail: "API が途中で落ちた" })}` } });
  expect(failed.status, failed.text).toBe(200);
  await expect.poll(async () => (await thread(base.id)).lastTurn?.outcome, { message: "失敗したターンで終わらない" }).toBe("failed");
  const failedTurn = (await thread(base.id)).lastTurn!.turnId;

  // 機械の合言葉では今すぐ見回れない
  const created = await human(`/api/projects/${project.id}/supervisor`, "POST", {});
  expect(created.status, created.text).toBe(201);
  expect((await call(`/api/projects/${project.id}/supervisor/patrol`, { method: "POST" })).status).toBe(403);

  try {
    // ---- 1. 見回り：止まった会話を見つける ----------------------------------------------------------------------
    await plan([{ name: "list_stalled_threads", args: {} }]);
    const listed = JSON.parse(await patrol(1)) as Array<{ threadId: string; reason: string; title: string }>;
    expect(listed.map((t) => [t.threadId, t.reason])).toEqual([[base.id, "failed-turn"]]);
    // 見つけただけでは何も起きない
    expect((await thread(base.id)).lastTurn?.turnId).toBe(failedTurn);
    expect((await supervisor()).acts).toEqual([]);

    // ---- 2. 見回り：retry-turn を頼む→その会話のターンが進む ------------------------------------------------------
    await plan([
      { name: "list_stalled_threads", args: {} },
      // 偽の AI は届いた文の「」の語をそのまま返す（fake-runner の既定の返事）——番頭の補足（note）に書く
      { name: "instruct_thread", args: { threadId: base.id, action: "retry-turn", note: "「やり直して通しました」と返して", reason: "API が落ちて失敗したのでやり直す" } },
    ]);
    expect(await patrol(2)).toContain("頼みました（失敗した・途中で切れたターンをやり直す）");
    await expect
      .poll(async () => {
        const t = await thread(base.id);
        return t.lastTurn?.turnId !== failedTurn && t.lastTurn?.outcome === "completed" ? t.messages.filter((m) => m.role === "assistant").at(-1)?.text : undefined;
      }, { timeout: 60_000, message: "番頭の指示でその会話が進まない" })
      .toBe("やり直して通しました");
    const t = await thread(base.id);
    const instruction = t.messages.find((m) => m.origin?.title?.startsWith("番頭の指示"))!;
    expect(instruction.origin?.title).toBe("番頭の指示：失敗した・途中で切れたターンをやり直す");
    expect(instruction.origin?.hop, "人のターン（0）＋2").toBe(2);
    expect(instruction.text).toContain("同じ頼みをやり直してください");
    expect(instruction.text, "番頭の補足を指示の文に混ぜた").not.toContain("やり直して通しました");
    const origin = (instruction.origin as unknown as { supervisor?: { supervisorId: string; actionId: string; note?: string }; automation?: unknown });
    expect(origin.supervisor?.supervisorId).toBe((await supervisor()).id);
    expect(origin.supervisor?.note).toBe("「やり直して通しました」と返して");
    expect(origin.automation, "番頭の指示に origin.automation を付けた").toBeUndefined();

    // 記録に「頼んだ」
    const acts = (await supervisor()).acts as Array<Act & { action?: string; stalledReason?: string; hasNote?: boolean; actionId?: string }>;
    expect(acts.map((a) => [a.kind, a.threadId, a.action, a.stalledReason, a.hasNote])).toEqual([["instructed", base.id, "retry-turn", "failed-turn", true]]);
    expect(acts[0]!.actionId).toBe(origin.supervisor?.actionId);
    // 受信箱：やり直したターンのカードに「番頭が頼んだ」を引き継ぐ
    await expect
      .poll(async () => {
        const card = ((await call("/api/inbox")).body as unknown as Array<{ kind: string; threadId: string; carriedJudge?: { kind: string; instruction?: { action: string } } }>).find(
          (i) => i.kind === "review" && i.threadId === base.id,
        );
        return card?.carriedJudge ? [card.carriedJudge.kind, card.carriedJudge.instruction?.action] : undefined;
      }, { message: "カードに番頭の指示が付かない" })
      .toEqual(["instructed", "retry-turn"]);

    // ---- 3. もう止まっていない会話は一覧に出ない ----------------------------------------------------------------------
    await plan([{ name: "list_stalled_threads", args: {} }]);
    expect(await patrol(3)).toBe("止まっている会話はありません。");
  } finally {
    expect((await human(`/api/projects/${project.id}/supervisor`, "DELETE")).status).toBe(200);
  }
});
