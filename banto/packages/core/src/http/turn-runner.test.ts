// ターンの入口の健全性検査（`relay-health-turn-abort`、2026-09-10）。
//
// **道具が繋がっているかは、最初に届く `system/init` で分かる。** 以前はターンが
// 終わってから見ていたので、AI は道具なしで最後まで走り、それらしい返事を書き、
// resume-point まで更新されていた——「守れていないのに動く」（規則2）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { runThreadTurn, type TurnStreamEvent } from "./turn-runner.js";
import { TurnEventBus } from "./turn-events.js";
import type { runTurn } from "../runner/adapter.js";

/** `system/init` の形（mcp_servers の状態だけがこの試験の関心事）。 */
function initMessage(servers: Array<{ name: string; status: string }>) {
  return {
    type: "system" as const,
    subtype: "init" as const,
    session_id: "session-1",
    mcp_servers: servers,
  };
}

function assistantMessage(text: string) {
  return { type: "assistant" as const, message: { content: [{ type: "text", text }] } };
}

/** 差し替え用の Runner。**止められたかどうか**も見たいので、signal を覚える。 */
function fakeRunner(messages: unknown[]) {
  const state = { aborted: false, yielded: 0 };
  const fake = (async function* (opts: { signal?: AbortSignal }) {
    opts.signal?.addEventListener("abort", () => {
      state.aborted = true;
    });
    try {
      for (const message of messages) {
        state.yielded += 1;
        yield { type: "message" as const, message } as never;
      }
      return { sessionId: "session-1", compactionCount: 0 } as never;
    } finally {
      // 呼び出し側が途中で止めたら、ここを通る
    }
  }) as unknown as typeof runTurn;
  return { fake, state };
}

async function withThread(
  fn: (ctx: {
    deps: Parameters<typeof runThreadTurn>[0];
    threadId: string;
    store: ProjectThreadStore;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-turn-runner-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const project = await projectThread.createProject("demo", dir);
    const thread = await projectThread.createBaseThread(project.id);
    await fn({
      deps: { projectThread, globalMemory, inbox, pendingApprovals: new PendingApprovalRegistry() },
      threadId: thread.id,
      store: projectThread,
      dir,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(gen: AsyncGenerator<TurnStreamEvent>): Promise<TurnStreamEvent[]> {
  const out: TurnStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("代理サーバが繋がっていなければ、ターンの冒頭で止める（返事も resume-point も残さない）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake, state } = fakeRunner([
      initMessage([{ name: "filesystem", status: "failed" }]),
      assistantMessage("道具なしで書いた、それらしい返事"),
    ]);

    const events = await collect(
      runThreadTurn(
        { ...deps, runTurn: fake },
        {
          threadId,
          prompt: "ファイルを読んで",
          modules: [{ name: "filesystem", url: "http://127.0.0.1:1/agent-relay/filesystem" }],
        },
      ),
    );

    const error = events.find((e) => e.type === "error");
    assert.ok(error, `止まっていない: ${JSON.stringify(events.map((e) => e.type))}`);
    assert.match((error as { message: string }).message, /filesystem/);
    assert.equal(events.some((e) => e.type === "done"), false, "止めたのに done を出している");

    // **走り出した query を止める**——道具なしで最後まで走らせない
    assert.equal(state.aborted, true, "Runner を止めていない");

    const thread = store.getThread(threadId)!;
    assert.equal(thread.resumePoint, undefined, "止めたのに resume-point を更新している");
    assert.equal(
      thread.messages.some((m) => m.role === "assistant"),
      false,
      "止めたのに、道具なしで書いた返事が記録に残っている",
    );
  });
});

test("全部繋がっていれば、そのまま進む", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = fakeRunner([
      initMessage([{ name: "filesystem", status: "connected" }]),
      assistantMessage("読みました"),
    ]);

    const events = await collect(
      runThreadTurn(
        { ...deps, runTurn: fake },
        {
          threadId,
          prompt: "ファイルを読んで",
          modules: [{ name: "filesystem", url: "http://127.0.0.1:1/agent-relay/filesystem" }],
        },
      ),
    );

    assert.equal(events.some((e) => e.type === "error"), false);
    assert.ok(events.some((e) => e.type === "done"));
    const thread = store.getThread(threadId)!;
    assert.equal(thread.resumePoint, "session-1");
    assert.ok(thread.messages.some((m) => m.role === "assistant" && m.text.includes("読みました")));
  });
});

test("Module を1つも配線していないターンは、検査に引っかからない", async () => {
  await withThread(async ({ deps, threadId }) => {
    const { fake } = fakeRunner([initMessage([]), assistantMessage("こんにちは")]);
    const events = await collect(
      runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "ひとこと", modules: [] }),
    );
    assert.equal(events.some((e) => e.type === "error"), false);
    assert.ok(events.some((e) => e.type === "done"));
  });
});

// **人が選んだモデルと effort でターンが走る**（決定・2026-09-23）。選んでいなければ渡さない
// ——CLI の既定で走る。途中で変えたら、次のターンから効く。

test("ターンは host が持つモデルと effort で走り、途中で変えると次のターンから効く", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const seen: Array<{ model?: string; effort?: string }> = [];
    const fake = (async function* (opts: { model?: string; effort?: string }) {
      seen.push({ model: opts.model, effort: opts.effort });
      yield { type: "message" as const, message: initMessage([]) } as never;
      yield { type: "message" as const, message: assistantMessage("はい") } as never;
      return { sessionId: "session-1", compactionCount: 0 } as never;
    }) as unknown as typeof runTurn;

    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "1", modules: [] }));
    await store.setModel(threadId, "sonnet", "low");
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "2", modules: [] }));
    await store.setModel(threadId, null, null);
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "3", modules: [] }));

    assert.deepEqual(seen, [
      { model: undefined, effort: undefined },
      { model: "sonnet", effort: "low" },
      { model: undefined, effort: undefined },
    ]);
  });
});

// **走行中のターンに、あとから繋ぎ直せる**（`turn-stream-reattach`、2026-09-10）。
// ターンのイベント列は `POST …/messages` の応答の中にしか無く、リロードすると
// **出力どころか「走っている」ことすら画面から消えていた**（実測）。

test("走行中のイベントは覚えられ、あとから最初から流し直せる", async () => {
  await withThread(async ({ deps, threadId }) => {
    const turnEvents = new TurnEventBus();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // 途中で止まるターン（人がリロードした瞬間を作る）
    const fake = (async function* () {
      yield { type: "message" as const, message: initMessage([]) } as never;
      yield { type: "message" as const, message: assistantMessage("途中まで書いた") } as never;
      await held;
      yield { type: "message" as const, message: assistantMessage("続き") } as never;
      return { sessionId: "s", compactionCount: 0 } as never;
    }) as unknown as typeof import("../runner/adapter.js").runTurn;

    const gen = runThreadTurn({ ...deps, turnEvents, runTurn: fake }, { threadId, prompt: "数えて", modules: [] });
    // 2件流れたところで、いったん手を止める（画面が切れた状況）
    await gen.next();
    await gen.next();

    const snapshot = turnEvents.snapshot(threadId);
    assert.ok(snapshot, "走行中なのに覚えていない");
    assert.equal(turnEvents.isRunning(threadId), true);
    assert.equal(snapshot!.events.length, 2, "流したぶんを覚えていない");

    // **あとから繋いだ人**にも、続きが届く
    const later: TurnStreamEvent[] = [];
    const unsubscribe = turnEvents.subscribeStream(threadId, (e) => later.push(e));
    release();
    for await (const _ of gen) void _;
    unsubscribe();

    assert.ok(later.some((e) => e.type === "done"), `続きが届いていない: ${JSON.stringify(later.map((e) => e.type))}`);
    // **終わったら覚えていない**——ここから先の真実は Event Store
    assert.equal(turnEvents.isRunning(threadId), false);
    assert.equal(turnEvents.snapshot(threadId), undefined);
  });
});

test("走っていなければ、覚えているものは無い", async () => {
  await withThread(async ({ deps, threadId }) => {
    const turnEvents = new TurnEventBus();
    assert.equal(turnEvents.isRunning(threadId), false);
    const { fake } = fakeRunner([initMessage([]), assistantMessage("ひとこと")]);
    await collect(runThreadTurn({ ...deps, turnEvents, runTurn: fake }, { threadId, prompt: "やあ", modules: [] }));
    assert.equal(turnEvents.isRunning(threadId), false, "終わったのに走行中のまま");
  });
});

// **失敗しても、人が答える口は残る**（`core-turn-runner-unit-tests`、2026-09-10）。
//
// 判断待ちを起票した後にターンが落ちると、そのカードごと消えては困る
// ——止まっているものは受信箱に残り、あとから答えられるべき（§2.4）。

test("判断待ちを起票した後にターンが落ちても、その判断待ちは答えられるまま残る", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    let resolved: unknown;
    const fake = (async function* (opts: {
      onToolApprovalRequested?: (p: unknown) => void;
    }) {
      yield { type: "message" as const, message: initMessage([]) } as never;
      const pending = {
        toolCallId: "call-1",
        toolName: "mcp__filesystem__listDirectory",
        input: { path: "." },
        resolve: (r: unknown) => {
          resolved = r;
        },
      };
      opts.onToolApprovalRequested?.(pending);
      yield { type: "approval_requested" as const, pending } as never;
      throw new Error("途中で落ちた");
    }) as unknown as typeof runTurn;

    const events = await collect(
      runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "読んで", modules: [] }),
    );

    const judgment = events.find((e) => e.type === "judgment") as { judgmentId: string } | undefined;
    assert.ok(judgment, "判断待ちが出ていない");
    assert.ok(events.some((e) => e.type === "error"), "落ちたことを伝えていない（規則2）");

    // **受信箱に残っていて、まだ生きている**
    const item = deps.inbox.get(judgment!.judgmentId);
    assert.ok(item, "落ちたら判断待ちごと消えた");
    assert.equal(item!.kind, "judgment");
    assert.equal(
      (item as { liveness?: string }).liveness,
      "live",
      "答えられない状態になっている",
    );
    // **答える先も残っている**——答えれば host 側の呼び出しが動く
    assert.equal(
      deps.pendingApprovals.resolve(judgment!.judgmentId, { behavior: "deny", message: "やめる" }),
      true,
      "答え先が失われている（答えても何も起きない）",
    );
    assert.deepEqual(resolved, { behavior: "deny", message: "やめる" });

    // 落ちたターンは resume-point を進めない（アーキ仕様 §2.2）
    assert.equal(store.getThread(threadId)!.resumePoint, undefined);
  });
});

// **効かせる Skill は、新しいセッションの最初のターンで決まる**（決定・2026-09-23、§5.7）。
// `instructions` は resume では読み直されない（実測）——続きのターンで決め直しても
// モデルには届かず、記録だけが嘘になる。
test("Skill の集合は resume しないターンでだけ決めて刻み、続きのターンでは決め直さない", async () => {
  const { currentSkillSet } = await import("../project-thread/store.js");
  await withThread(async ({ deps, threadId, store }) => {
    let asked = 0;
    let names = ["pdf"];
    const resolveSessionSkills = async () => {
      asked += 1;
      return {
        active: names.map((name) => ({ module: "skills", name, description: name, uri: `skill://${name}` })),
        othersIn: [],
        problems: [],
      };
    };
    const run = async (prompt: string) => {
      const { fake } = fakeRunner([initMessage([]), assistantMessage("はい")]);
      return collect(
        runThreadTurn({ ...deps, runTurn: fake, resolveSessionSkills }, { threadId, prompt, modules: [] }),
      );
    };

    await run("1ターン目");
    assert.equal(asked, 1);
    const firstSeq = store.getThread(threadId)!.skillSets![0]!.seq;
    const firstUserMessage = store.getThread(threadId)!.messages.find((m) => m.role === "user")!;
    assert.ok(firstSeq < firstUserMessage.seq, "人の発言より後に刻んだ（その発言の時点で何が効いていたか引けない）");

    // 設定が変わっても、続きのターン（resume）では決め直さない
    names = ["pdf", "xlsx"];
    await run("2ターン目");
    assert.equal(asked, 1, "resume するターンで決め直した");
    assert.deepEqual(
      currentSkillSet(store.getThread(threadId)!)!.active.map((s) => s.name),
      ["pdf"],
    );

    // Clear すると resume を外すので、次のターンで決め直す
    await store.clearThread(threadId);
    await run("Clear の後");
    assert.equal(asked, 2, "Clear の後に決め直していない");
    assert.deepEqual(
      currentSkillSet(store.getThread(threadId)!)!.active.map((s) => s.name),
      ["pdf", "xlsx"],
    );
  });
});

test("効かせる Skill を決められなければ、走らせずに止める（何も効かせない会話を黙って始めない）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake, state } = fakeRunner([initMessage([]), assistantMessage("はい")]);
    const events = await collect(
      runThreadTurn(
        {
          ...deps,
          runTurn: fake,
          resolveSessionSkills: async () => {
            throw new Error("壊れた");
          },
        },
        { threadId, prompt: "やあ", modules: [] },
      ),
    );
    const error = events.find((e) => e.type === "error") as { message: string } | undefined;
    assert.match(error?.message ?? "", /効かせる Skill を決められませんでした: 壊れた/);
    assert.equal(state.yielded, 0, "決められないまま走らせた");
    assert.equal(store.getThread(threadId)!.messages.length, 0);
  });
});

// **別々に届いた文は、記録でも段落を分ける**（改訂・2026-09-26、`live-text-join-differs-from-record`）。
// 画面の流れている吹き出し（`addTextBlock`）と同じ見え方にする——改行1つだと Markdown では同じ段落に混ざる
test("記録に残す AI の発言は、文ブロックの間で段落を分ける（tool を挟んでも、API Error の合成文でも）", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = fakeRunner([
      initMessage([]),
      assistantMessage("調べます。"),
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "結果" }] } },
      assistantMessage("分かりました。"),
      assistantMessage("API Error: 529 Overloaded."),
    ]);
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "調べて", modules: [] }));
    const assistant = store.getThread(threadId)!.messages.find((m) => m.role === "assistant");
    assert.equal(assistant?.text, "調べます。\n\n分かりました。\n\nAPI Error: 529 Overloaded.");
  });
});

// **期限切れの判断待ちは「まだ返事が無いもの」に出さない**（訂正・2026-10-04、ユーザー報告）。host の再起動で畳んだ
// 承認が、公開が済んだあともターンの文脈に残り続けていた
test("ターンの文脈の「まだ返事が無いもの」には、生きている判断待ちだけを出す（期限切れ・回答済みは出さない）", async () => {
  await withThread(async ({ deps, threadId }) => {
    const live = await deps.inbox.raiseJudgment({ threadId, source: "relay", message: "生きている承認", serverName: "x", toolInput: {} });
    const expired = await deps.inbox.raiseJudgment({ threadId, source: "relay", message: "期限切れの承認", serverName: "x", toolInput: {} });
    await deps.inbox.timeoutJudgment(expired.id);
    const answered = await deps.inbox.raiseJudgment({ threadId, source: "relay", message: "答えた承認", serverName: "x", toolInput: {} });
    await deps.inbox.answerJudgment(answered.id, { behavior: "allow" });
    assert.equal(live.liveness, "live");

    let prompt = "";
    const fake = (async function* (opts: { prompt: string }) {
      prompt = opts.prompt;
      yield { type: "message" as const, message: initMessage([]) } as never;
      return { sessionId: "session-1", compactionCount: 0 } as never;
    }) as unknown as typeof runTurn;
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "続けて", modules: [] }));

    assert.match(prompt, /生きている承認/);
    assert.doesNotMatch(prompt, /期限切れの承認/);
    assert.doesNotMatch(prompt, /答えた承認/);
  });
});

// **起こし直しをまたいで続ける**（2026-10-05、アーキ仕様 §2.5）——ターンの頭・system/init・終わりを Event Store に残す

/**
 * 渡されたものを覚える Runner。`hangAfterInit` なら system/init を出したあと返らない（host がそこで止まった）。
 * 名乗る session id は本物と同じ決め方：resume ならその id、Fork なら新しい id、新しい会話なら渡された id
 */
function recordingRunner(options: { hangAfterInit?: boolean; throwAfterInit?: boolean } = {}) {
  const calls: Array<{ sessionId?: string; resumeSessionId?: string; resumeSessionAt?: string; forkSession?: boolean }> = [];
  const fake = (async function* (opts: {
    sessionId?: string;
    resumeSessionId?: string;
    resumeSessionAt?: string;
    forkSession?: boolean;
    signal?: AbortSignal;
  }) {
    calls.push({
      sessionId: opts.sessionId,
      resumeSessionId: opts.resumeSessionId,
      resumeSessionAt: opts.resumeSessionAt,
      forkSession: opts.forkSession,
    });
    const sessionId =
      opts.resumeSessionId && !opts.forkSession
        ? opts.resumeSessionId
        : (opts.sessionId ?? `forked-${calls.length}`);
    yield { type: "message" as const, message: { type: "system", subtype: "init", session_id: sessionId, mcp_servers: [] } } as never;
    // 止められたら本物と同じく投げて終わる（止めない限り返らない）
    if (options.hangAfterInit) {
      await new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    if (options.throwAfterInit) throw new Error("API が落ちた");
    yield {
      type: "message" as const,
      message: { type: "assistant", uuid: `uuid-${calls.length}`, message: { content: [{ type: "text", text: "はい" }] } },
    } as never;
    return { sessionId, compactionCount: 0 } as never;
  }) as unknown as typeof runTurn;
  return { fake, calls };
}

/** 同じ置き場を、起動し直したように開き直す（snapshot は書いていない——ログだけから畳む） */
async function reopenStore(dir: string): Promise<ProjectThreadStore> {
  const log = new EventLog(dir);
  await log.init();
  const store = new ProjectThreadStore(dir, log);
  await store.load();
  return store;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("新しい会話の最初のターンは、host が session id を先に決めて Runner に渡し、始まり・会話の id・終わりを残す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake, calls } = recordingRunner();
    const events = await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] }));
    assert.ok(events.some((e) => e.type === "done"));

    const assigned = calls[0]!.sessionId;
    assert.match(assigned ?? "", UUID, "新しい会話なのに session id を先に決めていない");
    const turn = store.getThread(threadId)!.lastTurn!;
    assert.equal(turn.assignedSessionId, assigned);
    assert.equal(turn.knownSessionId, assigned);
    assert.equal(turn.cause, "human");
    assert.equal(turn.attempt, 0);
    assert.equal(turn.resumePoint, undefined);
    assert.equal(turn.outcome, "completed");
    assert.equal(store.getThread(threadId)!.resumePoint, assigned);
    // このターンで積んだ人の発言は、始まりより後ろ
    const human = store.getThread(threadId)!.messages.find((m) => m.role === "user")!;
    assert.ok(human.seq > turn.startedSeq, "発言を始まりより先に積んでいる");
    assert.deepEqual(store.listInterruptedTurns(), []);

    // 続きのターン（resume）では決めない。始めたときの resume-point を残す
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "続き", modules: [], attempt: 1 }));
    assert.equal(calls[1]!.sessionId, undefined, "resume なのに session id を渡している（SDK が断る）");
    assert.equal(calls[1]!.resumeSessionId, assigned);
    const second = store.getThread(threadId)!.lastTurn!;
    assert.equal(second.resumePoint, assigned);
    assert.equal(second.assignedSessionId, undefined);
    assert.equal(second.attempt, 1);
    assert.equal(second.outcome, "completed");
  });
});

test("Fork の最初のターンも session id を先に決めて forkSession と一緒に渡す。会話の id は system/init で残す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake, calls } = recordingRunner();
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "親", modules: [] }));
    const fork = await store.forkThread(threadId);
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId: fork.id, prompt: "分けた", modules: [] }));
    assert.equal(calls[1]!.forkSession, true);
    assert.equal(calls[1]!.resumeSessionId, calls[0]!.sessionId);
    assert.match(calls[1]!.sessionId ?? "", UUID, "Fork の最初のターンで session id を先に決めていない");
    assert.notEqual(calls[1]!.sessionId, calls[0]!.sessionId);
    const turn = store.getThread(fork.id)!.lastTurn!;
    assert.equal(turn.assignedSessionId, calls[1]!.sessionId);
    assert.equal(turn.knownSessionId, calls[1]!.sessionId);
    assert.equal(turn.resumePoint, calls[0]!.sessionId);
    assert.equal(store.getThread(fork.id)!.resumePoint, calls[1]!.sessionId);
    // 分けたあとのターンは自分の会話の続き——もう決めない
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId: fork.id, prompt: "続き", modules: [] }));
    assert.equal(calls[2]!.forkSession, false);
    assert.equal(calls[2]!.sessionId, undefined);
  });
});

test("ターンの途中で host が止まったら、起動し直した store から切れたターンが1件見える", async () => {
  await withThread(async ({ deps, threadId, dir }) => {
    const { fake, calls } = recordingRunner({ hangAfterInit: true });
    const gen = runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "長い仕事", modules: [] });
    // system/init まで流れたところで止まる——ジェネレータは閉じない（finally を通らない＝プロセスが消えた）
    const first = await gen.next();
    assert.equal((first.value as { type: string }).type, "message");

    const reopened = await reopenStore(dir);
    const found = reopened.listInterruptedTurns();
    assert.equal(found.length, 1);
    assert.equal(found[0]!.threadId, threadId);
    assert.equal(found[0]!.sessionId, calls[0]!.sessionId);
    assert.equal(found[0]!.cause, "human");
    assert.equal(found[0]!.attempt, 0);
    assert.equal(reopened.getThread(threadId)!.resumePoint, undefined, "切れたターンで resume-point が進んでいる");

    // 起き直したあとに人が Clear したら、もう続けない
    await reopened.clearThread(threadId);
    assert.deepEqual((await reopenStore(dir)).listInterruptedTurns(), []);
  });
});

test("system/init より前に止まっても、host が先に決めた id で見分けられる", async () => {
  await withThread(async ({ deps, threadId, dir }) => {
    const calls: Array<{ sessionId?: string }> = [];
    const fake = (async function* (opts: { sessionId?: string }) {
      calls.push({ sessionId: opts.sessionId });
      await new Promise(() => {});
    }) as unknown as typeof runTurn;
    const gen = runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] });
    void gen.next();
    // Runner が呼ばれるまで待つ（始まりはその前に書かれている）
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const [found] = (await reopenStore(dir)).listInterruptedTurns();
    assert.match(found?.sessionId ?? "", UUID);
    assert.equal(found?.sessionId, calls[0]!.sessionId);
  });
});

test("resume-point を書いたあとに host が止まったターンは、切れたことにしない", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const { fake } = recordingRunner();
    // resume-point の次（返事の記録）で止まる
    const original = store.appendMessage.bind(store);
    let reached!: () => void;
    const stuck = new Promise<void>((resolve) => (reached = resolve));
    store.appendMessage = ((...args: Parameters<typeof original>) => {
      if (args[1] === "assistant") {
        reached();
        return new Promise<number>(() => {});
      }
      return original(...args);
    }) as typeof store.appendMessage;
    void collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] }));
    await stuck;

    const reopened = await reopenStore(dir);
    assert.ok(reopened.getThread(threadId)!.resumePoint, "resume-point が書かれていない（試験の前提が崩れた）");
    assert.equal(reopened.getThread(threadId)!.lastTurn?.outcome, undefined, "終わりが書かれている（試験の前提が崩れた）");
    assert.deepEqual(reopened.listInterruptedTurns(), []);
  });
});

test("失敗したターンは failed、人が止めたターンは stopped で終わりを残す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = recordingRunner({ throwAfterInit: true });
    const events = await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] }));
    assert.ok(events.some((e) => e.type === "error"));
    assert.equal(store.getThread(threadId)!.lastTurn?.outcome, "failed");

    const stop = new AbortController();
    const { fake: hanging } = recordingRunner({ hangAfterInit: true });
    const gen = runThreadTurn({ ...deps, runTurn: hanging }, { threadId, prompt: "止める", modules: [], stop: stop.signal });
    await gen.next();
    stop.abort();
    const rest: TurnStreamEvent[] = [];
    for await (const e of gen) rest.push(e);
    assert.ok(rest.some((e) => e.type === "stopped"));
    assert.equal(store.getThread(threadId)!.lastTurn?.outcome, "stopped");
    assert.deepEqual(store.listInterruptedTurns(), []);
  });
});

test("届いたものだけで起こしたターンは cause が delivery", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = recordingRunner();
    await store.recordDelivery({ threadId, deliveryId: "d1", from: "subagent", title: "終わりました", text: "結果", hop: 1 });
    await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "", modules: [] }));
    assert.equal(store.getThread(threadId)!.lastTurn?.cause, "delivery");
  });
});

test("ターンを始める前に断ったもの（渡すものが無い等）は、始まりも終わりも残さない", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = recordingRunner();
    const events = await collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "", modules: [] }));
    assert.ok(events.some((e) => e.type === "error"));
    assert.equal(store.getThread(threadId)!.lastTurn, undefined);
  });
});

/** Event Store に残っている、その種類の出来事の数 */
async function countEvents(dir: string, type: string): Promise<number> {
  const log = new EventLog(dir);
  await log.init();
  let n = 0;
  for await (const e of log.readFrom(0)) if (e.type === type) n += 1;
  return n;
}

test("人が止めたら、止めると決めた時点で stopped を残す——片づけの途中で落ちても切れたことにしない", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const { fake } = recordingRunner({ hangAfterInit: true });
    // 取り消しの記録（止めたあとの片づけ）で止まる
    let reached!: () => void;
    const stuck = new Promise<void>((resolve) => (reached = resolve));
    store.withdrawMessage = (() => {
      reached();
      return new Promise<void>(() => {});
    }) as typeof store.withdrawMessage;
    const stop = new AbortController();
    const gen = runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "止める", modules: [], stop: stop.signal });
    await gen.next();
    stop.abort();
    void gen.next();
    await stuck;

    const reopened = await reopenStore(dir);
    assert.equal(reopened.getThread(threadId)!.lastTurn?.outcome, "stopped");
    assert.deepEqual(reopened.listInterruptedTurns(), [], "人が止めたターンを、切れたターンとして続けようとしている");
  });
});

test("人が止めたターンの終わりは1回だけ書く", async () => {
  await withThread(async ({ deps, threadId, store, dir }) => {
    const { fake } = recordingRunner({ hangAfterInit: true });
    const stop = new AbortController();
    const gen = runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "止める", modules: [], stop: stop.signal });
    await gen.next();
    stop.abort();
    for await (const _ of gen) {
      // 最後まで読む
    }
    assert.equal(store.getThread(threadId)!.lastTurn?.outcome, "stopped");
    assert.equal(await countEvents(dir, "turn.ended"), 1);
  });
});

test("健全性検査で止めたターンは failed で終わりを残す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = fakeRunner([initMessage([{ name: "filesystem", status: "failed" }]), assistantMessage("x")]);
    const events = await collect(
      runThreadTurn(
        { ...deps, runTurn: fake },
        { threadId, prompt: "読んで", modules: [{ name: "filesystem", url: "http://127.0.0.1:1/agent-relay/filesystem" }] },
      ),
    );
    assert.ok(events.some((e) => e.type === "error"));
    assert.equal(store.getThread(threadId)!.lastTurn?.outcome, "failed");
    assert.deepEqual(store.listInterruptedTurns(), []);
  });
});

test("走っている最初のターンを Clear したら、そのターンが終わっても会話は畳まれたまま", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = (async function* (opts: { sessionId?: string }) {
      yield { type: "message" as const, message: { type: "system", subtype: "init", session_id: opts.sessionId, mcp_servers: [] } } as never;
      await gate;
      yield { type: "message" as const, message: { type: "assistant", uuid: "u1", message: { content: [{ type: "text", text: "はい" }] } } } as never;
      return { sessionId: opts.sessionId, compactionCount: 0 } as never;
    }) as unknown as typeof runTurn;
    const gen = runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] });
    await gen.next();
    await store.clearThread(threadId);
    release();
    for await (const _ of gen) {
      // 最後まで読む
    }
    assert.equal(store.getThread(threadId)!.lastTurn?.outcome, "completed");
    assert.equal(store.getThread(threadId)!.resumePoint, undefined, "Clear のあとに、畳む前の会話が戻った");
  });
});

test("切れたターンが積んだ発言の数が、見分けた結果に入る", async () => {
  await withThread(async ({ deps, threadId, dir }) => {
    const { fake } = recordingRunner({ hangAfterInit: true });
    const gen = runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "長い仕事", modules: [] });
    await gen.next();
    const [found] = (await reopenStore(dir)).listInterruptedTurns();
    assert.equal(found?.stackedMessages, 1);
  });
});

test("画面に出す走り始めた時刻は、記録に残した turn.started の時刻", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    // begin に渡る時刻をわざとずらす——同じミリ秒に収まると、そろえなくても同じ値になって見分けられない
    class EarlyBus extends TurnEventBus {
      override begin(id: string, _startedAt: string): void {
        super.begin(id, "2000-01-01T00:00:00.000Z");
      }
    }
    const turnEvents = new EarlyBus();
    const { fake } = recordingRunner({ hangAfterInit: true });
    const gen = runThreadTurn({ ...deps, turnEvents, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] });
    await gen.next();
    assert.equal(turnEvents.snapshot(threadId)?.startedAt, store.getThread(threadId)!.lastTurn!.startedAt);
  });
});

test("例外で抜けたターン・呼び出し側が途中で読むのをやめたターンも failed で終わりを残す", async () => {
  await withThread(async ({ deps, threadId, store }) => {
    const { fake } = recordingRunner();
    const original = store.appendMessage.bind(store);
    store.appendMessage = ((...args: Parameters<typeof original>) => {
      if (args[1] === "assistant") return Promise.reject(new Error("記録に書けない"));
      return original(...args);
    }) as typeof store.appendMessage;
    await assert.rejects(collect(runThreadTurn({ ...deps, runTurn: fake }, { threadId, prompt: "こんにちは", modules: [] })), /記録に書けない/);
    assert.equal(store.getThread(threadId)!.lastTurn?.outcome, "failed");
    store.appendMessage = original;

    const { fake: hanging } = recordingRunner({ hangAfterInit: true });
    const gen = runThreadTurn({ ...deps, runTurn: hanging }, { threadId, prompt: "途中まで", modules: [] });
    await gen.next();
    await gen.return(undefined);
    const turn = store.getThread(threadId)!.lastTurn!;
    assert.equal(turn.outcome, "failed");
  });
});
