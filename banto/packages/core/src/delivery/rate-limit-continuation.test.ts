// **上限で止まったターンを、リセットのあと人を待たずに続ける**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを
// 複数持つ」の 9.）。
//
// 偽の Runner が CLI と同じ形（`rate_limit_event` の `resetsAt`、assistant の `error: "rate_limit"`、result）で上限に当たり、
// host がターンの終わりに印と続ける時刻を書き、時刻が来たら同じ会話を続けるか。起こし直しをまたぐ・届いたものを留めて一緒に
// 積む・人が送ると待ちが外れる・待つのをやめる・続けて上限に当たり続けたら受信箱で聞く、を見る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { rateLimitWaitOf } from "../project-thread/rate-limit-wait.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { reviewDueAfterTurn } from "../inbox/review-turn.js";
import { runThreadTurn, type TurnStreamEvent } from "../http/turn-runner.js";
import type { runTurn, RunnerTurnOptions } from "../runner/adapter.js";
import { ThreadTurns } from "./thread-turns.js";
import { ThreadDeliveries } from "./thread-deliveries.js";
import { continueStoppedTurn, resumeHoldReason } from "./turn-continuation.js";
import {
  RATE_LIMIT_CONTINUE_LIMIT,
  RATE_LIMIT_CONTINUE_TITLE,
  RATE_LIMIT_GAVE_UP_TITLE,
  RATE_LIMIT_UNKNOWN_RESET_TITLE,
  RateLimitContinuations,
} from "./rate-limit-continuation.js";

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] });
const say = (text: string) => ({ type: "assistant", uuid: `u-${text}`, message: { content: [{ type: "text", text }] } });
/** CLI が上限で断られたときに流すもの（#397 の実測の形） */
const limited = (resetsAtSec: number) => [
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resetsAtSec }, uuid: "rl", session_id: "" },
  { type: "assistant", uuid: "u-limit", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your session limit" }] } },
];
const secondsFromNow = (ms: number) => Math.floor((Date.now() + ms) / 1000);

type Call = Pick<RunnerTurnOptions, "resumeSessionId" | "prompt">;

/** 呼ばれるたびに台本を1つずつ使う Runner。台本が尽きたら「はい」で終わる */
function runner(scripts: unknown[][]) {
  const calls: Call[] = [];
  const fake = (async function* (opts: RunnerTurnOptions) {
    calls.push({ resumeSessionId: opts.resumeSessionId, prompt: opts.prompt });
    const sid = opts.sessionId ?? opts.resumeSessionId ?? "session-new";
    yield { type: "message" as const, message: init(sid) } as never;
    for (const m of scripts.shift() ?? [say("はい")]) yield { type: "message" as const, message: m } as never;
    return { sessionId: sid, compactionCount: 0 } as never;
  }) as unknown as typeof runTurn;
  return { fake, calls };
}

interface Host {
  store: ProjectThreadStore;
  inbox: InboxStore;
  deliveries: ThreadDeliveries;
  turns: ThreadTurns;
  rateLimits: RateLimitContinuations;
  /** 人が送ったターン（鍵を取って走らせる） */
  send(threadId: string, prompt: string): Promise<TurnStreamEvent[]>;
  stop(): void;
}

/** cli.ts と同じ形に組む：届けものの留め・時計・ターンの終わりで時計を掛け直す。`earliest` は中継が持つ一番早いリセット */
async function boot(dir: string, run: ReturnType<typeof runner>, opts: { earliest?: number } = {}): Promise<Host> {
  const log = new EventLog(dir);
  await log.init();
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  const globalMemory = new GlobalMemoryStore(dir, log);
  await globalMemory.load();
  const inbox = new InboxStore(dir, log);
  await inbox.load();
  const turns = new ThreadTurns();
  let rateLimits: RateLimitContinuations | undefined;
  const deliveries = new ThreadDeliveries({
    projectThread: store,
    turns,
    notify: async (n) => void (await inbox.raiseNotice(n)),
    hold: (threadId) => resumeHoldReason({ projectThread: store, inbox }, threadId),
    wait: (threadId) => rateLimits?.hold(threadId),
  });
  rateLimits = new RateLimitContinuations({
    projectThread: store,
    inbox,
    deliveries,
    marginMs: 0,
    ...(opts.earliest !== undefined ? { earliestReset: () => opts.earliest } : {}),
  });
  const r = rateLimits;
  turns.onChange((change) => r.arm(change.threadId));
  const deps = {
    projectThread: store,
    globalMemory,
    inbox,
    pendingApprovals: new PendingApprovalRegistry(),
    runTurn: run.fake,
    rateLimitContinueAt: (threadId: string, resetsAt: number | undefined) => r.continueAt(threadId, resetsAt),
  };
  deliveries.setTurnRunner(async (threadId, hop) => {
    const release = turns.tryAcquire(threadId, hop);
    if (!release) return false;
    try {
      await collect(runThreadTurn(deps, { threadId, prompt: "", modules: [] }));
    } finally {
      release();
    }
    return true;
  });
  const send = async (threadId: string, prompt: string) => {
    const release = await turns.acquire(threadId, 0);
    try {
      return await collect(runThreadTurn(deps, { threadId, prompt, modules: [] }));
    } finally {
      release?.();
    }
  };
  return { store, inbox, deliveries, turns, rateLimits: r, send, stop: () => r.stop() };
}

async function collect(gen: AsyncGenerator<TurnStreamEvent>): Promise<TurnStreamEvent[]> {
  const out: TurnStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${what}にならない`);
}

async function withDir(fn: (ctx: { dir: string; projectId: string; threadId: string }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-rate-limit-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const project = await store.createProject("demo", dir);
    const thread = await store.createBaseThread(project.id);
    await fn({ dir, projectId: project.id, threadId: thread.id });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const userTexts = (host: Host, threadId: string) =>
  host.store.getThread(threadId)!.messages.filter((m) => m.role === "user").map((m) => `${m.origin ? `${m.origin.from}:` : ""}${m.text}`);

test("上限で止まったら、終わりに印と時刻（resetsAt＋余白）を書き、時刻が来たら同じ会話を続ける——レビュー待ちは出さない", async () => {
  await withDir(async ({ dir, threadId }) => {
    const resetsAt = secondsFromNow(3000);
    const run = runner([[say("始めます"), ...limited(resetsAt)]]);
    const host = await boot(dir, run);
    try {
      await host.send(threadId, "作って");
      // 時刻はまだ来ていないかもしれない——印と時刻は書かれている
      const ended = host.store.getThread(threadId)!;
      const sessionId = ended.resumePoint;
      assert.ok(sessionId);
      assert.deepEqual(ended.lastTurn?.rateLimit, { continueAt: new Date(resetsAt * 1000).toISOString() });
      assert.equal(reviewDueAfterTurn(ended), false, "人の番ではないのにレビュー待ちを出す");

      await until("続きのターンが終わる", () => host.store.getThread(threadId)!.lastTurn?.continuesReason === "rate_limit" && host.store.getThread(threadId)!.lastTurn?.outcome !== undefined);
      const thread = host.store.getThread(threadId)!;
      assert.equal(run.calls.length, 2);
      assert.equal(run.calls[1]!.resumeSessionId, sessionId, "同じ会話を続けていない");
      assert.match(run.calls[1]!.prompt, /上限が戻ったので、止まったところから続けてください/);
      assert.equal(thread.lastTurn?.attempt, 1);
      assert.equal(thread.lastTurn?.cause, "delivery");
      assert.equal(thread.lastTurn?.rateLimit, undefined);
      assert.equal(rateLimitWaitOf(thread), undefined, "続けたのに待ちが残っている");
      assert.deepEqual(userTexts(host, threadId).slice(-1)[0]?.startsWith("banto:"), true);
      assert.equal(host.store.getThread(threadId)!.messages.find((m) => m.origin)?.origin?.title, RATE_LIMIT_CONTINUE_TITLE);
      assert.deepEqual(host.inbox.listOpen(), [], "受信箱に何か出た");
    } finally {
      host.stop();
    }
  });
});

test("中継がリセットの時刻を持っていれば、そちらを使う（rate_limit_event より優先）", async () => {
  await withDir(async ({ dir, threadId }) => {
    const relay = Date.now() + 3_600_000;
    const host = await boot(dir, runner([limited(secondsFromNow(60_000))]), { earliest: relay });
    try {
      await host.send(threadId, "作って");
      assert.equal(rateLimitWaitOf(host.store.getThread(threadId))?.continueAt, new Date(relay).toISOString());
    } finally {
      host.stop();
    }
  });
});

test("待っている間に届いたものは留め（受信箱に出さない）、続けたターンに一緒に積む", async () => {
  await withDir(async ({ dir, threadId }) => {
    const run = runner([limited(secondsFromNow(3_600_000))]);
    const host = await boot(dir, run);
    try {
      await host.send(threadId, "作って");
      const result = await host.deliveries.deliver({ threadId, from: "subagent", title: "結果", text: "終わりました", hop: 1 });
      assert.equal(result.wake, "held");
      assert.equal(host.turns.isRunning(threadId), false, "待っているのに起こした");
      assert.deepEqual(host.inbox.listOpen(), [], "人の番ではないのに受信箱に出た");

      assert.deepEqual(await host.rateLimits.continueNow(threadId), { ok: true });
      await until("続きのターンが終わる", () => host.store.getThread(threadId)!.lastTurn?.continuesReason === "rate_limit" && !host.turns.isRunning(threadId));
      assert.equal(run.calls.length, 2);
      const prompt = run.calls[1]!.prompt;
      assert.ok(prompt.indexOf("上限が戻ったので") < prompt.indexOf("終わりました"), "続きが先頭に並んでいない");
      assert.deepEqual(host.store.getThread(threadId)!.deliveries ?? [], []);
    } finally {
      host.stop();
    }
  });
});

test("起こし直しをまたぐ：起きたら待ちを拾い、時刻を過ぎていればすぐ続ける", async () => {
  await withDir(async ({ dir, threadId }) => {
    const first = await boot(dir, runner([limited(secondsFromNow(3_600_000))]));
    await first.send(threadId, "作って");
    first.stop();
    assert.ok(rateLimitWaitOf(first.store.getThread(threadId)));

    // 時刻を過ぎたことにする——今の時刻の時計で起こし直す
    const run = runner([]);
    const host = await boot(dir, run);
    try {
      const wait = rateLimitWaitOf(host.store.getThread(threadId))!;
      assert.ok(wait, "起こし直したら待ちが消えた");
      (host.rateLimits as unknown as { now: () => number }).now = () => Date.parse(wait.continueAt) + 1;
      host.rateLimits.start();
      await until("続きのターンが終わる", () => host.store.getThread(threadId)!.lastTurn?.continuesReason === "rate_limit" && host.store.getThread(threadId)!.lastTurn?.outcome !== undefined);
      assert.equal(run.calls.length, 1);
      assert.equal(run.calls[0]!.resumeSessionId, first.store.getThread(threadId)!.resumePoint);
    } finally {
      host.stop();
    }
  });
});

test("人が送ったら待ちが外れる——その発言でふつうにターンを開き、留めていたものも一緒に積む。時計は何もしない", async () => {
  await withDir(async ({ dir, threadId }) => {
    const run = runner([limited(secondsFromNow(3000)), [say("見ました")]]);
    const host = await boot(dir, run);
    try {
      await host.send(threadId, "作って");
      await host.deliveries.deliver({ threadId, from: "subagent", title: "結果", text: "終わりました", hop: 1 });
      await host.send(threadId, "どう？");
      const thread = host.store.getThread(threadId)!;
      assert.equal(thread.lastTurn?.cause, "human");
      assert.equal(thread.lastTurn?.attempt, 0);
      assert.equal(rateLimitWaitOf(thread), undefined);
      assert.match(run.calls[1]!.prompt, /終わりました[\s\S]*どう？/);
      // 時刻を過ぎても続きは来ない
      await new Promise((r) => setTimeout(r, 3200));
      assert.equal(run.calls.length, 2, "人が送ったのに自動で続けた");
    } finally {
      host.stop();
    }
  });
});

test("待つのをやめる：待ちが消え、続きは来ない。留めていたものは待ち行列に残る（起こさない）", async () => {
  await withDir(async ({ dir, threadId }) => {
    const run = runner([limited(secondsFromNow(3000))]);
    const host = await boot(dir, run);
    try {
      await host.send(threadId, "作って");
      await host.deliveries.deliver({ threadId, from: "subagent", title: "結果", text: "終わりました", hop: 1 });
      assert.deepEqual(await host.rateLimits.cancel(threadId, "human"), { ok: true });
      const thread = host.store.getThread(threadId)!;
      assert.equal(thread.lastTurn?.continuationCancelled, "human");
      assert.equal(rateLimitWaitOf(thread), undefined);
      assert.equal(thread.deliveries?.length, 1);
      await new Promise((r) => setTimeout(r, 3200));
      assert.equal(run.calls.length, 1, "やめたのに続けた");
      assert.deepEqual(await host.rateLimits.cancel(threadId, "human"), { ok: false, status: 409, error: "この会話は上限が戻るのを待っていません" });
      assert.equal((await host.rateLimits.continueNow(threadId)).ok, false);
    } finally {
      host.stop();
    }
  });
});

test("Clear で待ちが消える", async () => {
  await withDir(async ({ dir, threadId }) => {
    const host = await boot(dir, runner([limited(secondsFromNow(3_600_000))]));
    try {
      await host.send(threadId, "作って");
      await host.store.clearThread(threadId);
      assert.equal(rateLimitWaitOf(host.store.getThread(threadId)), undefined);
    } finally {
      host.stop();
    }
  });
});

test(`続けて上限に当たり続けたら、${RATE_LIMIT_CONTINUE_LIMIT} 回続けたところで待たずに受信箱で聞く——「続ける」で 0 から続く`, async () => {
  await withDir(async ({ dir, threadId }) => {
    const past = () => limited(Math.floor(Date.now() / 1000) - 1);
    const run = runner(Array.from({ length: RATE_LIMIT_CONTINUE_LIMIT + 1 }, past));
    const host = await boot(dir, run);
    try {
      await host.send(threadId, "作って");
      // お知らせはターンの終わりを書く直前に出る——終わりまで待つ
      await until(
        "受信箱で聞いてターンが終わる",
        () =>
          host.inbox.listOpen().some((i) => i.kind === "notice" && i.title === RATE_LIMIT_GAVE_UP_TITLE) &&
          host.store.getThread(threadId)!.lastTurn?.outcome !== undefined &&
          !host.turns.isRunning(threadId),
      );
      assert.equal(run.calls.length, RATE_LIMIT_CONTINUE_LIMIT + 1);
      const thread = host.store.getThread(threadId)!;
      assert.equal(thread.lastTurn?.attempt, RATE_LIMIT_CONTINUE_LIMIT);
      assert.deepEqual(thread.lastTurn?.rateLimit, {}, "続けるのをやめたのに時刻がある");
      assert.equal(rateLimitWaitOf(thread), undefined);
      // 続きは積んだが起こさない。お知らせが開いている間は届いたものでも起こさない
      assert.equal(thread.deliveries?.filter((d) => d.continues?.reason === "rate_limit").length, 1);
      await host.deliveries.deliver({ threadId, from: "subagent", title: "結果", text: "終わりました", hop: 1 });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(run.calls.length, RATE_LIMIT_CONTINUE_LIMIT + 1, "お知らせが開いているのに起こした");

      const notice = host.inbox.listOpen().find((i) => i.kind === "notice" && i.title === RATE_LIMIT_GAVE_UP_TITLE)!;
      assert.deepEqual(await continueStoppedTurn({ projectThread: host.store, inbox: host.inbox, deliveries: host.deliveries }, notice.id), { ok: true });
      await until("続けたターンが終わる", () => run.calls.length === RATE_LIMIT_CONTINUE_LIMIT + 2 && !host.turns.isRunning(threadId));
      const after = host.store.getThread(threadId)!;
      assert.equal(after.lastTurn?.attempt, 0, "人が続けたのに数え直していない");
      assert.equal(after.lastTurn?.continuesReason, "rate_limit");
      assert.equal(after.lastTurn?.rateLimit, undefined);
      const acked = host.inbox.get(notice.id);
      assert.equal(acked?.kind === "notice" && acked.acknowledged, true);
    } finally {
      host.stop();
    }
  });
});

test("リセットの時刻が分からなければ、待たずに受信箱で聞く", async () => {
  await withDir(async ({ dir, threadId }) => {
    const host = await boot(dir, runner([[{ type: "assistant", uuid: "x", error: "rate_limit", message: { content: [] } }]]));
    try {
      await host.send(threadId, "作って");
      assert.equal(rateLimitWaitOf(host.store.getThread(threadId)), undefined);
      assert.ok(host.inbox.listOpen().some((i) => i.kind === "notice" && i.title === RATE_LIMIT_UNKNOWN_RESET_TITLE));
    } finally {
      host.stop();
    }
  });
});

test("上限の続きのターンが起こし直しで切れても、切れた回数は 0 から数える（上限で続けた回数と混ぜない）", async () => {
  await withDir(async ({ dir, threadId }) => {
    const host = await boot(dir, runner([]));
    try {
      await host.store.startTurn(threadId, { cause: "delivery", attempt: 4, continues: { turnId: "t-prev", fromSeq: 1, reason: "rate_limit" } });
      await host.store.appendMessage(threadId, "user", "続き", undefined, { from: "banto", title: "t", hop: 0, deliveryId: "d1" });
      const [cut] = host.store.listInterruptedTurns();
      assert.equal(cut?.attempt, 0);
    } finally {
      host.stop();
    }
  });
});
