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
