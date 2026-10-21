// **番頭**（アーキ仕様 §4.5「番頭の作り」「問いの種類」、Backlog #507）。
//
// 1つの Project（まとめをオン）に番頭を API で置き、Base Thread のターンがまとめで決めることを出すたびに番頭が動くのを見る
// （host の記録で。画面は Backlog の §6.54 の仕事）。番頭の手順は Project の方針の文に書く（番頭の回に届く文は host が組むので）：
//   0. 番頭は専用の Fork 1本（番頭の印つき）に自動化4件。自動化の一覧には出ない
//   1. 手順（kind: rerun-tests）の問い→番頭が answer_decision で選び、元の会話に「番頭が選んだ答え」が届いて続く。記録に「選んだ」
//   2. 仕様の向き（kind: spec）の問い→host が番頭の選択を断り、何も届かず、カードは人に残る（揃わず人に回った）。記録に「断られた」
//   3.（Backlog #508）失敗したターンで止まった会話を、番頭の見回りの回が list_stalled_threads で見つけ、instruct_thread（retry-turn）で
//      頼み、その会話のターンが進む。届けものは番頭の印つき、記録に「頼んだ」、受信箱のカードに「番頭が頼んだ」
//   4.（Backlog #509）本物の Subagent・Backlog・Factory（エージェントだけ偽物、factory.spec.ts と同じ）で、番頭の見回りの回が Backlog の
//      ready を runFactory で流す。流した件がテストで止まると、番頭の Factory の出来事の回に止まった件（runId・項目・段・理由）が届き、
//      番頭が方針どおり answerFactory（continue——fix-tests を任されている）で答えて取り込まれる。全体の上限（2件）を超える分は断られる
import type { Page } from "@playwright/test";
import { test, expect } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN, FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, waitForProjectModule } from "../helpers.js";

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

test("番頭の見回りは Backlog の ready を Factory に流し（全体の上限を超える分は断られる）、流した件が止まったら方針どおり answerFactory で答える", async ({ page }) => {
  test.setTimeout(600_000);
  const human = humanCall(page);
  const name = `${PROJECT_NAME} Factory`;
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-supervisor-factory-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@localhost", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "README"), "e2e\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  for (const id of ["backlog", "factory"]) {
    const res = await call(`/api/modules/catalog/${id}`, { method: "POST", body: { name: id } });
    if (res.status >= 300 && !res.text.includes("その名前はもう使われています")) throw new Error(`${id} を目録から入れられませんでした: ${res.status} ${res.text}`);
  }
  const project = (await call("/api/projects", { method: "POST", body: { name, root } })).body as { id: string };
  expect(project.id, "Project が立たない").toBeTruthy();
  // 番頭の専用の Fork は Base Thread から分ける
  expect(((await call(`/api/projects/${project.id}/threads`, { method: "POST" })).body as { id?: string }).id, "Base Thread が立たない").toBeTruthy();
  // Project の Module は使うときに起こす——画面が開くときと同じ口で起こしておく
  const prepared = await call(`/api/projects/${project.id}/modules/prepare`, { method: "POST" });
  expect(prepared.status, prepared.text).toBeLessThan(300);
  for (const m of ["subagent", "backlog", "factory"]) await waitForProjectModule(page, name, m);

  const uiCall = async (server: string, tool: string, args: Record<string, unknown>) => {
    const res = await call(`/api/projects/${project.id}/ui-tool-call`, { method: "POST", body: { server, tool, arguments: args } });
    expect(res.status, `${server}.${tool} が呼べない：${res.text}`).toBe(200);
    const body = res.body as { content?: { text: string }[]; isError?: boolean };
    expect(body.isError, `${server}.${tool} が断った：${body.content?.[0]?.text}`).not.toBe(true);
    return body.content?.[0]?.text ?? "";
  };
  type FactoryRun = { runId: string; items: Array<{ item: string; status: string; stage: string; stopped?: { reason: string } }> };
  const factoryRuns = async () => (JSON.parse(await uiCall("factory", "getRuns", {})) as { runs: FactoryRun[] }).runs;
  const backlogStatus = (id: string) =>
    (JSON.parse(execFileSync("git", ["show", "backlog:tasks.json"], { cwd: root, encoding: "utf8" })) as { items: Array<{ id: string; status: string }> }).items.find((i) => i.id === id)?.status;
  // テストは ok.txt があれば通る。止まった件は実装役が同じ会話の次の頼み（続けて直して）で ok.txt を足す
  await uiCall("factory", "setSettings", {
    settings: { testCommand: "test -f ok.txt", implementer: { agent: "fake" }, reviewer: { agent: "fake" }, limits: { testRetries: 0 } },
  });
  await uiCall("backlog", "boardCreateItem", { id: "sv-fix", kind: "task", title: "a を足す", body: "[commit a.txt] [then-commit ok.txt]", status: "ready" });

  type FactoryMessage = Omit<Message, "origin"> & { origin?: { from: string; title: string; hop: number; external?: Array<{ event?: { name: string; fields: Record<string, unknown> } }> } };
  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Omit<Thread, "messages"> & { messages: FactoryMessage[] };
  type FactoryAct = Act & { runId?: string; items?: string[]; item?: string; stage?: string; action?: string };
  const supervisor = async () => (await call(`/api/projects/${project.id}/supervisor`)).body as unknown as Omit<Supervisor, "acts"> & { acts: FactoryAct[] };
  const lastWithTitle = (messages: FactoryMessage[], title: string) => [...messages].reverse().find((m) => m.origin?.title === title)!;
  const runsOf = async (event: string) => (await supervisor()).automations.find((a) => (a.source.event ?? a.source.kind) === event)!.runs;
  const plan = async (tools: Array<{ server: string; name: string; args: Record<string, unknown> }>) => {
    const res = await human(`/api/projects/${project.id}/supervisor-policy`, "PUT", { note: `番頭の手順。${fakeTurn(tools.length > 0 ? { tools } : { say: "何もしません" })}` });
    expect(res.status, res.text).toBe(200);
  };
  /** 番頭の回は「必ず聞く」——Factory→Backlog・Subagent の中継の承認を、この Project の分だけ受信箱の口で許可する */
  const approving = (until: () => Promise<boolean>) =>
    expect
      .poll(
        async () => {
          for (const item of (await call("/api/inbox")).body as unknown as Array<{ id: string; kind: string; liveness?: string; projectId?: string }>) {
            if (item.kind !== "judgment" || item.liveness !== "live" || item.projectId !== project.id) continue;
            await call(`/api/inbox/${item.id}/answer`, { method: "POST", body: { answer: { behavior: "allow" } } });
          }
          return until();
        },
        { timeout: 180_000, intervals: [500], message: "番頭の回が終わらない" },
      )
      .toBe(true);
  /** 今すぐ見回り、n 回目の回が終わるまで待つ。その回の番頭の最後の発言（偽の AI は最後の tool の結果を言う）を返す */
  const patrol = async (n: number) => {
    const res = await human(`/api/projects/${project.id}/supervisor/patrol`, "POST");
    expect(res.status, res.text).toBe(202);
    await approving(async () => (await runsOf("time")).filter((r) => r.result === "done").length === n);
    const t = await thread((await supervisor()).threadId);
    const start = lastWithTitle(t.messages, "番頭：見回り");
    return t.messages.filter((m) => m.seq > start.seq && m.role === "assistant").map((m) => m.text).at(-1) ?? "";
  };

  const created = await human(`/api/projects/${project.id}/supervisor`, "POST", {});
  expect(created.status, created.text).toBe(201);
  const s = created.body as unknown as Supervisor;
  try {
    // ---- 1. 見回り：ready を Factory に流す ----------------------------------------------------------------------
    // Backlog の今すぐ着手できる ready を読める
    await plan([{ server: "backlog", name: "listItems", args: { actionable: true } }]);
    expect(await patrol(1), "Backlog の一覧が引けない").toContain("sv-fix");
    await plan([{ server: "factory", name: "runFactory", args: { items: ["sv-fix"], reason: "ready の一番上を流す" } }]);
    const said = await patrol(2);
    expect(said, `流せていない：${said}`).toContain("流しました");
    const runId = (JSON.parse(said.slice(said.indexOf("{"))) as { runId: string }).runId;
    // 止まった件の回の手順は、止まる前に書いておく（止まってから30秒まとめて届く）
    await plan([
      {
        server: "factory",
        name: "answerFactory",
        args: { runId: "$eventField:runId", item: "$eventField:item", action: "continue", reason: "テストが落ちたので、続けて直させる" },
      },
    ]);
    let acts = (await supervisor()).acts;
    expect(acts.map((a) => [a.kind, a.runId, a.items, a.reason])).toEqual([["factory-started", runId, ["sv-fix"], "ready の一番上を流す"]]);

    // ---- 2. 流した件がテストで止まる→番頭の Factory の出来事の回に届き、方針どおり continue で答える ------------------------------
    await expect.poll(async () => (await factoryRuns()).find((r) => r.runId === runId)?.items[0]?.status, { timeout: 180_000, message: "流した件がテストで止まらない" }).toBe("stopped");
    await approving(async () => (await runsOf("factory.item-stopped")).some((r) => r.result === "done"));
    await expect.poll(async () => (await supervisor()).acts.map((a) => a.kind), { message: "答えた記録が無い" }).toEqual(["factory-answered", "factory-started"]);
    acts = (await supervisor()).acts;
    expect([acts[0]!.runId, acts[0]!.item, acts[0]!.stage, acts[0]!.action, acts[0]!.reason]).toEqual([runId, "sv-fix", "テスト", "continue", "テストが落ちたので、続けて直させる"]);
    // 答えたあとの回の手順は何もしない（終わった実行の出来事の回で、答える相手がいない）
    await plan([]);
    // 起きた回に、止まった件が文として届いている：出来事（runId・項目・段）と、返信用の札の知らせ（止まった理由）が同じターンに
    const t = await thread(s.threadId);
    const round = lastWithTitle(t.messages, "番頭：Factory の件が止まった");
    const fields = round.origin!.external![0]!.event!.fields;
    expect([fields.runId, fields.item, fields.stage]).toEqual([runId, "sv-fix", "テスト"]);
    expect(round.text, "止まった件の回の手順が届いていない").toContain("番頭が流した件）ときだけ、方針どおり answerFactory で答えて");
    const reply = t.messages.find((m) => m.origin?.from === "factory" && m.origin.title.includes("が止まりました"))!;
    expect(reply, "返信用の札の知らせが番頭の会話に無い").toBeTruthy();
    expect(reply.text).toContain(runId);
    expect(reply.text).toContain("テストが 1 回続けて落ちました");
    const answeredSeq = t.messages.find((m) => m.role === "assistant" && m.seq > round.seq)!.seq;
    expect(reply.seq < answeredSeq && round.seq < answeredSeq, "止まった件の知らせが答えたターンより後に届いた").toBe(true);
    // 札の知らせだけでは番頭の会話を起こさない——起きたのは番頭の自動化の回だけ
    expect(t.messages.filter((m) => m.role === "user" && m.origin && !m.origin.title.startsWith("番頭：") && !m.origin.title.startsWith("Factory")), "番頭の会話に知らない届けもの").toEqual([]);
    // 答えで続き、取り込まれる
    await expect.poll(async () => (await factoryRuns()).find((r) => r.runId === runId)?.items[0]?.status, { timeout: 180_000, message: "答えたあと取り込まれない" }).toBe("done");
    expect(existsSync(join(root, "a.txt")) && existsSync(join(root, "ok.txt")), "main に入っていない").toBe(true);
    expect(backlogStatus("sv-fix")).toBe("done");
    // 番頭が流した件の知らせは受信箱に出さない（番頭の画面のもの）
    const notices = ((await call("/api/inbox")).body as unknown as Array<{ kind: string; projectId?: string; threadId?: string }>).filter((i) => i.threadId === s.threadId && i.kind !== "judgment");
    expect(notices, "番頭の Fork の知らせが受信箱に出た").toEqual([]);

    // ---- 3. 全体の上限：2件を流すと、3件目は断られる ------------------------------------------------------------------
    for (const id of ["sv-a", "sv-b", "sv-c"]) {
      await uiCall("backlog", "boardCreateItem", { id, kind: "task", title: `${id} を待たせる`, body: "[slow 600]", status: "ready" });
    }
    await plan(["sv-a", "sv-b", "sv-c"].map((id) => ({ server: "factory", name: "runFactory", args: { items: [id], reason: `${id} を流す` } })));
    // 偽の AI は最後の tool の結果だけを言う——1・2件目は記録と Factory の様子で見る
    const flowed = await patrol(3);
    expect(flowed, "3件目が断られない").toContain("全部の番頭で同時に走らせる Factory の件は 2 件までです（いま 2 件）");
    acts = (await supervisor()).acts;
    expect(acts.slice(0, 3).map((a) => [a.kind, a.items])).toEqual([["refused", ["sv-c"]], ["factory-started", ["sv-b"]], ["factory-started", ["sv-a"]]]);
    const running = (await factoryRuns()).filter((r) => r.items.some((i) => ["sv-a", "sv-b"].includes(i.item)));
    expect(running.flatMap((r) => r.items.map((i) => i.status)).sort()).toEqual(["running", "running"]);
    expect((await factoryRuns()).some((r) => r.items.some((i) => i.item === "sv-c")), "断ったのに Factory に流れた").toBe(false);
    expect(backlogStatus("sv-c")).toBe("ready");
    // 取りやめるのは人（番頭には cancelFactory が無い）
    for (const r of running) await uiCall("factory", "cancelFactory", { runId: r.runId, reason: "E2E の片づけ" });
  } finally {
    expect((await human(`/api/projects/${project.id}/supervisor`, "DELETE")).status).toBe(200);
  }
});
