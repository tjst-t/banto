// ターンの終わりのまとめ（決定・2026-10-06、アーキ仕様 §2.2）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { buildSystemPrompt } from "../runner/system-prompt.js";
import type { runTurn } from "../runner/adapter.js";
import { createForkMcpServer } from "./fork-tool.js";
import { runThreadTurn } from "./turn-runner.js";
import {
  REPORT_TURN_MISSING_REASON,
  TURN_SUMMARY_LONG_TURN_MS,
  TURN_SUMMARY_PROMPT_SECTION,
  noteToolUsed,
  shouldEndTurnAfterTool,
  turnSummaryStopDecision,
  validateTurnSummary,
  type TurnSummary,
  type TurnSummaryEntry,
  type TurnSummaryState,
} from "./turn-summary.js";

const good: TurnSummary = {
  request: "Vault に版の仕組みを入れる",
  outcome: { status: "done", headline: "実装して push しました", points: ["置き場ダイアログに環境が出る"] },
  decisions: [
    {
      question: "稼働中の banto に反映してよいですか？",
      options: [
        { label: "反映して", reply: "稼働中の banto に反映して。", recommended: true },
        { label: "あとで", reply: "反映は自分でやる。" },
      ],
    },
  ],
};

test("形が合っていれば通り、合わなければ直し方の分かる理由を返す", () => {
  assert.equal(validateTurnSummary(good), undefined);
  assert.equal(validateTurnSummary({ ...good, decisions: [], nextSuggestions: [{ label: "閉じる", reply: "この Fork は終わり。" }] }), undefined);

  const tooMany = validateTurnSummary({ ...good, outcome: { ...good.outcome, points: ["a", "b", "c", "d"] } });
  assert.match(tooMany ?? "", /points は 3 つまで/);
  assert.match(tooMany ?? "", /report_turn を呼んでください/);

  const oneOption = validateTurnSummary({
    ...good,
    decisions: [{ question: "どうする？", options: [{ label: "A", reply: "A で" }] }],
  });
  assert.match(oneOption ?? "", /options は 2〜4 個/);

  const twoRecommended = validateTurnSummary({
    ...good,
    decisions: [
      {
        question: "どうする？",
        options: [
          { label: "A", reply: "A で", recommended: true },
          { label: "B", reply: "B で", recommended: true },
        ],
      },
    ],
  });
  assert.match(twoRecommended ?? "", /おすすめ（recommended）は1つまで/);

  assert.match(validateTurnSummary({ ...good, request: "  " }) ?? "", /request/);
  assert.match(
    validateTurnSummary({ ...good, decisions: [{ question: "?", options: [{ label: "A", reply: "" }, { label: "B", reply: "B" }] }] }) ?? "",
    /label か reply が空/,
  );
});

test("催促は、作業をした・3分以上かかったターンで、まとめが無いときだけ一度だけ（stop_hook_active なら終える）", () => {
  const t0 = 1_000_000;
  const short: TurnSummaryState = { startedAt: t0 };
  noteToolUsed(short, "mcp__banto-memory__remember_decision");
  noteToolUsed(short, "mcp__banto-thread__report_turn");
  assert.equal(turnSummaryStopDecision(short, false, t0 + 1000), undefined, "短い受け答えでは催促しない");
  assert.equal(turnSummaryStopDecision(short, false, t0 + TURN_SUMMARY_LONG_TURN_MS), REPORT_TURN_MISSING_REASON, "3分以上なら催促する");

  const worked: TurnSummaryState = { startedAt: t0 };
  noteToolUsed(worked, "mcp__shell__runCommand");
  assert.equal(turnSummaryStopDecision(worked, false, t0 + 1000), REPORT_TURN_MISSING_REASON);
  assert.equal(turnSummaryStopDecision(worked, true, t0 + 1000), undefined, "差し戻したあとの終わりで、もう一度差し戻すと終わらない");
  worked.accepted = { summary: good, at: "2026-10-06T00:00:00.000Z" };
  assert.equal(turnSummaryStopDecision(worked, false, t0 + 1000), undefined);
});

test("まとめを受け付けたらそこでターンを終える。断った呼び出し・ほかの tool では終えない", () => {
  const state: TurnSummaryState = {};
  assert.equal(shouldEndTurnAfterTool(state, "mcp__banto-thread__report_turn"), false, "断った（受け付けていない）ときは直させる");
  state.accepted = { summary: good, at: "2026-10-07T00:00:00.000Z" };
  assert.equal(shouldEndTurnAfterTool(state, "mcp__banto-thread__report_turn"), true);
  assert.equal(shouldEndTurnAfterTool(state, "mcp__shell__runCommand"), false);
});

test("システムプロンプトの節は、オンのときだけ動的な後半に足す", () => {
  const base = { project: { name: "p", root: "/r" }, memory: [] };
  const off = buildSystemPrompt(base);
  const on = buildSystemPrompt({ ...base, turnSummary: true });
  assert.ok(!off.includes(TURN_SUMMARY_PROMPT_SECTION));
  assert.ok(on.includes(TURN_SUMMARY_PROMPT_SECTION));
  // 前半（全 Project で前方一致する部分）は変えない
  const boundary = off.findIndex((b) => b.includes("DYNAMIC_BOUNDARY"));
  assert.deepEqual(on.slice(0, boundary + 1), off.slice(0, boundary + 1));
});

async function withStore(fn: (ctx: { store: ProjectThreadStore; threadId: string; dir: string; inbox: InboxStore; globalMemory: GlobalMemoryStore }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-turn-summary-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await fn({ store, threadId: thread.id, dir, inbox, globalMemory });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function connect(server: ReturnType<typeof createForkMcpServer>) {
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([(server as unknown as { instance: { connect(t: unknown): Promise<void> } }).instance.connect(s), client.connect(c)]);
  return client;
}

test("report_turn はオンのときだけ見え、受け付けたものを状態と記録に残し、合わないものは断る", async () => {
  await withStore(async ({ store, threadId }) => {
    const offClient = await connect(createForkMcpServer(store, threadId, []));
    assert.ok(!(await offClient.listTools()).tools.some((t) => t.name === "report_turn"));

    const state: TurnSummaryState = {};
    const recorded: TurnSummaryEntry[] = [];
    const client = await connect(
      createForkMcpServer(store, threadId, [], undefined, {
        state,
        record: async (e) => void recorded.push(e),
        now: () => new Date("2026-10-06T14:41:00.000Z"),
      }),
    );
    assert.ok((await client.listTools()).tools.some((t) => t.name === "report_turn"));

    const bad = await client.callTool({ name: "report_turn", arguments: { ...good, request: "" } });
    assert.equal(bad.isError, true);
    assert.equal(state.accepted, undefined);
    assert.equal(recorded.length, 0);

    const ok = await client.callTool({ name: "report_turn", arguments: good });
    assert.notEqual(ok.isError, true);
    assert.deepEqual(state.accepted, { summary: good, at: "2026-10-06T14:41:00.000Z" });
    assert.equal(recorded.length, 1);
  });
});

test("まとめは同じターンの AI の発言にまとまり、2回目で置き換わる", async () => {
  await withStore(async ({ store, threadId }) => {
    await store.appendMessage(threadId, "user", "それでお願い");
    await store.startTurn(threadId, { cause: "human", attempt: 0 });
    await store.appendMessage(threadId, "assistant", "報告の本文");
    await store.recordTurnSummary(threadId, { summary: { ...good, request: "1回目" }, at: "2026-10-06T00:00:00.000Z" });
    await store.appendMessage(threadId, "assistant", "続きの文");
    await store.recordTurnSummary(threadId, { summary: { ...good, request: "2回目" }, at: "2026-10-06T00:01:00.000Z" });
    const messages = store.getThread(threadId)!.messages;
    const last = messages[messages.length - 1]!;
    assert.equal(last.role, "assistant");
    assert.equal(last.text, "報告の本文\n\n続きの文");
    assert.equal((last.turnSummary?.summary as TurnSummary).request, "2回目");
  });
});

test("オンの Project のターンには、tool・プロンプトの節・Stop hook を渡す。オフなら渡さない", async () => {
  await withStore(async ({ store, threadId, inbox, globalMemory }) => {
    const seen: Array<Parameters<typeof runTurn>[0]> = [];
    const fake = (async function* (opts: Parameters<typeof runTurn>[0]) {
      seen.push(opts);
      return { sessionId: `s-${seen.length}`, compactionCount: 0 } as never;
    }) as unknown as typeof runTurn;
    const deps = { projectThread: store, globalMemory, inbox, pendingApprovals: new PendingApprovalRegistry(), runTurn: fake };

    let on = true;
    for await (const _ of runThreadTurn({ ...deps, turnSummaryEnabled: () => on }, { threadId, prompt: "やって", modules: [] })) void _;
    on = false;
    for await (const _ of runThreadTurn({ ...deps, turnSummaryEnabled: () => on }, { threadId, prompt: "次", modules: [] })) void _;

    const [first, second] = seen;
    assert.ok(first!.systemPrompt.includes(TURN_SUMMARY_PROMPT_SECTION));
    assert.equal(typeof first!.onStop, "function");
    assert.deepEqual(first!.allowedTools, ["mcp__banto-thread__report_turn"], "毎ターン承認を求めない");
    assert.equal(first!.onStop!({ stopHookActive: false }), undefined, "tool を使っていない短いターンでは催促しない");
    assert.equal(first!.onToolUsed!({ toolName: "mcp__shell__runCommand" }), false);
    assert.equal(first!.onStop!({ stopHookActive: false }), REPORT_TURN_MISSING_REASON);
    assert.equal(first!.onStop!({ stopHookActive: true }), undefined);
    const tools = (await (await connect((first!.mcpServers as Record<string, never>)["banto-thread"])).listTools()).tools;
    assert.ok(tools.some((t) => t.name === "report_turn"));

    assert.ok(!second!.systemPrompt.includes(TURN_SUMMARY_PROMPT_SECTION));
    assert.equal(second!.onStop, undefined);
    assert.equal(second!.onToolUsed, undefined);
    assert.equal(second!.allowedTools, undefined);
  });
});
