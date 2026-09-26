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
