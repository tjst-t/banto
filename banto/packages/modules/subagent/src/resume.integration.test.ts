// **起こし直しても続ける**（追加・2026-10-05、アーキ仕様 §2.5「2. Module の仕事を続ける」）。偽のエージェントで：
//   - 待たない形の仕事は、走っている間 Module の置き場に記録が残る（資格情報・札は書かれない）
//   - 起き直した Module は host の問い（`resumeAfterRestart`）に「続ける」と答え、session/load して「途中で切れました。
//     実行中だった tool：…」を送り、終わりを同じ札で届ける
//   - 最初の頼みが記録される前に切れたもの（load できない）は同じ頼みで最初から。進んでから load できないものは失敗を届ける
//   - 記録の無い札は「続けない」。問われなかった記録は片づける
// host が落ちるのは、Module ごと消える（後片づけが走らない）ことにあたる。ここでは走っている間の記録の写しを取り、
// 仕事を止めて片づけさせたあと写しを書き戻して、同じ置き場で Module を立て直す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CALL_ID_META_KEY,
  CALLER_META_KEY,
  MODULE_META_KEY,
  REPLY_TO_META_KEY,
  RESUME_AFTER_RESTART_TOOL,
  THREAD_META_KEY,
  VISIBILITY_META_KEY,
  replyToFingerprint,
} from "@banto/module-contract";
import { defaultAliasName, listAgents } from "./agents.js";
import { createSubagentServer, resumePromptOf } from "./server.js";
import { fakeVault } from "./testing/harness.js";
import type { RunningRecord } from "./running.js";
import { execFileSync, spawn } from "node:child_process";
import { groupAlive, startTicksOf } from "./process-group.js";

type Delivered = { replyTo: string; title: string; text: string };
type ToolResult = { content: { text: string }[]; isError?: boolean };

const THREAD = { projectId: "p1", threadId: "t1" };
const REPLY_TO = "reply_THIS-IS-THE-HANDLE-ITSELF";
const STORED_KEY = "STORED-KEY-VALUE-123";
const ENV_SECRET = "ENV-SECRET-VALUE-456";

interface Dirs {
  project: string;
  data: string;
}

/** 同じ置き場で Module を立てる（起き直しは、同じ置き場で立て直すこと） */
async function startModule(dirs: Dirs) {
  const delivered: Delivered[] = [];
  const vault = fakeVault({ [defaultAliasName("fake", "FAKE_AGENT_TOKEN")]: STORED_KEY, "extra-alias": ENV_SECRET });
  const server = createSubagentServer({
    projectRoot: dirs.project,
    moduleDataDir: dirs.data,
    relayClient: vault.relay,
    agents: listAgents({ BANTO_SUBAGENT_FAKE_AGENT: "1" }),
    claudeLoginEnv: {},
    deliver: async (input) => {
      delivered.push(input);
      return { deliveryId: `d${delivered.length}`, wake: "now" };
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as ToolResult;
  const waitDelivered = async (n: number) => {
    for (let i = 0; i < 300 && delivered.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(delivered.length, n, "届かない");
  };
  return { client, call, delivered, waitDelivered, close: () => client.close() };
}

async function withDirs(fn: (dirs: Dirs) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "subagent-resume-"));
  const dirs = { project: join(root, "project"), data: join(root, "data", "modules", "subagent-p1") };
  mkdirSync(dirs.project, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  try {
    await fn(dirs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const runningDir = (dirs: Dirs) => join(dirs.data, "running");
const runningFiles = (dirs: Dirs) => {
  try {
    return readdirSync(runningDir(dirs)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
};
const readRunning = (dirs: Dirs): RunningRecord[] =>
  runningFiles(dirs).map((f) => JSON.parse(readFileSync(join(runningDir(dirs), f), "utf8")) as RunningRecord);

/** 待たない形で頼み、最初の tool を呼ぶまで待つ。走っている間の記録（ファイルの中身）を返す */
async function startBackground(
  m: Awaited<ReturnType<typeof startModule>>,
  dirs: Dirs,
  args: Record<string, unknown>,
  /** 呼び元の印。既定は AI のターン（Thread）。Module が中継で頼んだ形は `{ caller: { project } }` だけ */
  stamp: Record<string, unknown> = { [THREAD_META_KEY]: THREAD },
) {
  const res = await m.call("runSubagent", { agent: "fake", runInBackground: true, ...args }, { [REPLY_TO_META_KEY]: REPLY_TO, ...stamp });
  assert.equal(res.isError, undefined, res.content[0]?.text);
  const runId = (JSON.parse(res.content[0]!.text) as { runId: string }).runId;
  for (let i = 0; i < 100; i++) {
    const r = readRunning(dirs).find((x) => x.id === runId);
    if (r?.toolsInFlight.some((t) => t.title.startsWith("sleep"))) return { runId, file: join(runningDir(dirs), runningFiles(dirs).find((f) => f.startsWith(runId))!), raw: readFileSync(join(runningDir(dirs), `${runId}.json`), "utf8") };
    await new Promise((res2) => setTimeout(res2, 50));
  }
  assert.fail("走り出さない（記録に tool が残らない）");
}

/**
 * host が落ちたのと同じ置き場を作る：走っている間の記録の写しを取り、仕事を止めて後片づけさせ（記録が消える）、写しを
 * 書き戻す。`edit` で写しを書き換えられる
 */
async function crashDuring(
  dirs: Dirs,
  args: Record<string, unknown>,
  edit?: (r: RunningRecord) => void,
  stamp?: Record<string, unknown>,
): Promise<RunningRecord> {
  const before = await startModule(dirs);
  const { runId, raw } = await startBackground(before, dirs, args, stamp);
  await before.call("cancelRun", { id: runId });
  await before.waitDelivered(1);
  assert.equal(runningFiles(dirs).length, 0, "届けたのに記録が消えない");
  await before.close();
  const record = JSON.parse(raw) as RunningRecord;
  edit?.(record);
  mkdirSync(runningDir(dirs), { recursive: true });
  writeFileSync(join(runningDir(dirs), `${runId}.json`), JSON.stringify(record));
  return record;
}

const ask = (m: Awaited<ReturnType<typeof startModule>>, replyTo: string, thread = THREAD) =>
  m.call(RESUME_AFTER_RESTART_TOOL, { items: [{ replyTo, toolName: "runSubagent", toolCallId: "toolu_1", thread }] });

test("待たない形の仕事は、走っている間置き場に記録が残る——資格情報・札そのものは書かれない（grep）", async () => {
  await withDirs(async (dirs) => {
    const m = await startModule(dirs);
    const { runId, raw } = await startBackground(m, dirs, {
      // 最初の tool は終わっている——実行中に残るのは終わりの来ていない tool だけ
      prompt: "[done-tool] [slow 30] 長い仕事",
      model: "fake-large",
      effort: "high",
      envSecrets: { EXTRA_TOKEN: "extra-alias" },
    });
    const r = JSON.parse(raw) as RunningRecord;
    assert.equal(r.id, runId);
    assert.equal(r.agent, "fake");
    assert.equal(r.cwd, dirs.project);
    assert.match(r.sessionId ?? "", /^[0-9a-f-]{36}$/, "会話の id が書かれていない");
    assert.equal(r.model, "fake-large");
    assert.equal(r.effort, "high");
    assert.deepEqual(r.envSecrets, { EXTRA_TOKEN: "extra-alias" }, "alias の名前が無い（続けるときに受け取り直せない）");
    assert.equal(r.replyToFingerprint, replyToFingerprint(REPLY_TO));
    assert.deepEqual(r.requestedBy, THREAD);
    assert.equal(r.prompt, "[done-tool] [slow 30] 長い仕事");
    assert.equal(r.promptHead, "[done-tool] [slow 30] 長い仕事");
    assert.equal(r.progressed, true);
    assert.deepEqual(r.toolsInFlight.map((t) => t.title), ["sleep 30"]);
    assert.ok(r.agentProcess && r.agentProcess.pid > 1, "エージェントの pid が記録に無い");
    // 資格情報（Vault から受け取った値・起動の env）と札そのものは無い
    for (const secret of [STORED_KEY, ENV_SECRET, REPLY_TO, "FAKE_AGENT_TOKEN", "PATH"]) {
      assert.ok(!raw.includes(secret), `走っている記録に ${secret} が書かれている`);
    }
    // 終われば消える
    await m.call("cancelRun", { id: runId });
    await m.waitDelivered(1);
    assert.equal(runningFiles(dirs).length, 0);
    await m.close();
  });
});

test("起き直した Module は「続ける」と答え、session/load して「途中で切れました。実行中だった tool：…」を送り、同じ札で終わりを届ける", async () => {
  await withDirs(async (dirs) => {
    const cut = await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" });
    const m = await startModule(dirs);
    // 印と問いの口を名乗る
    const resources = await m.client.listResources();
    const declared = resources.resources.find((r) => r._meta?.[MODULE_META_KEY])!._meta![MODULE_META_KEY] as { resumesAfterRestart?: boolean };
    assert.equal(declared.resumesAfterRestart, true);
    const tool = (await m.client.listTools()).tools.find((t) => t.name === RESUME_AFTER_RESTART_TOOL);
    assert.equal((tool?._meta as Record<string, unknown> | undefined)?.[VISIBILITY_META_KEY], "admin", "問いの口が AI に見える");

    const res = await ask(m, REPLY_TO);
    assert.deepEqual(JSON.parse(res.content[0]!.text), { answers: [{ replyTo: REPLY_TO, resume: true }] });
    await m.waitDelivered(1);
    const [d] = m.delivered;
    assert.equal(d!.replyTo, REPLY_TO, "同じ札で届けていない");
    assert.equal(d!.title, "Fake Agent（試験用） の仕事が終わりました");
    const body = JSON.parse(d!.text) as { runId: string; sessionId: string; resumedAfterRestart: boolean; text: string; notes: string[] };
    assert.equal(body.runId, cut.id);
    assert.equal(body.sessionId, cut.sessionId, "続きから開いていない");
    assert.equal(body.resumedAfterRestart, true);
    assert.match(
      body.text,
      /^受け取った：banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool：sleep 30——結果は分かりません（コマンドならまだ動いているかもしれません）。確かめてから続けてください/,
    );
    assert.ok(body.notes.some((n) => /続きから再開しました（1 回目）/.test(n)));
    assert.equal(runningFiles(dirs).length, 0, "届けたのに記録が残っている");
    // 画面の一覧では同じ仕事が終わって見える
    const run = JSON.parse((await m.call("getRun", { id: cut.id })).content[0]!.text) as { status: string };
    assert.equal(run.status, "done");
    // 2回目の問いには、もう記録が無い
    const again = JSON.parse((await ask(m, REPLY_TO)).content[0]!.text) as { answers: Array<{ resume: boolean }> };
    assert.equal(again.answers[0]!.resume, false);
    await m.close();
  });
});

test("最初の頼みが記録される前に切れたもの（load できない・まだ何も進んでいない）は、同じ頼みで最初からやり直す", async () => {
  await withDirs(async (dirs) => {
    const cut = await crashDuring(dirs, { prompt: "[slow 30] 最初の頼み" }, (r) => {
      // claude-agent-acp の形：会話の id はあるが記録が無い（load が断られる）。進んだ跡も無い
      r.sessionId = "00000000-0000-0000-0000-000000000000";
      r.progressed = false;
      r.toolsInFlight = [];
      r.prompt = "最初の頼み";
    });
    const m = await startModule(dirs);
    assert.equal((JSON.parse((await ask(m, REPLY_TO)).content[0]!.text) as { answers: Array<{ resume: boolean }> }).answers[0]!.resume, true);
    await m.waitDelivered(1);
    const body = JSON.parse(m.delivered[0]!.text) as { runId: string; sessionId: string; text: string; notes: string[] };
    assert.equal(body.runId, cut.id);
    assert.notEqual(body.sessionId, cut.sessionId);
    assert.match(body.text, /^受け取った：最初の頼み（/, "同じ頼みで最初からやり直していない");
    assert.ok(body.notes.some((n) => /同じ頼みで最初からやり直しました/.test(n)), JSON.stringify(body.notes));
    await m.close();
  });
});

test("進んでから load できなくなったものは、やり直さずに失敗を同じ札で届ける", async () => {
  await withDirs(async (dirs) => {
    await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" }, (r) => {
      r.sessionId = "00000000-0000-0000-0000-000000000000";
    });
    const m = await startModule(dirs);
    await ask(m, REPLY_TO);
    await m.waitDelivered(1);
    assert.equal(m.delivered[0]!.replyTo, REPLY_TO);
    assert.equal(m.delivered[0]!.title, "Fake Agent（試験用） の仕事が失敗しました");
    assert.match(m.delivered[0]!.text, /続きから開けませんでした/);
    assert.equal(runningFiles(dirs).length, 0);
    await m.close();
  });
});

test("届ける前に止まった結果は、走らせ直さずに届ける", async () => {
  await withDirs(async (dirs) => {
    await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" }, (r) => {
      r.finished = { title: "Fake Agent（試験用） の仕事が終わりました", text: '{"text":"前の走行の結果"}' };
    });
    const m = await startModule(dirs);
    await ask(m, REPLY_TO);
    await m.waitDelivered(1);
    assert.deepEqual(m.delivered[0], { replyTo: REPLY_TO, title: "Fake Agent（試験用） の仕事が終わりました", text: '{"text":"前の走行の結果"}' });
    await m.close();
  });
});

test("記録の無い札・別の Thread の札には「続けない」と答え、問われなかった記録は片づける（失敗として一覧に残る）", async () => {
  await withDirs(async (dirs) => {
    const cut = await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" });
    const m = await startModule(dirs);
    const other = JSON.parse((await ask(m, REPLY_TO, { projectId: "p1", threadId: "another" })).content[0]!.text) as {
      answers: Array<{ resume: boolean; reason?: string }>;
    };
    assert.equal(other.answers[0]!.resume, false);
    assert.match(other.answers[0]!.reason!, /Thread が違います/);
    assert.equal(runningFiles(dirs).length, 0);
    await m.close();

    // 問われなかった記録
    await crashDuring(dirs, { prompt: "[slow 30] もう1つ" });
    const m2 = await startModule(dirs);
    const unknown = JSON.parse((await ask(m2, "reply_unknown")).content[0]!.text) as { answers: Array<{ resume: boolean; reason?: string }> };
    assert.equal(unknown.answers[0]!.resume, false);
    assert.match(unknown.answers[0]!.reason!, /記録がありません/);
    assert.equal(runningFiles(dirs).length, 0, "問われなかった記録が残っている");
    const runs = JSON.parse((await m2.call("listRuns", { limit: 10 })).content[0]!.text) as { runs: Array<{ id: string; status: string }> };
    assert.ok(runs.runs.some((r) => r.id !== cut.id && r.status === "error"), JSON.stringify(runs.runs));
    assert.equal(m2.delivered.length, 0, "続けないのに届けた");
    await m2.close();
  });
});

test("起こし直しのあと送る文：実行中の tool が無ければ「ありません」、あれば最後の1つ", () => {
  assert.equal(resumePromptOf({ toolsInFlight: [] }), "banto を起こし直したため、作業が途中で切れました。切れたとき実行中だった tool はありません。続けてください");
  assert.match(resumePromptOf({ toolsInFlight: [{ title: "a" }, { title: "make test" }] }), /実行中だった tool：make test——/);
});

// ---- 残ったエージェント（追加・2026-10-05。実測：Module が止まってもエージェントと子はコンテナの中で走り続ける）----

/** 残ったエージェントの代わり：自分のプロセスグループで走り続ける（印つき） */
function leftover(mark: string): { pid: number; startTicks: number } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)", mark], { detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid!, startTicks: startTicksOf(child.pid!)! };
}

const alive = (pid: number) => groupAlive(pid);

test("エージェントは自分のプロセスグループで起こし、記録に pid と開始時刻を残す。止めるとグループごと（子も）止まる", async () => {
  await withDirs(async (dirs) => {
    const m = await startModule(dirs);
    const { runId, raw } = await startBackground(m, dirs, { prompt: "[child 120] [slow 30] 長い仕事" });
    const r = JSON.parse(raw) as RunningRecord;
    assert.ok(r.agentProcess, "エージェントの pid が記録に無い");
    assert.equal(r.agentProcess.startTicks, startTicksOf(r.agentProcess.pid));
    assert.ok(alive(r.agentProcess.pid));
    const childOf = () => execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`fake-agent-child ${r.sessionId}`));
    assert.equal(childOf().length, 1, "エージェントの子が起きていない（試験の前提）");
    await m.call("cancelRun", { id: runId });
    await m.waitDelivered(1);
    for (let i = 0; i < 50 && alive(r.agentProcess.pid); i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(alive(r.agentProcess.pid), false, "止めたのにグループが残っている");
    assert.deepEqual(childOf(), [], "止めたのにエージェントの子が残っている");
    await m.close();
  });
});

test("続ける前に、前の走行のエージェント（グループ）が残っていれば止めてから続ける", async () => {
  await withDirs(async (dirs) => {
    const old = leftover("subagent-test-leftover");
    try {
      await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" }, (r) => void (r.agentProcess = old));
      const m = await startModule(dirs);
      await ask(m, REPLY_TO);
      await m.waitDelivered(1);
      assert.equal(alive(old.pid), false, "前の走行のエージェントを止めずに続けた");
      assert.match(m.delivered[0]!.text, /受け取った：banto を起こし直したため/);
      await m.close();
    } finally {
      try {
        process.kill(-old.pid, "SIGKILL");
      } catch {
        // もう居ない
      }
    }
  });
});

test("続けないと決めた仕事も、残ったエージェントを止める", async () => {
  await withDirs(async (dirs) => {
    const old = leftover("subagent-test-leftover-abandon");
    try {
      await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" }, (r) => void (r.agentProcess = old));
      const m = await startModule(dirs);
      await ask(m, "reply_unknown");
      for (let i = 0; i < 100 && alive(old.pid); i++) await new Promise((res) => setTimeout(res, 100));
      assert.equal(alive(old.pid), false, "問われなかった仕事のエージェントが残っている");
      await m.close();
    } finally {
      try {
        process.kill(-old.pid, "SIGKILL");
      } catch {
        // もう居ない
      }
    }
  });
});

test("記録した pid が別のプロセスに使い回されていたら（開始時刻が違う）止めない", async () => {
  await withDirs(async (dirs) => {
    const other = leftover("subagent-test-not-mine");
    try {
      await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" }, (r) => void (r.agentProcess = { pid: other.pid, startTicks: other.startTicks + 1 }));
      const m = await startModule(dirs);
      await ask(m, REPLY_TO);
      await m.waitDelivered(1);
      assert.equal(alive(other.pid), true, "別のプロセスを止めた");
      await m.close();
    } finally {
      process.kill(-other.pid, "SIGKILL");
    }
  });
});

test("前の走行のエージェントが止まらなければ、続けずに失敗を同じ札で届ける", async (t) => {
  // 止められないグループ：他人（root）のプロセスグループ。信号は EPERM で届かない
  const rootLeader = readdirSync("/proc")
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .find((pid) => {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        return pid > 1 && /^Uid:\s+0\s/m.test(status) && startTicksOf(pid) !== undefined && groupLeader(pid);
      } catch {
        return false;
      }
    });
  if (rootLeader === undefined || process.getuid?.() === 0) {
    t.skip("止められないプロセスグループが見つからない");
    return;
  }
  await withDirs(async (dirs) => {
    await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" }, (r) => void (r.agentProcess = { pid: rootLeader, startTicks: startTicksOf(rootLeader)! }));
    const m = await startModule(dirs);
    await ask(m, REPLY_TO);
    await m.waitDelivered(1);
    assert.equal(m.delivered[0]!.title, "Fake Agent（試験用） の仕事が失敗しました");
    assert.match(m.delivered[0]!.text, /エージェント（pid \d+）が止まらないので、続けられませんでした/);
    await m.close();
  });
});

/** そのプロセスがグループの頭か（/proc/<pid>/stat の pgrp） */
function groupLeader(pid: number): boolean {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === pid;
}

// ---- Fable のレビューを受けた直し（2026-10-05）----

test("問いは host だけ：人の画面・中継・AI のターンの印が付いた問いは断り、記録には触らない", async () => {
  await withDirs(async (dirs) => {
    await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" });
    const m = await startModule(dirs);
    const item = { replyTo: REPLY_TO, toolName: "runSubagent", thread: THREAD };
    for (const stamp of [
      { [CALLER_META_KEY]: { admin: true } },
      { [CALLER_META_KEY]: { project: "p1" } },
      { [THREAD_META_KEY]: THREAD },
      { [CALL_ID_META_KEY]: "c1" },
    ]) {
      const res = await m.call(RESUME_AFTER_RESTART_TOOL, { items: [item] }, stamp);
      assert.equal(res.isError, true, `${JSON.stringify(stamp)} の問いが通った`);
      assert.match(res.content[0]!.text, /banto 本体だけが呼べます/);
    }
    assert.equal(runningFiles(dirs).length, 1, "断った問いで記録を片づけた");
    assert.equal(m.delivered.length, 0);
    // host の問い（印なし）は通る
    assert.deepEqual(JSON.parse((await ask(m, REPLY_TO)).content[0]!.text), { answers: [{ replyTo: REPLY_TO, resume: true }] });
    await m.waitDelivered(1);
    await m.close();
  });
});

test("Module が中継で頼んだ仕事（Thread の印が無い）も、呼び元の Module として問われたら続ける——Thread の仕事として問われたら続けない", async () => {
  const relayStamp = { [CALLER_META_KEY]: { project: "p1" } };
  await withDirs(async (dirs) => {
    const cut = await crashDuring(dirs, { prompt: "[slow 30] 中継で頼まれた仕事" }, undefined, relayStamp);
    assert.equal(cut.requestedBy, undefined, "試験の前提：Thread の印が無い");
    const m = await startModule(dirs);
    const res = await m.call(RESUME_AFTER_RESTART_TOOL, { items: [{ replyTo: REPLY_TO, caller: { module: "factory", projectId: "p1" } }] });
    assert.deepEqual(JSON.parse(res.content[0]!.text), { answers: [{ replyTo: REPLY_TO, resume: true }] });
    await m.waitDelivered(1);
    assert.equal(m.delivered[0]!.replyTo, REPLY_TO);
    assert.match(m.delivered[0]!.text, /受け取った：banto を起こし直したため/);
    await m.close();
  });
  await withDirs(async (dirs) => {
    await crashDuring(dirs, { prompt: "[slow 30] 中継で頼まれた仕事" }, undefined, relayStamp);
    const m = await startModule(dirs);
    const res = JSON.parse((await ask(m, REPLY_TO)).content[0]!.text) as { answers: Array<{ resume: boolean; reason?: string }> };
    assert.equal(res.answers[0]!.resume, false);
    assert.match(res.answers[0]!.reason!, /Module が中継で頼んだ仕事ですが、Thread の仕事として問われました/);
    await m.close();
  });
});

test("読めない走っている記録は横に退けて理由を残し、ほかの記録は続けられる（Subagent は起きる）", async () => {
  await withDirs(async (dirs) => {
    await crashDuring(dirs, { prompt: "[slow 30] 長い仕事" });
    writeFileSync(join(runningDir(dirs), "broken.json"), "{ 壊れた");
    writeFileSync(join(runningDir(dirs), "wrong-shape.json"), JSON.stringify({ hello: 1 }));
    const m = await startModule(dirs);
    const aside = readdirSync(runningDir(dirs)).filter((f) => f.includes(".unreadable-"));
    assert.equal(aside.length, 2, `退けていない：${readdirSync(runningDir(dirs)).join(", ")}`);
    assert.deepEqual(JSON.parse((await ask(m, REPLY_TO)).content[0]!.text), { answers: [{ replyTo: REPLY_TO, resume: true }] });
    await m.waitDelivered(1);
    await m.close();
  });
});
