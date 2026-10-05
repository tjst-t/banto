// **起こし直しで切れたターンを続ける**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。
//
// host が止まった（ここでは偽の Runner が途中で返らないまま、同じ置き場を開き直す）あと、起き直した host が人の手を
// 借りずに切れたターンを続けるか。続きは送り手 banto の届いたもので起こし、切れたことと実行中だった呼び出しを伝える。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { INTERRUPTED_NOTE, runThreadTurn, type TurnStreamEvent } from "../http/turn-runner.js";
import type { runTurn, RunnerTurnOptions } from "../runner/adapter.js";
import { ThreadTurns } from "./thread-turns.js";
import { DELIVERY_LIMITS, ThreadDeliveries } from "./thread-deliveries.js";
import { ReplyHandles } from "./reply-handles.js";
import { RESTARTING_REFUSAL } from "../relay/module-calls.js";
import type { ModuleAwaitingReply } from "./module-replies.js";
import { RestartRecovery, type RestartRecoveryDeps, type ResumeTarget } from "./restart-recovery.js";
import type { ResumeQuestion } from "@banto/module-contract";
import {
  continueStoppedTurn,
  RESUME_CUT_LIMIT,
  RESUME_GAVE_UP_TITLE,
  RESUME_SENDER,
  resumeHoldReason,
  resumeInterruptedTurns,
  type SessionReader,
} from "./turn-continuation.js";

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] });
const say = (text: string, uuid: string) => ({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });
const callTool = (id: string, name: string, uuid: string, input: unknown = { command: "make test" }) => ({
  type: "assistant",
  uuid,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id: string, uuid: string) => ({
  type: "user",
  uuid,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});

/** Runner が渡されたものの控え */
type Call = Pick<RunnerTurnOptions, "resumeSessionId" | "resumeSessionAt" | "sessionId" | "forkSession" | "prompt">;

/**
 * 台本どおりに流す Runner。`"hang"` で止まったまま返らない（＝host がそこで止まった）。`{ approval }` は承認待ちを
 * 出す（答えは来ない）。それ以外はメッセージ。最後まで行けば、渡された会話の id で終わる
 */
function scriptedRunner(script: Array<unknown>) {
  const calls: Call[] = [];
  let reached!: () => void;
  const hung = new Promise<void>((r) => (reached = r));
  const fake = (async function* (opts: RunnerTurnOptions) {
    calls.push({
      resumeSessionId: opts.resumeSessionId,
      resumeSessionAt: opts.resumeSessionAt,
      sessionId: opts.sessionId,
      forkSession: opts.forkSession,
      prompt: opts.prompt,
    });
    const sid = opts.sessionId ?? opts.resumeSessionId ?? "session-new";
    for (const step of script) {
      if (step === "hang") {
        reached();
        await new Promise(() => {});
      }
      const s = step as { approval?: { id: string; name: string } };
      if (s.approval) {
        yield {
          type: "approval_requested" as const,
          pending: { toolCallId: s.approval.id, toolName: s.approval.name, input: {}, resolve: () => undefined },
        } as never;
        continue;
      }
      // `init` は渡された会話の id を名乗る
      const m = step as { type?: string; subtype?: string };
      yield { type: "message" as const, message: m.type === "system" && m.subtype === "init" ? init(sid) : step } as never;
    }
    return { sessionId: sid, compactionCount: 0 } as never;
  }) as unknown as typeof runTurn;
  return { fake, calls, hung };
}

interface Host {
  store: ProjectThreadStore;
  inbox: InboxStore;
  deliveries: ThreadDeliveries;
  turns: ThreadTurns;
  deps: Parameters<typeof runThreadTurn>[0];
  /** 待ち受けを始めた（cli.ts と同じく、ここで初めてターンを開く口ができ、`resumeAll` が起こす） */
  listen(): void;
  /** 留める理由を足す（cli.ts と同じく、起き直したときの札の判定の留めを先に見る） */
  holdAlso(hold: (threadId: string) => string | undefined): void;
}

/** その置き場で host を起こす（起き直したときと同じく、判断待ちを期限切れにする）。`runner` は届いたもので起こすターン用 */
async function boot(dir: string, runner?: ReturnType<typeof scriptedRunner>): Promise<Host> {
  const log = new EventLog(dir);
  await log.init();
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  const globalMemory = new GlobalMemoryStore(dir, log);
  await globalMemory.load();
  const inbox = new InboxStore(dir, log);
  await inbox.load();
  await inbox.expireOrphanedJudgments();
  const turns = new ThreadTurns();
  let extraHold: ((threadId: string) => string | undefined) | undefined;
  // cli.ts と同じく、自動で続けるのをやめた Thread は留める
  const deliveries = new ThreadDeliveries({
    projectThread: store,
    turns,
    notify: async (n) => void (await inbox.raiseNotice(n)),
    hold: (threadId) => extraHold?.(threadId) ?? resumeHoldReason({ projectThread: store, inbox }, threadId),
  });
  const deps = { projectThread: store, globalMemory, inbox, pendingApprovals: new PendingApprovalRegistry() };
  const listen = (): void => {
    if (!runner) throw new Error("この host には Runner がありません（試験の書き間違い）");
    // app.ts の届いたもので起こすターンと同じ形——ターンを開く口は createApp で、起動の片づけのあとにできる
    deliveries.setTurnRunner(async (threadId, hop) => {
      const release = turns.tryAcquire(threadId, hop);
      if (!release) return false;
      try {
        await collect(runThreadTurn({ ...deps, runTurn: runner.fake }, { threadId, prompt: "", modules: [] }));
      } finally {
        release();
      }
      return true;
    });
    deliveries.resumeAll();
  };
  return { store, inbox, deliveries, turns, deps, listen, holdAlso: (hold) => void (extraHold = hold) };
}

async function collect(gen: AsyncGenerator<TurnStreamEvent>): Promise<TurnStreamEvent[]> {
  const out: TurnStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function withDir(fn: (ctx: { dir: string; first: Host; threadId: string; projectId: string }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-turn-continuation-"));
  try {
    const first = await boot(dir);
    const project = await first.store.createProject("demo", dir);
    const thread = await first.store.createBaseThread(project.id);
    await fn({ dir, first, threadId: thread.id, projectId: project.id });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 最後まで走るターン */
async function completeTurn(host: Host, threadId: string, prompt: string, script: unknown[]) {
  const runner = scriptedRunner(script);
  await collect(runThreadTurn({ ...host.deps, runTurn: runner.fake }, { threadId, prompt, modules: [] }));
  return runner;
}

/** 途中で host が止まるターン（Runner が `"hang"` で返らない） */
async function cutTurn(host: Host, threadId: string, prompt: string, script: unknown[]) {
  const runner = scriptedRunner([...script, "hang"]);
  void collect(runThreadTurn({ ...host.deps, runTurn: runner.fake }, { threadId, prompt, modules: [] }));
  await runner.hung;
  return runner;
}

/** その Thread のターンが終わり、待ち行列も空になるまで */
async function settled(host: Host, threadId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const t = host.store.getThread(threadId)!;
    if (!host.turns.isRunning(threadId) && (t.deliveries?.length ?? 0) === 0 && t.lastTurn?.outcome !== undefined) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("ターンが終わらない");
}

/** CLI の会話の記録（試験用）。`chains` に無い会話は記録が無い */
function sessionsOf(chains: Record<string, unknown[]>, opts: { unreadable?: boolean } = {}): SessionReader {
  return {
    exists: async (id) => id in chains,
    messages: async (id) => {
      if (opts.unreadable) throw new Error("読めない");
      return (chains[id] ?? []) as SessionMessage[];
    },
  };
}
const human = (text: string, uuid: string) => ({ type: "user", uuid, message: { content: text } });

const view = (store: ProjectThreadStore, threadId: string) =>
  store.getThread(threadId)!.messages.map((m) => `${m.role}${m.origin ? `(${m.origin.from})` : ""}:${m.text.slice(0, 40)}`);

test("tool の途中で切れたら、起き直した host が人の手を借りずに続ける——切れたことと実行中だった呼び出しが届き、最後まで走る", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await completeTurn(first, threadId, "前の話", [init(""), say("前の返事", "u1")]);
    const sessionId = first.store.getThread(threadId)!.resumePoint!;
    await cutTurn(first, threadId, "テストを回して", [init(""), say("回します", "u2"), callTool("t1", "mcp__shell__runCommand", "u3")]);

    const runner = scriptedRunner([init(""), say("確かめてから続けます", "u4")]);
    const host = await boot(dir, runner);
    const chain = [human("前の話", "c1"), say("前の返事", "c2"), human("…\n\nテストを回して", "c3"), say("回します", "c4"), callTool("t1", "mcp__shell__runCommand", "c5")];
    const results = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({ [sessionId]: chain }) });
    assert.deepEqual(results.map((r) => r.action), ["continued"]);
    // 待ち受けを始めてから起こす（`resumeAll`）——それまでは走らない
    assert.equal(runner.calls.length, 0);
    host.listen();
    await settled(host, threadId);

    const [call] = runner.calls;
    assert.equal(call?.resumeSessionId, sessionId, "切れた会話を続けていない");
    assert.equal(call?.forkSession, false);
    assert.equal(call?.sessionId, undefined);
    assert.match(call!.prompt, /banto を起こし直したため、直前のターンが途中で切れました/);
    assert.match(call!.prompt, /切れたとき実行中だった呼び出し：mcp__shell__runCommand（\{"command":"make test"\}）——結果は分かりません/);
    assert.doesNotMatch(call!.prompt, /入れ直します/, "届いていた発言まで入れ直した");
    assert.match(call!.prompt, new RegExp(`from="${RESUME_SENDER}" hop="0"`));

    const thread = host.store.getThread(threadId)!;
    const shown = view(host.store, threadId);
    assert.deepEqual([...shown.slice(0, 4), shown[5]], [
      "user:前の話",
      "assistant:前の返事",
      "user:テストを回して",
      `assistant:回します\n\n${INTERRUPTED_NOTE}`,
      "assistant:確かめてから続けます",
    ]);
    assert.ok(shown[4]!.startsWith("user(banto):banto を起こし直したため、直前のターンが途中で切れました（"), shown[4]);
    assert.equal(shown.length, 6);
    assert.equal(thread.messages.filter((m) => m.role === "user" && !m.origin).length, 2, "続きが人の発言になっている");
    assert.equal(thread.lastTurn?.attempt, 1);
    assert.equal(thread.lastTurn?.outcome, "completed");
    assert.equal(thread.lastTurn?.cause, "delivery");
    assert.deepEqual(host.store.listInterruptedTurns(), []);

    // 起き直すたびに同じターンを見つけ直さない
    const again = await boot(dir, scriptedRunner([]));
    assert.deepEqual(await resumeInterruptedTurns({ ...again, projectThread: again.store, sessions: sessionsOf({}) }), []);
  });
});

test("続きは、ほかの届いたものより先に積まれ、速度の上限に数えない（連鎖の上限は効く）", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutTurn(first, threadId, "やって", [init(""), say("途中", "u1")]);
    const host = await boot(dir);
    // 起き直す前から溜まっていた届いたもの
    await host.store.recordDelivery({ threadId, deliveryId: "d-old", from: "subagent", title: "前に届いた", text: "結果", hop: 1 });
    // 速度の上限いっぱいまで、届いたもので起こしたことにする（Runner は何もしない）
    let kicked = 0;
    host.deliveries.setTurnRunner(async () => {
      kicked += 1;
      return true;
    });
    for (let i = 0; i < DELIVERY_LIMITS.wakesPerHour; i++) host.deliveries.kick(threadId);
    assert.equal(host.deliveries.kick(threadId).wake, "held", "上限まで起こしたことになっていない（試験の前提）");
    kicked = 0;

    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    const pending = host.store.getThread(threadId)!.deliveries!;
    assert.deepEqual(pending.map((d) => d.from), [RESUME_SENDER, "subagent"], "続きが先頭に並んでいない");
    assert.equal(host.deliveries.kick(threadId).wake, "now", "続きを速度の上限で止めた");
    assert.equal(kicked, 2);
  });
});

/**
 * 続けて切れるところまで進める：最初のターンを切り、起き直すたびに続きもまた切る。`cuts` 回切れた状態の置き場を返す
 * （最後の起き直しはまだしていない——次に起こす host が `cuts` 回目の切れを見る）
 */
async function cutRepeatedly(dir: string, first: Host, threadId: string, cuts: number): Promise<void> {
  await cutTurn(first, threadId, "長い仕事", [init(""), say("一", "u1")]);
  for (let i = 1; i < cuts; i++) {
    const cutAgain = scriptedRunner([init(""), say(`続き${i}`, `u-c${i}`), "hang"]);
    const host = await boot(dir, cutAgain);
    const results = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    assert.deepEqual(results.map((r) => r.action), ["continued"], `${i} 回目の切れで続けていない`);
    host.listen();
    // 続きのターンが止まった（＝host がそこで止まった）ところで、次の host を起こす
    await cutAgain.hung;
    assert.equal(host.store.getThread(threadId)!.lastTurn?.attempt, i);
  }
}

test(`続けて ${RESUME_CUT_LIMIT} 回切れたら自動で続けず、受信箱に1件——続きは積んで留め、「続ける」を押すと attempt 0 で続く`, async () => {
  assert.equal(RESUME_CUT_LIMIT, 3, "切れた→続ける→切れた→もう一度だけ続ける→切れた（続けて3回）でやめる（ユーザーとの合意）");
  await withDir(async ({ dir, first, threadId }) => {
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);

    // 3回目の切れ：自動では続けない
    const runner = scriptedRunner([init(""), say("三", "u3")]);
    const third = await boot(dir, runner);
    const results = await resumeInterruptedTurns({ ...third, projectThread: third.store, sessions: sessionsOf({}) });
    assert.deepEqual(results.map((r) => r.action), ["stopped-retrying"]);
    third.listen();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runner.calls.length, 0, "続けて切れたのに自動で続けた");
    const thread = third.store.getThread(threadId)!;
    assert.equal(thread.lastTurn?.outcome, "failed");
    assert.match(thread.messages.at(-1)!.text, new RegExp(`続き2\\n\\n${INTERRUPTED_NOTE}$`));
    // 続きは積んである（起こさない）——次に始まるターンが引き継ぐ
    const queued = thread.deliveries?.filter((d) => d.continues) ?? [];
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.continues!.attempt, RESUME_CUT_LIMIT);
    const notices = third.inbox.listOpen().filter((i) => i.kind === "notice");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.kind === "notice" && notices[0]!.title, RESUME_GAVE_UP_TITLE);
    assert.match(notices[0]!.kind === "notice" ? notices[0]!.detail : "", /続けて 3 回切れました/);
    assert.equal(third.deliveries.kick(threadId).wake, "held", "お知らせが開いているのに留めていない");
    // 起き直しても同じものを出し直さない
    const fourth = await boot(dir, scriptedRunner([]));
    assert.deepEqual(await resumeInterruptedTurns({ ...fourth, projectThread: fourth.store, sessions: sessionsOf({}) }), []);

    // 人が「続ける」を押す
    const res = await continueStoppedTurn({ ...third, projectThread: third.store, sessions: sessionsOf({}) }, notices[0]!.id);
    assert.deepEqual(res, { ok: true });
    await settled(third, threadId);
    assert.equal(runner.calls.length, 1);
    assert.match(runner.calls[0]!.prompt, /banto を起こし直したため/);
    const after = third.store.getThread(threadId)!;
    assert.equal(after.lastTurn?.attempt, 0, "人が押した続きなのに切れた回数を数え直していない");
    assert.equal(after.lastTurn?.cause, "delivery");
    assert.equal(after.lastTurn?.outcome, "completed");
    assert.equal(after.messages.filter((m) => m.origin?.from === RESUME_SENDER).length, RESUME_CUT_LIMIT, "続きを二重に積んだ");
    assert.equal(third.inbox.listOpen().filter((i) => i.kind === "notice").length, 0, "押したお知らせが残っている");
    // 押し直しても二度は続けない
    const twice = await continueStoppedTurn({ ...third, projectThread: third.store }, notices[0]!.id);
    assert.equal(twice.ok, false);
  });
});

test("自動で続けるのをやめた Thread は、お知らせが開いている間、届いたもの（Module の札）でも起こさない——「続ける」で一緒に積む", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);
    const runner = scriptedRunner([init(""), say("続けます", "u9")]);
    const host = await boot(dir, runner);
    // cli.ts と同じ順：Module の札（「途中で終わりました」）を先に届け、それから切れたターン
    await host.deliveries.deliver({ threadId, from: "subagent", title: "subagent の仕事は途中で終わりました", text: "もう届きません", hop: 1 });
    const results = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    assert.deepEqual(results.map((r) => r.action), ["stopped-retrying"]);
    host.listen();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(runner.calls.length, 0, "留めていた Thread を届いたもので起こした");
    // 起こし直しのあと届いたものも起こさない。人には「起こしませんでした」と出る
    const late = await host.deliveries.deliver({ threadId, from: "other", title: "あとから届いた", text: "あと", hop: 1 });
    assert.equal(late.wake, "held");
    assert.ok(
      host.inbox.listOpen().some((i) => i.kind === "notice" && i.detail.includes("自動では AI を起こしませんでした——起こし直しのたびに切れるので")),
      "留めたことを人に知らせていない",
    );
    assert.equal(runner.calls.length, 0);
    const pending = host.store.getThread(threadId)!.deliveries!;
    assert.deepEqual(pending.map((d) => d.from), [RESUME_SENDER, "subagent", "other"], "続きが先頭に無い");

    const notice = host.inbox.listOpen().find((i) => i.kind === "notice" && i.title === RESUME_GAVE_UP_TITLE)!;
    assert.deepEqual(await continueStoppedTurn({ ...host, projectThread: host.store, sessions: sessionsOf({}) }, notice.id), { ok: true });
    await settled(host, threadId);
    assert.equal(runner.calls.length, 1, "1つのターンで引き継いでいない");
    const prompt = runner.calls[0]!.prompt;
    assert.ok(prompt.indexOf("banto を起こし直したため") < prompt.indexOf("もう届きません"), "続きが届いたものより後ろ");
    assert.match(prompt, /あと/);
    assert.equal(host.store.getThread(threadId)!.lastTurn?.attempt, 0);
  });
});

test("自動で続けるのをやめたあと人がその Thread で送ると、そのターンが切れた会話を引き継ぐ——attempt 0・cause human・お知らせは片づく", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    // 新しい会話の最初のターンが会話を書いてから切れた——続けるのはその会話（Thread の resume-point には無い）
    const cut = await cutTurn(first, threadId, "最初の頼み", [init(""), say("やります", "u1")]);
    const own = cut.calls[0]!.sessionId!;
    const chains = { [own]: [human("…最初の頼み", "c1"), say("やります", "c2")] };
    for (let i = 1; i < RESUME_CUT_LIMIT; i++) {
      const cutAgain = scriptedRunner([init(""), say(`続き${i}`, `u-c${i}`), "hang"]);
      const host = await boot(dir, cutAgain);
      await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf(chains) });
      host.listen();
      await cutAgain.hung;
      // 続きの続きも同じ会話（Thread の resume-point には無い）
      assert.equal(cutAgain.calls[0]?.resumeSessionId, own, `${i} 回目の続きが切れた会話を続けていない`);
    }
    const host = await boot(dir);
    const results = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf(chains) });
    assert.deepEqual(results.map((r) => r.action), ["stopped-retrying"]);
    assert.equal(host.store.getThread(threadId)!.resumePoint, undefined, "試験の前提：Thread の resume-point に切れた会話が無い");
    await host.deliveries.deliver({ threadId, from: "subagent", title: "結果", text: "留めていた結果", hop: 2 });
    const notice = host.inbox.listOpen().find((i) => i.kind === "notice" && i.title === RESUME_GAVE_UP_TITLE)!;

    // 人が送る
    const runner = await completeTurn(host, threadId, "どうなった？", [init(""), say("確かめます", "u9")]);
    const [call] = runner.calls;
    assert.equal(call?.resumeSessionId, own, "切れた会話を引き継いでいない（新しい会話になった）");
    assert.equal(call?.sessionId, undefined);
    assert.match(call!.prompt, /banto を起こし直したため/);
    assert.match(call!.prompt, /留めていた結果/);
    assert.match(call!.prompt, /（ここから人の発言）\nどうなった？/);
    const thread = host.store.getThread(threadId)!;
    assert.equal(thread.lastTurn?.attempt, 0, "人が送ったのに切れた回数を数え続けた");
    assert.equal(thread.lastTurn?.cause, "human");
    assert.equal(thread.lastTurn?.outcome, "completed");
    assert.equal(thread.resumePoint, own);
    assert.equal(thread.deliveries?.length ?? 0, 0);
    const after = host.inbox.get(notice.id);
    assert.equal(after?.kind === "notice" && after.acknowledged, true, "お知らせが残っている");
    // 押しても、もう引き継がれている
    const res = await continueStoppedTurn({ ...host, projectThread: host.store, sessions: sessionsOf({}) }, notice.id);
    assert.equal(res.ok, false);
  });
});

test("人のターンが続きを引き継いで切れたら、ホップは人のターン（0）・attempt 1 で続ける", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await first.store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "結果", text: "結果です", hop: 3 });
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);
    const host = await boot(dir);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    // 人が送り、それもまた切れる
    await cutTurn(host, threadId, "続けて", [init(""), say("はい", "u9")]);
    assert.equal(host.store.getThread(threadId)!.lastTurn?.cause, "human");
    const runner = scriptedRunner([init(""), say("続き", "u10")]);
    const next = await boot(dir, runner);
    const results = await resumeInterruptedTurns({ ...next, projectThread: next.store, sessions: sessionsOf({}) });
    assert.deepEqual(results.map((r) => [r.action, r.turn.hop, r.turn.attempt]), [["continued", 0, 0]]);
    next.listen();
    await settled(next, threadId);
    assert.match(runner.calls[0]!.prompt, new RegExp(`from="${RESUME_SENDER}" hop="0"`));
    assert.equal(next.store.getThread(threadId)!.lastTurn?.attempt, 1);
  });
});

test("「続ける」を同時に押しても、続きは1回だけ届く", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);
    const runner = scriptedRunner([init(""), say("続けます", "u9")]);
    const host = await boot(dir, runner);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    host.listen();
    const notice = host.inbox.listOpen().find((i) => i.kind === "notice")!;
    const deps = { ...host, projectThread: host.store, sessions: sessionsOf({}) };
    const both = await Promise.all([continueStoppedTurn(deps, notice.id), continueStoppedTurn(deps, notice.id)]);
    // 先にターンを終わらせてから確かめる（走っている途中で置き場を消すと、落ちたあと試験のプロセスが終わらない）
    await settled(host, threadId);
    assert.deepEqual(both.map((r) => r.ok).sort(), [false, true]);
    assert.deepEqual(both.find((r) => !r.ok), { ok: false, status: 409, error: "いま続けています" });
    assert.equal(runner.calls.length, 1, "続きが二重に走った");
    assert.equal(host.store.getThread(threadId)!.messages.filter((m) => m.origin?.from === RESUME_SENDER).length, RESUME_CUT_LIMIT);
  });
});

test("「続ける」の出し直しが、人が送ったターンが続きを積んだあとに届いても、続きを二度は積まない", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);
    const host = await boot(dir);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    // 「続ける」が待ち行列の続きを読んだところで、人が送ったターンが先に積んだ
    const [queued] = host.store.getThread(threadId)!.deliveries!;
    await completeTurn(host, threadId, "どうなった？", [init(""), say("確かめます", "u9")]);
    assert.equal(host.store.getThread(threadId)!.deliveries?.length ?? 0, 0);
    // 遅れて出し直しが届く（同じ届いたものを置き換える形）
    await host.deliveries.deliver(
      { threadId, from: queued!.from, title: queued!.title, text: queued!.text, hop: queued!.hop, notify: false, continues: { ...queued!.continues!, attempt: 0 }, replaces: queued!.deliveryId },
      { wake: false },
    );
    assert.equal(host.store.getThread(threadId)!.deliveries?.length ?? 0, 0, "引き継がれた続きがまた待ち行列に入った");
    // 読み直しても同じ（fold）
    const again = await boot(dir);
    assert.equal(again.store.getThread(threadId)!.deliveries?.length ?? 0, 0);
  });
});

test("留めている間に人が Clear したら、続きは捨てて留めも外れる——「続ける」は断る", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);
    const runner = scriptedRunner([init(""), say("結果を読みました", "u9")]);
    const host = await boot(dir, runner);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    await host.deliveries.deliver({ threadId, from: "subagent", title: "結果", text: "終わった", hop: 1 });
    const notice = host.inbox.listOpen().find((i) => i.kind === "notice" && i.title === RESUME_GAVE_UP_TITLE)!;
    await host.store.clearThread(threadId);
    assert.deepEqual(host.store.getThread(threadId)!.deliveries?.map((d) => d.from), ["subagent"], "続きが残っている");
    host.listen();
    await settled(host, threadId);
    assert.equal(runner.calls.length, 1, "留めが外れていない");
    assert.doesNotMatch(runner.calls[0]!.prompt, /起こし直したため/, "畳んだ会話の続きを積んだ");
    const res = await continueStoppedTurn({ ...host, projectThread: host.store, sessions: sessionsOf({}) }, notice.id);
    assert.equal(res.ok, false);
  });
});

test("お知らせを「確認した」で片づけると留めは外れる（続きは積んだまま——次に起こしたターンが上限の attempt で引き継ぐ）", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutRepeatedly(dir, first, threadId, RESUME_CUT_LIMIT);
    const host = await boot(dir);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    host.deliveries.setTurnRunner(async () => true);
    assert.equal(host.deliveries.kick(threadId).wake, "held");
    const notice = host.inbox.listOpen().find((i) => i.kind === "notice")!;
    await host.inbox.acknowledgeNotice(notice.id);
    assert.equal(host.deliveries.kick(threadId).wake, "now");
    assert.equal(host.store.getThread(threadId)!.deliveries?.[0]?.continues?.attempt, RESUME_CUT_LIMIT);
  });
});

test("続きを積む前に切れた続きのターンも、切れた回数に数える——上限で止まる", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutTurn(first, threadId, "やって", [init(""), say("途中", "u1")]);
    let host = await boot(dir);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    const continued = host.store.getThread(threadId)!.deliveries![0]!;
    for (let cuts = 2; cuts <= RESUME_CUT_LIMIT; cuts++) {
      // 続きのターンが始まりだけ書いて、続きを積む前に止まった（turn-runner と同じ値で始める）
      const queued = host.store.getThread(threadId)!.deliveries!.find((d) => d.continues)!;
      await host.store.startTurn(threadId, {
        cause: "delivery",
        attempt: queued.continues!.attempt,
        continues: { turnId: queued.continues!.turnId, fromSeq: queued.continues!.fromSeq },
      });
      host = await boot(dir);
      const results = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
      assert.deepEqual(results.map((r) => r.action), [cuts >= RESUME_CUT_LIMIT ? "stopped-retrying" : "continued"], `${cuts} 回目`);
      const pending = host.store.getThread(threadId)!.deliveries!.filter((d) => d.continues);
      assert.equal(pending.length, 1, "続きを二重に積んだ");
      assert.equal(pending[0]!.deliveryId, continued.deliveryId, "同じ届いたものを置き換えていない");
      assert.equal(pending[0]!.continues!.attempt, cuts, "切れた回数を数えていない");
      assert.equal(pending[0]!.text, continued.text);
    }
    assert.equal(host.inbox.listOpen().filter((i) => i.kind === "notice" && i.title === RESUME_GAVE_UP_TITLE).length, 1);
    host.deliveries.setTurnRunner(async () => true);
    assert.equal(host.deliveries.kick(threadId).wake, "held");
  });
});

test("続きを引き継いだ人のターンを、AI が何も出す前に止めたら：取り消さず（届いたものも積んだターン）、切れた会話は残る", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    const cut = await cutTurn(first, threadId, "最初の頼み", [init(""), say("やります", "u1")]);
    const own = cut.calls[0]!.sessionId!;
    const host = await boot(dir);
    await resumeInterruptedTurns({
      ...host,
      projectThread: host.store,
      sessions: sessionsOf({ [own]: [human("…最初の頼み", "c1"), say("やります", "c2")] }),
    });
    // 起き直した直後、続きを起こす前に人が送り、`system/init` の前に止めた
    const stop = new AbortController();
    const stopped = scriptedRunner(["hang"]);
    const done = collect(runThreadTurn({ ...host.deps, runTurn: stopped.fake }, { threadId, prompt: "待って", modules: [], stop: stop.signal }));
    await stopped.hung;
    assert.equal(stopped.calls[0]?.resumeSessionId, own);
    stop.abort();
    const events = await done;
    const end = events.at(-1)!;
    assert.equal(end.type, "stopped");
    assert.equal(end.type === "stopped" ? end.withdrawn : "x", undefined, "届いたものも積んだターンを取り消した");
    const thread = host.store.getThread(threadId)!;
    assert.equal(thread.lastTurn?.outcome, "stopped");
    assert.equal(thread.lastTurn?.attempt, 0);
    assert.equal(thread.deliveries?.length ?? 0, 0, "続きが待ち行列に戻った（積んだまま止めた）");
    assert.ok(thread.messages.some((m) => m.origin?.from === RESUME_SENDER), "続きが記録に無い");
    assert.ok(thread.messages.some((m) => m.role === "user" && !m.origin && m.text === "待って"), "人の発言を取り消した");
    assert.equal(thread.resumePoint, own, "止めたら切れた会話を失った（次のターンが新しい会話になる）");
    assert.deepEqual(host.store.listInterruptedTurns(), []);
  });
});

test("続けたターンが終われば数え直す——次に切れたらまた自動で続く", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutTurn(first, threadId, "一つ目", [init(""), say("一", "u1")]);
    const second = await boot(dir, scriptedRunner([init(""), say("続けました", "u2")]));
    await resumeInterruptedTurns({ ...second, projectThread: second.store, sessions: sessionsOf({}) });
    second.listen();
    await settled(second, threadId);
    // 人の次のターンが切れる——attempt は 0 から
    await cutTurn(second, threadId, "二つ目", [init(""), say("二", "u3")]);
    assert.equal(second.store.getThread(threadId)!.lastTurn?.attempt, 0);
    const third = await boot(dir, scriptedRunner([init(""), say("また続けました", "u4")]));
    const results = await resumeInterruptedTurns({ ...third, projectThread: third.store, sessions: sessionsOf({}) });
    assert.deepEqual(results.map((r) => r.action), ["continued"]);
  });
});

for (const [name, quit] of [
  ["Clear", (h: Host, id: string) => h.store.clearThread(id)],
  ["Thread を閉じた", (h: Host, id: string) => h.store.closeThread(id)],
  ["Project を閉じた", (h: Host, id: string) => h.store.closeProject(h.store.getThread(id)!.projectId)],
] as const) {
  test(`${name}あとに切れたものは続けない`, async () => {
    await withDir(async ({ dir, first, threadId }) => {
      await cutTurn(first, threadId, "やって", [init(""), say("途中", "u1")]);
      await quit(first, threadId);
      const runner = scriptedRunner([init(""), say("続き", "u2")]);
      const host = await boot(dir, runner);
      assert.deepEqual(await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) }), []);
      host.listen();
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(runner.calls.length, 0);
      assert.equal(host.store.getThread(threadId)!.deliveries?.length ?? 0, 0);
    });
  });
}

test("発言を1つも積まないうちに切れたターンは続けず閉じる——届いていたものは resumeAll が起こす", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await first.store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "結果", text: "終わった", hop: 1 });
    // 始まりだけ書いて、発言を積む前に止まった
    const turnId = await first.store.startTurn(threadId, { cause: "delivery", attempt: 0 });
    const runner = scriptedRunner([init(""), say("結果を読みました", "u1")]);
    const host = await boot(dir, runner);
    const results = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    assert.deepEqual(results.map((r) => r.action), ["closed"]);
    assert.equal(host.store.getThread(threadId)!.lastTurn?.turnId, turnId);
    assert.equal(host.store.getThread(threadId)!.lastTurn?.outcome, "failed");
    assert.deepEqual(host.store.getThread(threadId)!.deliveries?.map((d) => d.deliveryId), ["d1"]);
    assert.ok(!host.store.getThread(threadId)!.messages.some((m) => m.text.includes(INTERRUPTED_NOTE)), "何も無い会話に印を足した");
    host.listen();
    await settled(host, threadId);
    assert.equal(runner.calls.length, 1);
    assert.match(runner.calls[0]!.prompt, /終わった/);
    assert.doesNotMatch(runner.calls[0]!.prompt, /起こし直したため/);
  });
});

test("新しい会話の最初のターンが会話を書く前に切れたら、同じ id で最初から——発言を入れ直す（記録には積み直さない）", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    const cut = await cutTurn(first, threadId, "最初の頼み", [init("")]);
    const assigned = cut.calls[0]!.sessionId!;
    const runner = scriptedRunner([init(""), say("はい", "u1")]);
    const host = await boot(dir, runner);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    host.listen();
    await settled(host, threadId);
    const [call] = runner.calls;
    assert.equal(call?.sessionId, assigned, "同じ id で走らせ直していない");
    assert.equal(call?.resumeSessionId, undefined);
    assert.match(call!.prompt, /AI に届く前に切れました/);
    assert.match(call!.prompt, /【人の発言】\n最初の頼み/);
    assert.doesNotMatch(call!.prompt, /実行中だった呼び出し/);
    const thread = host.store.getThread(threadId)!;
    assert.equal(thread.messages.filter((m) => m.role === "user" && !m.origin).length, 1, "人の発言を記録に積み直した");
    assert.equal(thread.resumePoint, assigned);
    // 切れた吹き出しから Fork を分けても、続けた会話から始まる（resume-point の履歴は切れたターンの始まりから）
    const cutReply = thread.messages.find((m) => m.text === INTERRUPTED_NOTE)!;
    const fork = await host.store.forkThread(threadId, { fromSeq: cutReply.seq });
    assert.equal(fork.resumePoint, assigned, "切れた吹き出しから分けたらまっさらになった");
  });
});

test("新しい会話の最初のターンが会話を書いてから切れたら、その会話を続ける", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    const cut = await cutTurn(first, threadId, "最初の頼み", [init(""), say("やります", "u1")]);
    const assigned = cut.calls[0]!.sessionId!;
    const runner = scriptedRunner([init(""), say("続けます", "u2")]);
    const host = await boot(dir, runner);
    await resumeInterruptedTurns({
      ...host,
      projectThread: host.store,
      sessions: sessionsOf({ [assigned]: [human("…最初の頼み", "c1"), say("やります", "c2")] }),
    });
    host.listen();
    await settled(host, threadId);
    assert.equal(runner.calls[0]?.resumeSessionId, assigned);
    assert.equal(runner.calls[0]?.sessionId, undefined);
    assert.doesNotMatch(runner.calls[0]!.prompt, /入れ直します/);
    assert.equal(host.store.getThread(threadId)!.resumePoint, assigned);
  });
});

test("新しい会話の最初のターンが会話を書いてから切れ、その続きが会話の id を名乗る前にまた切れても、次の続きは同じ会話を続ける", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    const cut = await cutTurn(first, threadId, "最初の頼み", [init(""), say("やります", "u1")]);
    const own = cut.calls[0]!.sessionId!;
    const chains = { [own]: [human("…最初の頼み", "c1"), say("やります", "c2")] };
    // 続き：切れた会話を続けるが、`system/init` の前に止まる（続きは積んである）
    const second = scriptedRunner(["hang"]);
    const host2 = await boot(dir, second);
    await resumeInterruptedTurns({ ...host2, projectThread: host2.store, sessions: sessionsOf(chains) });
    host2.listen();
    await second.hung;
    assert.equal(second.calls[0]?.resumeSessionId, own);
    assert.equal(host2.store.getThread(threadId)!.resumePoint, undefined, "試験の前提：Thread の resume-point に切れた会話が無い");

    const third = scriptedRunner([init(""), say("最後まで", "u3")]);
    const host3 = await boot(dir, third);
    const results = await resumeInterruptedTurns({ ...host3, projectThread: host3.store, sessions: sessionsOf(chains) });
    assert.deepEqual(results.map((r) => r.action), ["continued"]);
    host3.listen();
    await settled(host3, threadId);
    assert.equal(third.calls[0]?.resumeSessionId, own, "切れた会話を捨てて新しい会話になった");
    assert.equal(third.calls[0]?.sessionId, undefined);
    assert.doesNotMatch(third.calls[0]!.prompt, /AI に届く前に切れました/);
    assert.equal(host3.store.getThread(threadId)!.resumePoint, own);
  });
});

test("Fork の最初のターン：会話を書く前に切れたら親から新しい id で分け直し、書いてからならその会話を続ける", async () => {
  for (const written of [false, true]) {
    await withDir(async ({ dir, first, threadId }) => {
      await completeTurn(first, threadId, "親の話", [init(""), say("親の返事", "u1")]);
      const parentSession = first.store.getThread(threadId)!.resumePoint!;
      const fork = await first.store.forkThread(threadId);
      const cut = await cutTurn(first, fork.id, "Fork で頼む", [init(""), ...(written ? [say("分けて始めます", "u2")] : [])]);
      const forkSession = cut.calls[0]!.sessionId!;
      assert.equal(cut.calls[0]?.forkSession, true);

      const runner = scriptedRunner([init(""), say("続きです", "u3")]);
      const host = await boot(dir, runner);
      const chains = written ? { [forkSession]: [human("…Fork で頼む", "c1"), say("分けて始めます", "c2")] } : {};
      await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf(chains) });
      host.listen();
      await settled(host, fork.id);
      const [call] = runner.calls;
      if (written) {
        assert.equal(call?.resumeSessionId, forkSession);
        assert.equal(call?.forkSession, false);
        assert.equal(call?.sessionId, undefined);
        assert.doesNotMatch(call!.prompt, /入れ直します/);
      } else {
        // 同じ id は「already in use」になる（実測 F1）——新しい id で親から分け直す
        assert.equal(call?.resumeSessionId, parentSession);
        assert.equal(call?.forkSession, true);
        assert.ok(call?.sessionId && call.sessionId !== forkSession, "同じ id で分け直した");
        assert.match(call!.prompt, /【人の発言】\nFork で頼む/);
      }
      assert.equal(host.store.getThread(fork.id)!.ownsSession, true);
    });
  }
});

test("巻き戻しの上で切れたターンは、巻き戻しの位置を保ったまま続け、切れたターンの発言を入れ直す", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await completeTurn(first, threadId, "りんご", [init(""), say("りんごの返事", "u-apple")]);
    // 人が止めて取り消した——次のターンは u-apple までで切って続ける
    const stop = new AbortController();
    const stopped = scriptedRunner([init(""), "hang"]);
    const done = collect(runThreadTurn({ ...first.deps, runTurn: stopped.fake }, { threadId, prompt: "まちがい", modules: [], stop: stop.signal }));
    await stopped.hung;
    stop.abort();
    await done;
    assert.equal(first.store.getThread(threadId)!.rewindTo, "u-apple");
    const cut = await cutTurn(first, threadId, "ぶどう", [init(""), say("ぶどうの", "u2"), callTool("t1", "mcp__shell__runCommand", "u3")]);
    assert.equal(cut.calls[0]?.resumeSessionAt, "u-apple");

    const runner = scriptedRunner([init(""), say("続き", "u4")]);
    const host = await boot(dir, runner);
    // SDK が読むのは切れたターンを含む新しい鎖（実測 M1）——呼び出しはそこから拾う
    const chain = [human("りんご", "c1"), say("りんごの返事", "u-apple"), human("…ぶどう", "c3"), say("ぶどうの", "c4"), callTool("t1", "mcp__shell__runCommand", "c5")];
    const sessionId = host.store.getThread(threadId)!.resumePoint!;
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({ [sessionId]: chain }) });
    host.listen();
    await settled(host, threadId);
    const [call] = runner.calls;
    assert.equal(call?.resumeSessionId, sessionId);
    assert.equal(call?.resumeSessionAt, "u-apple", "巻き戻しの位置を保っていない（取り消した古い鎖が戻る）");
    assert.match(call!.prompt, /切れたターンは会話の記録から外れるので、そのとき渡したものをここに入れ直します/);
    assert.match(call!.prompt, /【人の発言】\nぶどう/);
    assert.match(call!.prompt, /実行中だった呼び出し：mcp__shell__runCommand/);
    assert.equal(host.store.getThread(threadId)!.rewindTo, undefined, "続きが最後まで行ったのに巻き戻しが残っている");
  });
});

test("承認を待っていた呼び出しは「無効になりました」、予約した Fork は「立っていません」、読めなければ「分かりません」", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await completeTurn(first, threadId, "前", [init(""), say("前の返事", "u0")]);
    await cutTurn(first, threadId, "消して", [
      init(""),
      callTool("f1", "mcp__banto-thread__start_forks", "u1", { forks: [] }),
      toolResult("f1", "u2"),
      callTool("t9", "mcp__shell__runCommand", "u3", { command: "rm -rf build" }),
      { approval: { id: "t9", name: "mcp__shell__runCommand" } },
    ]);
    assert.equal(first.inbox.listOpen().filter((i) => i.kind === "judgment").length, 1);

    const runner = scriptedRunner([init(""), say("続き", "u4")]);
    const host = await boot(dir, runner);
    const chain = [human("…消して", "c1"), callTool("f1", "mcp__banto-thread__start_forks", "c2", { forks: [] }), toolResult("f1", "c3"), callTool("t9", "mcp__shell__runCommand", "c4", { command: "rm -rf build" })];
    const sessionId = host.store.getThread(threadId)!.resumePoint!;
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({ [sessionId]: chain }) });
    host.listen();
    await settled(host, threadId);
    const prompt = runner.calls[0]!.prompt;
    assert.match(prompt, /mcp__shell__runCommand は承認を待ったまま無効になりました（実行されていません）/);
    assert.doesNotMatch(prompt, /実行中だった呼び出し/, "承認を待っていた呼び出しを実行中に数えた（または記録を読めなかった）");
    assert.match(prompt, /このターンで頼んだ Fork は立っていません/);

    // 会話の記録が読めないとき
    await cutTurn(host, threadId, "もう一度", [init(""), say("途中", "u5")]);
    const runner2 = scriptedRunner([init(""), say("続き", "u6")]);
    const again = await boot(dir, runner2);
    await resumeInterruptedTurns({ ...again, projectThread: again.store, sessions: sessionsOf({ [sessionId]: [] }, { unreadable: true }) });
    again.listen();
    await settled(again, threadId);
    assert.match(runner2.calls[0]!.prompt, /切れたとき実行中だった呼び出しは分かりません（会話の記録を読めませんでした）/);
    assert.match(runner2.calls[0]!.prompt, /届いたか分からないので、ここに入れ直します/);
  });
});

// **止める間に断った呼び出し・呼び出しの中で人を待っていたもの**（追加・2026-10-05、Fable のレビュー）。断った呼び出しは
// 結果に `RESTARTING_REFUSAL` が残る——「実行されていません」。中継の承認・質問は判断待ちの `withinToolCallId` で外側の
// 呼び出しに照らす——承認は「実行されていません」、質問は「途中まで進んでいたかもしれません」。照らせないものは今までどおり
// 実行中だった呼び出し
test("断った呼び出しは「起こし直し中のため断った」、中継の承認・質問を待っていた呼び出しは判断待ちが属する呼び出しで照らす", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await completeTurn(first, threadId, "前", [init(""), say("前の返事", "u0")]);
    const refusedResult = (id: string, uuid: string) => ({
      type: "user",
      uuid,
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text: RESTARTING_REFUSAL }] }] },
    });
    const script = [
      init(""),
      callTool("r1", "mcp__shell__runCommand", "u1", { command: "make deploy" }),
      refusedResult("r1", "u2"),
      callTool("a1", "mcp__subagent__runSubagent", "u3", { prompt: "調べて" }),
      callTool("e1", "mcp__publish__publishService", "u4", { name: "web" }),
      callTool("x1", "mcp__shell__runCommand", "u5", { command: "sleep 100" }),
    ];
    await cutTurn(first, threadId, "進めて", script);
    // 切れたターンの中で出た判断待ち（起き直すと期限切れになる）
    await first.inbox.raiseJudgment({ threadId, source: "relay", message: "Module 間の呼び出しの確認", serverName: "subagent", withinToolCallId: "a1" });
    await first.inbox.raiseJudgment({ threadId, source: "elicitation", message: "パスワードは？", serverName: "publish", withinToolCallId: "e1" });
    // 照らせない質問（外側の呼び出しが決まらなかった）は何も足さない
    await first.inbox.raiseJudgment({ threadId, source: "elicitation", message: "どれ？", serverName: "shell" });

    const runner = scriptedRunner([init(""), say("続き", "u9")]);
    const host = await boot(dir, runner);
    const chain = [human("…進めて", "c1"), ...script.slice(1)];
    const sessionId = host.store.getThread(threadId)!.resumePoint!;
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({ [sessionId]: chain }) });
    host.listen();
    await settled(host, threadId);
    const prompt = runner.calls[0]!.prompt;
    assert.match(prompt, /起こし直し中のため断った呼び出し：mcp__shell__runCommand（\{"command":"make deploy"\}）——実行されていません/);
    assert.match(
      prompt,
      /mcp__subagent__runSubagent は Module 間の呼び出しの承認を待ったまま無効になりました（承認を待っていた呼び出しは実行されていません）/,
    );
    assert.match(prompt, /mcp__publish__publishService は質問の答えを待ったまま無効になりました（途中まで進んでいたかもしれません）/);
    // 照らした呼び出しは「実行中だった」に重ねない。照らせない呼び出しだけが実行中だった
    const running = [...prompt.matchAll(/実行中だった呼び出し：(\S+)（([^）]*)）/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(running, ['mcp__shell__runCommand {"command":"sleep 100"}']);
    assert.doesNotMatch(prompt, /make deploy[^\n]*結果は分かりません/, "断った呼び出しを実行中に数えた");
  });
});

test("続きを届けたあと閉じる前に落ちても、続きを二重に届けない", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await cutTurn(first, threadId, "やって", [init(""), say("途中", "u1")]);
    const host = await boot(dir);
    const turnId = host.store.listInterruptedTurns()[0]!.turnId;
    // 続きは届けたが、閉じる（turn.ended）前に落ちた形を作る
    const endTurn = host.store.endTurn.bind(host.store);
    host.store.endTurn = (async () => {
      throw new Error("ここで落ちた");
    }) as typeof host.store.endTurn;
    const failed = await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    assert.deepEqual(failed.map((r) => r.action), ["failed"]);
    host.store.endTurn = endTurn;

    const again = await boot(dir);
    assert.equal(again.store.listInterruptedTurns()[0]?.turnId, turnId);
    await resumeInterruptedTurns({ ...again, projectThread: again.store, sessions: sessionsOf({}) });
    assert.equal(again.store.getThread(threadId)!.deliveries?.filter((d) => d.continues).length, 1, "続きを二重に届けた");
    assert.deepEqual(again.store.listInterruptedTurns(), []);
  });
});

test("続きでも連鎖の上限（ホップ）は効く", async () => {
  await withDir(async ({ first, threadId }) => {
    first.deliveries.setTurnRunner(async () => true);
    const turnId = (await first.store.startTurn(threadId, { cause: "delivery", attempt: 0 }));
    const r = await first.deliveries.deliver({
      threadId,
      from: RESUME_SENDER,
      title: "続き",
      text: "続き",
      hop: DELIVERY_LIMITS.maxHop + 1,
      notify: false,
      continues: { turnId, attempt: 1, fromSeq: 1 },
    });
    assert.equal(r.wake, "held");
  });
});

test("続きを届けたあと、走る前に人が Clear したら、続きは捨てる——次に人が送ったターンは新しい会話で、Clear より前に会話の始まりを置かない", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    const cut = await cutTurn(first, threadId, "最初の頼み", [init(""), say("やります", "u1")]);
    const assigned = cut.calls[0]!.sessionId!;
    const runner = scriptedRunner([init(""), say("新しい会話で", "u2")]);
    const host = await boot(dir, runner);
    await resumeInterruptedTurns({
      ...host,
      projectThread: host.store,
      sessions: sessionsOf({ [assigned]: [human("…最初の頼み", "c1"), say("やります", "c2")] }),
    });
    await host.store.clearThread(threadId);
    assert.equal(host.store.getThread(threadId)!.deliveries?.length ?? 0, 0, "畳んだ会話の続きが残っている");
    host.listen();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runner.calls.length, 0, "畳んだ会話の続きを走らせた");
    const next = await completeTurn(host, threadId, "新しい話", [init(""), say("はい", "u3")]);
    const [call] = next.calls;
    assert.equal(call?.resumeSessionId, undefined, "Clear で捨てた会話を続けた");
    assert.ok(call?.sessionId && call.sessionId !== assigned);
    assert.doesNotMatch(call!.prompt, /起こし直したため/);
    const thread = host.store.getThread(threadId)!;
    assert.equal(thread.lastTurn?.continuesFromSeq, undefined);
    assert.equal(thread.resumePoints.at(-1)?.seq, thread.lastTurn?.startedSeq, "Clear より前に新しい会話の始まりを置いた");
  });
});

test("続きのターンが走っている途中（会話の id を名乗る前）に Clear しても、終わりの resume-point が Clear を取り消さない", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    const cut = await cutTurn(first, threadId, "最初の頼み", [init(""), say("やります", "u1")]);
    const assigned = cut.calls[0]!.sessionId!;
    // 続きは名乗る前に止まっている——そこで人が Clear し、そのあと最後まで行く
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    const runner = scriptedRunner([]);
    const host = await boot(dir, {
      ...runner,
      fake: (async function* (opts: RunnerTurnOptions) {
        await gate;
        yield* runner.fake({ ...opts }) as AsyncGenerator<never>;
        return { sessionId: opts.resumeSessionId ?? "x", compactionCount: 0 } as never;
      }) as unknown as typeof runTurn,
    });
    await resumeInterruptedTurns({
      ...host,
      projectThread: host.store,
      sessions: sessionsOf({ [assigned]: [human("…最初の頼み", "c1"), say("やります", "c2")] }),
    });
    host.listen();
    for (let i = 0; i < 200 && !host.turns.isRunning(threadId); i++) await new Promise((r) => setTimeout(r, 5));
    await host.store.clearThread(threadId);
    go();
    await settled(host, threadId);
    assert.equal(host.store.getThread(threadId)!.resumePoint, undefined, "Clear が取り消された");
  });
});

test("続きで起こしたことは、あとの届いたものの速度の上限に数えない", async () => {
  await withDir(async ({ first, threadId }) => {
    first.deliveries.setTurnRunner(async () => true);
    await first.store.recordDelivery({ threadId, deliveryId: "d-normal", from: "subagent", title: "結果", text: "結果", hop: 1 });
    for (let i = 0; i < DELIVERY_LIMITS.wakesPerHour - 1; i++) assert.equal(first.deliveries.kick(threadId).wake, "now");
    const turnId = await first.store.startTurn(threadId, { cause: "delivery", attempt: 0 });
    const r = await first.deliveries.deliver({
      threadId,
      from: RESUME_SENDER,
      title: "続き",
      text: "続き",
      hop: 1,
      notify: false,
      continues: { turnId, attempt: 1, fromSeq: 1 },
    });
    assert.equal(r.wake, "now");
    // 続きを積んだ（待ち行列から外れた）——残りはふつうの届いたものだけ
    await first.store.appendMessage(threadId, "user", "続き", undefined, { from: RESUME_SENDER, title: "続き", hop: 1, deliveryId: r.deliveryId });
    assert.equal(first.deliveries.kick(threadId).wake, "now", "続きで起こしたことを速度の上限に数えた");
  });
});

test("届いたもので起こしたターンの続きは、同じホップで起こす", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await first.store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "結果", text: "結果です", hop: 3 });
    const cut = scriptedRunner([init(""), say("読みます", "u1"), "hang"]);
    void collect(runThreadTurn({ ...first.deps, runTurn: cut.fake }, { threadId, prompt: "", modules: [] }));
    await cut.hung;
    const runner = scriptedRunner([init(""), say("続き", "u2")]);
    const host = await boot(dir, runner);
    await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
    host.listen();
    await settled(host, threadId);
    assert.match(runner.calls[0]!.prompt, new RegExp(`from="${RESUME_SENDER}" hop="3"`));
    // 届いたものも入れ直す（会話の記録が無い）
    assert.match(runner.calls[0]!.prompt, /【subagent から届いたもの：結果】\n結果です/);
  });
});

test("続いている会話で、切れたターンの発言が CLI の記録にまだ無ければ（書く前に切れた）入れ直す", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await completeTurn(first, threadId, "前の話", [init(""), say("前の返事", "u1")]);
    const sessionId = first.store.getThread(threadId)!.resumePoint!;
    await cutTurn(first, threadId, "新しい頼み", [init("")]);
    const runner = scriptedRunner([init(""), say("続き", "u2")]);
    const host = await boot(dir, runner);
    // CLI の鎖は前のターンで終わっている
    await resumeInterruptedTurns({
      ...host,
      projectThread: host.store,
      sessions: sessionsOf({ [sessionId]: [human("…前の話", "c1"), say("前の返事", "c2")] }),
    });
    host.listen();
    await settled(host, threadId);
    assert.match(runner.calls[0]!.prompt, /届いたか分からないので、ここに入れ直します：\n\n【人の発言】\n新しい頼み/);
    assert.doesNotMatch(runner.calls[0]!.prompt, /実行中だった呼び出し/, "前のターンの呼び出しを拾った");
  });
});

test("巻き戻しの上で、続きのターンが CLI に何も書く前にまた切れたら、鎖（前の切れたターンのもの）から実行中の呼び出しを拾わない", async () => {
  await withDir(async ({ dir, first, threadId }) => {
    await completeTurn(first, threadId, "りんご", [init(""), say("りんごの返事", "u-apple")]);
    const stop = new AbortController();
    const stopped = scriptedRunner([init(""), "hang"]);
    const done = collect(runThreadTurn({ ...first.deps, runTurn: stopped.fake }, { threadId, prompt: "まちがい", modules: [], stop: stop.signal }));
    await stopped.hung;
    stop.abort();
    await done;
    await cutTurn(first, threadId, "ぶどう", [init(""), say("ぶどうの", "u2"), callTool("t1", "mcp__shell__runCommand", "u3")]);
    const sessionId = first.store.getThread(threadId)!.resumePoint!;
    // 1つめの切れ：鎖の末尾は切れたターン（「ぶどう」）——拾う
    const cutChain = [human("りんご", "c1"), say("りんごの返事", "u-apple"), human("…ぶどう", "c3"), say("ぶどうの", "c4"), callTool("t1", "mcp__shell__runCommand", "c5")];
    const cutAgain = scriptedRunner([init(""), "hang"]);
    const second = await boot(dir, cutAgain);
    await resumeInterruptedTurns({ ...second, projectThread: second.store, sessions: sessionsOf({ [sessionId]: cutChain }) });
    second.listen();
    await cutAgain.hung;
    assert.match(cutAgain.calls[0]!.prompt, /実行中だった呼び出し：mcp__shell__runCommand/);
    assert.equal(cutAgain.calls[0]?.resumeSessionAt, "u-apple");

    // 2つめの切れ：続きのターンは CLI に何も書いていない——SDK が返す鎖は1つめの切れたターンのまま
    const runner = scriptedRunner([init(""), say("続き", "u9")]);
    const third = await boot(dir, runner);
    await resumeInterruptedTurns({ ...third, projectThread: third.store, sessions: sessionsOf({ [sessionId]: cutChain }) });
    third.listen();
    await settled(third, threadId);
    const prompt = runner.calls[0]!.prompt;
    // 入れ直した発言（1つめの続きの文）の中には前の呼び出しが書いてある——見るのはそれより前の、この切れについての行
    const own = prompt.slice(0, prompt.indexOf("入れ直します："));
    assert.doesNotMatch(own, /実行中だった呼び出し：/, "前の切れたターンの呼び出しを、この切れで実行中だったと書いた");
    assert.match(prompt, /切れたとき実行中だった呼び出しは分かりません（切れたターンが会話の記録に見つかりませんでした）/);
    assert.match(prompt, /切れたターンは会話の記録から外れるので、そのとき渡したものをここに入れ直します/);
    assert.equal(runner.calls[0]?.resumeSessionAt, "u-apple");
  });
});

test("続けると答えた Module の仕事（keptReplies）は「続いています」と書く。会話の記録は Runner の cwd（Project の root）で引く", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await completeTurn(first, threadId, "前", [init(""), say("前の返事", "u0")]);
    const sessionId = first.store.getThread(threadId)!.resumePoint!;
    await cutTurn(first, threadId, "調べて", [init(""), say("調べます", "u1")]);
    const runner = scriptedRunner([init(""), say("続き", "u2")]);
    const host = await boot(dir, runner);
    const asked: Array<[string, string | undefined]> = [];
    const chains = { [sessionId]: [human("…調べて", "c1"), say("調べます", "c2")] };
    const sessions: SessionReader = {
      exists: async (id, at) => (asked.push([id, at]), id in chains),
      messages: async (id, at) => (asked.push([id, at]), (chains[id] ?? []) as SessionMessage[]),
    };
    await resumeInterruptedTurns({
      ...host,
      projectThread: host.store,
      sessions,
      keptReplies: (id) => (id === threadId ? [{ moduleName: "subagent" }] : []),
    });
    host.listen();
    await settled(host, threadId);
    assert.match(runner.calls[0]!.prompt, /subagent の仕事は続いています（終わったら届きます）/);
    const root = host.store.getProject(projectId)!.root;
    assert.ok(asked.length > 0);
    assert.deepEqual(asked.map(([, at]) => at), asked.map(() => root), "Runner の cwd で引いていない");
  });
});

for (const [name, quit] of [
  ["Clear した", (h: Host, id: string) => h.store.clearThread(id)],
  ["Thread を閉じた", (h: Host, id: string) => h.store.closeThread(id)],
  ["Project を閉じた", (h: Host, id: string) => h.store.closeProject(h.store.getThread(id)!.projectId)],
] as const) {
  test(`待ち行列の続きは、${name}ら捨てる（ほかの届いたものは残す）`, async () => {
    await withDir(async ({ dir, first, threadId }) => {
      await cutTurn(first, threadId, "やって", [init(""), say("途中", "u1")]);
      const host = await boot(dir);
      await resumeInterruptedTurns({ ...host, projectThread: host.store, sessions: sessionsOf({}) });
      await host.store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "結果", text: "結果", hop: 1 });
      assert.deepEqual(host.store.getThread(threadId)!.deliveries?.map((d) => d.from), [RESUME_SENDER, "subagent"]);
      await quit(host, threadId);
      assert.deepEqual(host.store.getThread(threadId)!.deliveries?.map((d) => d.from), ["subagent"]);
      // 読み直しても同じ（fold）
      const again = await boot(dir);
      assert.deepEqual(again.store.getThread(threadId)!.deliveries?.map((d) => d.from), ["subagent"]);
    });
  });
}

// ---- 起き直したときの札の判定（追加・2026-10-05、アーキ仕様 §2.5「2. Module の仕事を続ける」、`restart-recovery.ts`）----

const RESUMABLE = "subagent";
const PLAIN = "shell";

/**
 * cli.ts と同じ形で組む。`ask` は Module の答え（呼ばれた問いと打ち切りの合図を控える）。`connect` を渡せば起こす所を
 * 差し替える（遅れて繋がる等）
 */
function recoveryOf(
  host: Host,
  ask: (target: ResumeTarget, q: ResumeQuestion, signal: AbortSignal) => Promise<unknown>,
  opts: {
    askTimeoutMs?: number;
    connect?: (target: ResumeTarget, signal: AbortSignal) => Promise<void>;
    moduleReplies?: RestartRecoveryDeps["moduleReplies"];
    resumable?: (t: { moduleName: string; projectId?: string }) => boolean;
  } = {},
) {
  const replyHandles = new ReplyHandles();
  const asked: Array<{ target: ResumeTarget; q: ResumeQuestion; signal: AbortSignal }> = [];
  const lost: string[] = [];
  const recovery: RestartRecovery = new RestartRecovery({
    projectThread: host.store,
    inbox: host.inbox,
    deliveries: host.deliveries,
    replyHandles,
    sessions: sessionsOf({}),
    ...(opts.moduleReplies ? { moduleReplies: opts.moduleReplies } : {}),
    resumable: opts.resumable ?? (({ moduleName }) => moduleName === RESUMABLE),
    connect: async (target, signal) => {
      await opts.connect?.(target, signal);
      return {
        ask: (q, askSignal) => {
          asked.push({ target, q, signal: askSignal });
          return ask(target, q, askSignal);
        },
      };
    },
    // cli.ts の deliverLostReply と同じ
    deliverLost: async (reply, why) => {
      lost.push(`${reply.moduleName}:${why}`);
      await host.deliveries.deliver({
        threadId: reply.threadId,
        from: reply.moduleName,
        title: `${reply.moduleName} の仕事は途中で終わりました`,
        text: `${reply.moduleName} に頼んだ「終わったら届ける」仕事の返事は、もう届きません——${why}。`,
        hop: reply.hop,
      });
      replyHandles.settle(reply.replyTo);
      recovery.noteSettled(reply.replyTo, "lost");
      await host.store.settleReply(reply.threadId, reply.replyTo);
    },
    publishBackground: () => undefined,
    ...(opts.askTimeoutMs !== undefined ? { askTimeoutMs: opts.askTimeoutMs } : {}),
  });
  host.holdAlso((id) => recovery.holdReason(id));
  return { recovery, replyHandles, asked, lost };
}

/** 前の走行で「あとで届ける」と約束した札（頼んだターンのホップ 0 → 届くときは 1） */
async function awaiting(store: ProjectThreadStore, threadId: string, replyTo: string, moduleName: string, projectId: string) {
  await store.recordAwaitingReply({
    threadId,
    replyTo,
    connName: `${moduleName}-${projectId}`,
    moduleName,
    hop: 1,
    work: { toolName: moduleName === RESUMABLE ? "runSubagent" : "runCommand", toolCallId: `toolu_${replyTo}` },
  });
}

test("続けられると名乗らない Module の札は、待ち受けの前に「途中で終わりました」——問わない", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-plain", PLAIN, projectId);
    const host = await boot(dir);
    const { recovery, asked, lost } = recoveryOf(host, async () => ({ answers: [] }));
    await recovery.beforeListen();
    assert.deepEqual(lost, [`${PLAIN}:banto を起動し直したため`]);
    assert.equal(host.store.getThread(threadId)!.awaitingReplies?.length ?? 0, 0);
    assert.deepEqual(host.store.getThread(threadId)!.deliveries?.map((d) => d.title), [`${PLAIN} の仕事は途中で終わりました`]);
    assert.equal(recovery.holdReason(threadId), undefined, "名乗らない Module の札だけなら留めない");
    await recovery.afterListen();
    assert.equal(asked.length, 0);
  });
});

test("名乗った Module が「続ける」と答えた札は残り、同じ印で最後の1回だけ届けられる（2回目は断られる）", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    const host = await boot(dir);
    const { recovery, replyHandles, asked, lost } = recoveryOf(host, async (_t, q) => ({
      answers: q.items.map((i) => ({ replyTo: i.replyTo, resume: true })),
    }));
    await recovery.beforeListen();
    assert.equal(asked.length, 0, "待ち受けの前には問わない");
    const { answers } = await recovery.afterListen();
    assert.deepEqual(answers.map((a) => [a.replyTo, a.outcome]), [["r-sub", "kept"]]);
    assert.deepEqual(lost, []);
    // 問いの形：札・呼んだ tool・tool_use の id・頼んだ Thread。問う相手は札を渡した接続
    assert.deepEqual(asked[0]!.target, { moduleName: RESUMABLE, connName: `${RESUMABLE}-${projectId}`, projectId });
    assert.deepEqual(asked[0]!.q, {
      items: [{ replyTo: "r-sub", toolName: "runSubagent", toolCallId: "toolu_r-sub", thread: { projectId, threadId } }],
    });
    // 返事待ちのまま、続けると答えた時刻が残る（画面の「起こし直しのあと続けています」）——読み直しても
    const kept = host.store.getThread(threadId)!.awaitingReplies!;
    assert.equal(kept.length, 1);
    assert.ok(kept[0]!.keptAt, "続けると答えた時刻が無い");
    assert.ok((await boot(dir)).store.getThread(threadId)!.awaitingReplies![0]!.keptAt);
    // 札を渡した Module 以外は使えない
    assert.deepEqual(replyHandles.use("r-sub", { moduleName: "other" }), { error: "この返信用の札は、あなたに渡したものではありません" });
    const once = replyHandles.use("r-sub", { moduleName: RESUMABLE, connName: `${RESUMABLE}-${projectId}` });
    assert.ok(!("error" in once), "覚え直した札が使えない");
    assert.equal(once.hop, 0, "札を出したターンのホップ");
    const twice = replyHandles.use("r-sub", { moduleName: RESUMABLE, connName: `${RESUMABLE}-${projectId}` });
    assert.ok("error" in twice, "覚え直した札が2回使えた");
  });
});

test("名乗った Module が「続けられない」と答えた・答えない・起こせない・時間切れなら「途中で終わりました」（理由つき）", async () => {
  for (const [name, ask, expected] of [
    ["続けられない", async (_t: ResumeTarget, q: ResumeQuestion) => ({ answers: [{ replyTo: q.items[0]!.replyTo, resume: false, reason: "記録がありません" }] }), /続けられないと答えました：記録がありません/],
    ["答えに無い", async () => ({ answers: [] }), /この仕事について答えませんでした/],
    ["起こせない", async () => { throw new Error("subagent を起こせませんでした"); }, /続けるかを聞けませんでした：subagent を起こせませんでした/],
    ["時間切れ", () => new Promise<unknown>(() => {}), /続けるかを聞けませんでした：0 秒待っても答えが来ませんでした/],
  ] as const) {
    await withDir(async ({ dir, first, threadId, projectId }) => {
      await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
      const host = await boot(dir);
      const { recovery, replyHandles, lost } = recoveryOf(host, ask, { askTimeoutMs: 20 });
      await recovery.beforeListen();
      await recovery.afterListen();
      assert.equal(lost.length, 1, name);
      assert.match(lost[0]!, expected, name);
      assert.equal(replyHandles.get("r-sub"), undefined, `${name}：札が残っている`);
      assert.equal(host.store.getThread(threadId)!.awaitingReplies?.length ?? 0, 0, name);
    });
  }
});

test("Thread の続きは札の判定のあと——それまで留め（届いたもの・人のターン）、続けると答えた Module は続きの文に「続いています」", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    // 前の走行：runInBackground で頼んだ（札は返事待ち）あと、次のターンの途中で host が止まった
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    await cutTurn(first, threadId, "続きをやって", [init(""), say("途中", "u1")]);
    const runner = scriptedRunner([init(""), say("続けます", "u2")]);
    const host = await boot(dir, runner);
    let answer!: (v: unknown) => void;
    const { recovery } = recoveryOf(host, (_t, q) => new Promise((r) => (answer = () => r({ answers: q.items.map((i) => ({ replyTo: i.replyTo, resume: true })) }))));
    const before = await recovery.beforeListen();
    assert.deepEqual(before, [], "判定の前に切れたターンを片づけた");
    assert.equal(host.store.getThread(threadId)!.lastTurn?.outcome, undefined);
    assert.equal(host.store.getThread(threadId)!.deliveries?.length ?? 0, 0, "判定の前に続きを積んだ");
    host.listen();
    const after = recovery.afterListen();
    // 判定の間に Module 以外から届いても起こさない。人のターンも待つ
    await host.deliveries.deliver({ threadId, from: "other", title: "別の結果", text: "別の結果", hop: 1 });
    let humanWaited = false;
    const human = recovery.waitFor(threadId).then(() => (humanWaited = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(runner.calls.length, 0, "判定の前に起こした");
    assert.equal(humanWaited, false, "人のターンが判定を待たない");
    answer(undefined);
    const { turns } = await after;
    await human;
    assert.deepEqual(turns.map((t) => t.action), ["continued"]);
    await settled(host, threadId);
    assert.equal(runner.calls.length, 1);
    assert.match(runner.calls[0]!.prompt, new RegExp(`${RESUMABLE} の仕事は続いています（終わったら届きます）`));
    assert.match(runner.calls[0]!.prompt, /別の結果/);
    assert.equal(recovery.holdReason(threadId), undefined);
  });
});

test("続けられないと答えたら、続きの文に「続いています」は書かない（「途中で終わりました」が届く）", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    await cutTurn(first, threadId, "続きをやって", [init(""), say("途中", "u1")]);
    const runner = scriptedRunner([init(""), say("続けます", "u2")]);
    const host = await boot(dir, runner);
    const { recovery } = recoveryOf(host, async (_t, q) => ({ answers: q.items.map((i) => ({ replyTo: i.replyTo, resume: false, reason: "load できません" })) }));
    await recovery.beforeListen();
    host.listen();
    await recovery.afterListen();
    await settled(host, threadId);
    assert.doesNotMatch(runner.calls[0]!.prompt, /続いています/);
    assert.match(runner.calls[0]!.prompt, /途中で終わりました/);
  });
});

test("閉じた Thread の札は、名乗った Module のものでも問わずに「途中で終わりました」", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    await first.store.closeThread(threadId);
    const host = await boot(dir);
    const { recovery, asked, lost } = recoveryOf(host, async () => ({ answers: [] }));
    await recovery.beforeListen();
    await recovery.afterListen();
    assert.equal(asked.length, 0);
    assert.equal(lost.length, 1);
  });
});

// ---- Fable のレビューを受けた直し（2026-10-05）----

test("遅れて来た答え：期限を過ぎたら問いを打ち切る——繋がるのが遅れたら問いは送らず、問いの最中なら取り消しの合図が立つ", async () => {
  // 繋がるのが期限より遅い：問いは送らない
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    const host = await boot(dir);
    let connectSignal: AbortSignal | undefined;
    const { recovery, replyHandles, asked, lost } = recoveryOf(host, async (_t, q) => ({ answers: q.items.map((i) => ({ replyTo: i.replyTo, resume: true })) }), {
      askTimeoutMs: 30,
      connect: async (_t, signal) => {
        connectSignal = signal;
        await new Promise((r) => setTimeout(r, 120));
      },
    });
    await recovery.beforeListen();
    await recovery.afterListen();
    assert.equal(connectSignal?.aborted, true, "起こす所に打ち切りが伝わらない");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(asked.length, 0, "期限を過ぎてから問いを送った");
    assert.equal(lost.length, 1);
    assert.match(lost[0]!, /0 秒待っても答えが来ませんでした/);
    assert.equal(replyHandles.get("r-sub"), undefined);
  });
  // 問いの最中に期限：取り消しの合図が立ち、あとから来た「続ける」は使わない
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    const host = await boot(dir);
    let late!: () => void;
    const { recovery, asked, lost } = recoveryOf(
      host,
      (_t, q) => new Promise((r) => (late = () => r({ answers: q.items.map((i) => ({ replyTo: i.replyTo, resume: true })) }))),
      { askTimeoutMs: 30 },
    );
    await recovery.beforeListen();
    const { answers } = await recovery.afterListen();
    assert.equal(asked[0]!.signal.aborted, true, "問いに取り消しの合図が立たない");
    late();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(answers.map((a) => a.outcome), ["lost"]);
    assert.equal(lost.length, 1);
    assert.equal(host.store.getThread(threadId)!.awaitingReplies?.length ?? 0, 0, "遅れた「続ける」で札が残った");
  });
});

test("問いを送る直前に札を見る：起こしている間に札が済んだ（Module が止まった）ら問いに載せない・嘘の理由を書かない", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    const host = await boot(dir);
    let lose!: () => Promise<void>;
    const { recovery, asked } = recoveryOf(host, async () => ({ answers: [] }), { connect: () => lose() });
    // 起こしている間に Module が止まり、cli.ts の onclose が「途中で終わりました」を届ける
    lose = async () => {
      await host.deliveries.deliver({ threadId, from: RESUMABLE, title: "途中で終わりました", text: "止まった", hop: 1 });
      (recovery as unknown as { deps: { replyHandles: ReplyHandles } }).deps.replyHandles.settle("r-sub");
      recovery.noteSettled("r-sub", "lost");
    };
    await recovery.beforeListen();
    const { answers } = await recovery.afterListen();
    assert.equal(asked.length, 0, "済んだ札を問いに載せた");
    assert.deepEqual(answers.map((a) => [a.outcome, a.why]), [["settled", "答えの前に Module が止まり、「途中で終わりました」を届けた"]]);
  });
});

test("答えの前に最後の届けが済んだら、「Module が止まった」とは書かない", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    await awaiting(first.store, threadId, "r-sub", RESUMABLE, projectId);
    const host = await boot(dir);
    let handles!: ReplyHandles;
    let recovery!: RestartRecovery;
    const made = recoveryOf(host, async (_t, q) => {
      // 続けると答える前に、Module がもう最後の届けを済ませた（cli.ts の deliverToThread と同じ片づけ）
      assert.ok(!("error" in handles.use("r-sub", { moduleName: RESUMABLE }, { final: true })));
      handles.settle("r-sub");
      recovery.noteSettled("r-sub", "delivered");
      return { answers: q.items.map((i) => ({ replyTo: i.replyTo, resume: true })) };
    });
    handles = made.replyHandles;
    recovery = made.recovery;
    await recovery.beforeListen();
    const { answers } = await recovery.afterListen();
    assert.deepEqual(answers.map((a) => [a.outcome, a.why]), [["settled", "答えの前に最後の届けが済んだ"]]);
    assert.deepEqual(made.lost, [], "済んだ札に「途中で終わりました」を届けた");
  });
});

test("覚え直した札は最後の届けにしか使えない——最後でない届けは断り、回数も減らさない", async () => {
  const handles = new ReplyHandles();
  handles.restore("r", { threadId: "t", connName: "subagent-p", moduleName: RESUMABLE, hop: 0 });
  const refused = handles.use("r", { moduleName: RESUMABLE }, { final: false });
  assert.deepEqual(refused, { error: "banto を起こし直したあと覚え直した札は、最後の届け（final）にしか使えません" });
  assert.ok(!("error" in handles.use("r", { moduleName: RESUMABLE }, { final: true })), "最後の届けが断られた");
  // ふつうの札は今までどおり、最後でない届けにも使える
  const normal = handles.issue({ threadId: "t", connName: "subagent-p", moduleName: RESUMABLE, hop: 0 });
  assert.ok(!("error" in handles.use(normal, { moduleName: RESUMABLE }, { final: false })));
});

/** Module 宛ての返事待ち（module-replies の代役） */
function moduleRepliesOf(rows: Array<{ replyTo: string; fromModule: string; projectId?: string }>) {
  const lostCalls: Array<[string, string]> = [];
  const awaitingRows: ModuleAwaitingReply[] = rows.map((r) => ({
    replyTo: r.replyTo,
    replyId: `rid_${r.replyTo}`,
    toConn: `factory-${r.projectId ?? "x"}`,
    toModule: "factory",
    fromConn: `${r.fromModule}-${r.projectId ?? "x"}`,
    fromModule: r.fromModule,
    ...(r.projectId ? { projectId: r.projectId } : {}),
    since: new Date().toISOString(),
  }));
  return {
    lostCalls,
    awaitingRows,
    stub: {
      awaiting: () => awaitingRows.filter((a) => !lostCalls.some(([id]) => id === a.replyTo)),
      loseOne: async (replyTo: string, why: string) => void lostCalls.push([replyTo, why]),
    },
  };
}

test("Module 宛ての札も、頼んだ先が続けられると名乗っていれば同じ問いに乗せる（Thread の代わりに呼び元の Module）——続けるなら覚え直し、続けないなら呼び元に「途中で終わりました」", async () => {
  await withDir(async ({ dir, projectId }) => {
    const host = await boot(dir);
    const mr = moduleRepliesOf([
      { replyTo: "m-keep", fromModule: RESUMABLE, projectId },
      { replyTo: "m-drop", fromModule: RESUMABLE, projectId },
      { replyTo: "m-plain", fromModule: PLAIN, projectId },
    ]);
    const { recovery, replyHandles, asked } = recoveryOf(
      host,
      async () => ({ answers: [{ replyTo: "m-keep", resume: true }, { replyTo: "m-drop", resume: false, reason: "記録がありません" }] }),
      // 呼び元（factory）も名乗っている——名乗っていなければ問わない（下の試験）
      { moduleReplies: mr.stub, resumable: ({ moduleName }) => moduleName === RESUMABLE || moduleName === "factory" },
    );
    await recovery.beforeListen();
    // 名乗らない頼んだ先の札は、待ち受けの前に「途中で終わりました」
    assert.deepEqual(mr.lostCalls, [["m-plain", "banto を起動し直したため"]]);
    const { answers } = await recovery.afterListen();
    assert.deepEqual(asked.map((a) => a.target), [{ moduleName: RESUMABLE, connName: `${RESUMABLE}-${projectId}`, projectId }]);
    assert.deepEqual(asked[0]!.q.items, [
      { replyTo: "m-keep", caller: { module: "factory", projectId } },
      { replyTo: "m-drop", caller: { module: "factory", projectId } },
    ]);
    assert.deepEqual(answers.map((a) => [a.replyTo, a.outcome, a.to]), [
      ["m-keep", "kept", { module: "factory" }],
      ["m-drop", "lost", { module: "factory" }],
    ]);
    assert.match(mr.lostCalls[1]![1], /続けられないと答えました：記録がありません/);
    // 続けると答えた札は同じ印で覚え直し、呼び元の Module 宛てのまま・最後の1回だけ
    const kept = replyHandles.get("m-keep");
    assert.equal(kept?.toModule?.moduleName, "factory");
    assert.equal(kept?.toModule?.replyId, "rid_m-keep");
    assert.equal(kept?.finalOnly, true);
    assert.equal(replyHandles.get("m-drop"), undefined);
  });
});

// **呼び元が名乗っていなければ、頼んだ先が名乗っていても問わない**（改訂・2026-10-05、Fable のレビュー）——呼び元は自分の
// Thread 宛ての札を「途中で終わりました」にするので、頼んだ先が続けて結果が届き直すと同じ仕事が二重に見える
test("Module 宛ての札：呼び元が「続けられる」と名乗っていなければ、頼んだ先が名乗っていても問わずに「途中で終わりました」", async () => {
  await withDir(async ({ dir, projectId }) => {
    const host = await boot(dir);
    const mr = moduleRepliesOf([{ replyTo: "m-caller-plain", fromModule: RESUMABLE, projectId }]);
    const { recovery, replyHandles, asked } = recoveryOf(host, async () => ({ answers: [{ replyTo: "m-caller-plain", resume: true }] }), {
      moduleReplies: mr.stub,
    });
    await recovery.beforeListen();
    assert.deepEqual(mr.lostCalls, [["m-caller-plain", "banto を起動し直したため"]]);
    await recovery.afterListen();
    assert.deepEqual(asked, [], "名乗らない呼び元の札を頼んだ先に問うた");
    assert.equal(replyHandles.get("m-caller-plain"), undefined);
  });
});

test("banto 全体の Module：同じ接続の札でも Project は札ごとに刻む（最初の Project で全部を刻まない）", async () => {
  await withDir(async ({ dir, first, threadId, projectId }) => {
    const other = await first.store.createProject("other", dir);
    const otherThread = await first.store.createBaseThread(other.id);
    for (const [t, p, r] of [[threadId, projectId, "r1"], [otherThread.id, other.id, "r2"]] as const) {
      await first.store.recordAwaitingReply({ threadId: t, replyTo: r, connName: "inst", moduleName: "inst", hop: 1 });
      void p;
    }
    const host = await boot(dir);
    const { recovery, asked } = recoveryOf(host, async () => ({ answers: [] }), { resumable: () => true });
    await recovery.beforeListen();
    await recovery.afterListen();
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]!.target, { moduleName: "inst", connName: "inst" }, "banto 全体の Module に1つの Project を付けた");
    assert.deepEqual(asked[0]!.q.items.map((i) => i.thread), [
      { projectId, threadId },
      { projectId: other.id, threadId: otherThread.id },
    ]);
  });
});
