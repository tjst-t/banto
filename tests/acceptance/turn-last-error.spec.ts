/**
 * task-0288: 幽霊402——切替前のハーネスに残った古いエラーを、切替後のターンの失敗として
 * 出さない。
 *
 * ## 何が起きたか（実測 2026-08-20）
 *
 * PO が幹の会話モデルを pi から Claude（claude-agent-sdk）へ切り替えたあと、
 * **切替後のターンでも毎回** `402: Insufficient credits`（OpenRouter）で失敗として
 * 記録され続けた。だが返答本文は実際に出ており、所要時間も本物の課金エラー（1秒未満）
 * ではなく Claude が応答を書き切る時間（27〜70秒）だった。
 *
 * 原因は `getLastError`（`packages/banto-host/src/bin.ts`）が常に **pi の
 * `HostSession` の状態**（`session.agent.state.errorMessage`）を読んでいたこと。
 * pi はハーネスを差し替えても走り続けないので、最後に残ったエラーが消えずに残り、
 * Claude へ切り替えた後の成功ターンにまで貼り付いていた。
 *
 * ここでは実際の pi / Claude Agent SDK を呼ばず、その壊れ方の形（「いま能動でない
 * ハーネスに残った古いエラー状態」）を再現する身代わりハーネスで、
 * `BantoHostServer` の実物のターン記録経路（`server.ts` の `set_model` / `prompt`
 * ハンドラ）を通して確かめる。
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { BantoHarness, ChapterOpening, HarnessEvent } from "@banto/core";
import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  ThreadRegistry,
  type ServerEvent,
} from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

/**
 * pi を模す身代わり。**実機の pi と同じく、失敗しても `prompt()` は投げない**
 * ——エラーは `errorMessage` に残るだけで、次に成功するまで自然には消えない
 * （bin.ts の `session.agent.state.errorMessage` と同じ形）。
 */
class FakePiHarness implements BantoHarness {
  readonly sessionId = "fake-pi";
  readonly backendId = "pi";
  isStreaming = false;
  /** 直前のターンでプロバイダ側エラーがあれば残る（pi の `state.errorMessage` の身代わり）。 */
  errorMessage: string | undefined;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(_opening: ChapterOpening): Promise<void> {}
}

/** Claude Agent SDK を模す身代わり。成功したターンは素通りする。 */
class FakeClaudeHarness implements BantoHarness {
  readonly sessionId = "fake-claude";
  readonly backendId = "claude-agent-sdk";
  isStreaming = false;
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(_opening: ChapterOpening): Promise<void> {}
}

let server: BantoHostServer | undefined;
let threads: ThreadRegistry | undefined;
let pi: FakePiHarness;
let claude: FakeClaudeHarness;

/**
 * `bin.ts` の `getLastError`（task-0288 修正後）と同じ組み方：**いま能動のハーネスが
 * pi のときだけ** pi の状態を読む。`threads.get(id)?.harness` は `replaceHarness` で
 * 差し替わる「いま」のハーネスなので、Claude へ切り替わった後は pi の古い
 * `errorMessage` を読まなくなる。
 */
async function startHost(): Promise<{ url: string; threadId: string }> {
  pi = new FakePiHarness();
  claude = new FakeClaudeHarness();
  threads = new ThreadRegistry(async (id) => ({
    harness: pi,
    tools: [],
    getLastError: () => (threads!.get(id)?.harness === pi ? pi.errorMessage : undefined),
  }));
  const opened = await threads.open(TRUNK);
  server = await BantoHostServer.start({
    threads,
    port: 0,
    // bin.ts の onSelectModel の身代わり: backend で pi / claude を切り替える
    onSelectModel: async (_thread, _provider, model, backend) => {
      if (backend === "claude-agent-sdk") {
        return { id: model, vision: false, backend, harness: claude };
      }
      return { id: model, vision: false, backend: "pi", harness: pi };
    },
  });
  return { url: `ws://localhost:${server.port}${BANTO_WS_PATH}`, threadId: opened.id };
}

function waitFor(
  events: ServerEvent[],
  type: ServerEvent["type"],
  timeoutMs = 2000,
  where: (e: ServerEvent) => boolean = () => true
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = events.find((e) => e.type === type && where(e));
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for "${type}"; got: ${events.map((e) => e.type).join(", ")}`));
      }
    }, 10);
  });
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  threads = undefined;
});

describe("[task-0288/a1] 切替後のターンは、切替前にハーネスへ残ったエラーを引き継がない", () => {
  it("pi に残った402が、Claudeへ切替後の成功ターンの失敗として出ない", async () => {
    const { url, threadId } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    // 切替前：pi にエラーが残った状態を再現（実機の「幽霊」の元）
    pi.errorMessage = "402: Insufficient credits (OpenRouter)";

    // Claude へ切り替える（bin.ts の set_model 経路と同じ）
    client.send({ type: "set_model", threadId, provider: "anthropic", model: "opus", backend: "claude-agent-sdk" });
    await waitFor(events, "model_state", 2000, (e) => e.type === "model_state" && e.backend === "claude-agent-sdk");

    // 切替後のターン。FakeClaudeHarness は必ず成功する
    events.length = 0;
    client.send({ type: "prompt", threadId, text: "こんにちは" });
    const turnEnd = await waitFor(events, "turn_end");
    assert.ok(turnEnd.type === "turn_end");
    assert.equal(
      turnEnd.errorMessage,
      undefined,
      "切替前に pi へ残っていたエラーが、切替後の成功ターンの失敗として出た（幽霊402）"
    );

    // 会話にも error 行が積まれていないこと
    events.length = 0;
    client.send({ type: "history_request", threadId });
    const history = await waitFor(events, "history");
    assert.ok(history.type === "history");
    assert.equal(
      history.entries.some((e) => e.role === "error"),
      false,
      "切替後の会話に error 行が積まれた"
    );

    client.close();
  });
});

describe("[task-0288/a2] そのターン自身の失敗は、これまで通り記録される", () => {
  it("pi のまま（切替なし）でエラーが残っていれば、そのターンは失敗として記録される", async () => {
    const { url, threadId } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    pi.errorMessage = "402: Insufficient credits (OpenRouter)";

    client.send({ type: "prompt", threadId, text: "こんにちは" });
    const turnEnd = await waitFor(events, "turn_end");
    assert.ok(turnEnd.type === "turn_end");
    assert.equal(turnEnd.errorMessage, "402: Insufficient credits (OpenRouter)", "自分のターンの失敗まで握り潰した（I2違反）");

    events.length = 0;
    client.send({ type: "history_request", threadId });
    const history = await waitFor(events, "history");
    assert.ok(history.type === "history");
    const last = history.entries.at(-1);
    assert.ok(last?.role === "error", `会話に error 行が残っていない: ${JSON.stringify(last)}`);

    client.close();
  });
});
