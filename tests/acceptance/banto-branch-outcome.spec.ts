/**
 * task-0100: 枝の結末は流れる場所にしか無かった（ADR-0022）。
 *
 * `thread.merge` は幹の帯に結論1行を積むだけで、取次には積まず番頭のターンも回さない
 * ——畳んだことを受け止める場所が無かった。ここで見たいのは配る側の契約：
 *
 *   - 決定109・110: 畳んだら取次へ**知らせ**が1通増える。**判断待ちの件数（`pendingCount`）
 *     には数えない**。押せば「読んだ」で片付き、`state` は `open` に戻らない
 *   - 決定77（ADR-0017、不変）: 幹の帯の `branch_result` は今までどおり配られる
 *
 * 画面側（決定111・112：履歴に結論つきで並ぶ・幹の枝一覧）はホストの外なので、
 * ここでは対象にしない（型検査とビルドで確認）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  Inbox,
  ThreadRegistry,
  type ServerEvent,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

/** 対話ループの偽物。プロバイダは呼ばない（配信と帳簿の振る舞いだけを見る）。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  private readonly listeners = new Set<(event: HarnessEvent) => void>();
  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}

  // ── BantoHarness の残り（ADR-0020 決定89）。章立てはこの試験では使わない ──
  readonly backendId = "fake";
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

let dir: string;
let server: BantoHostServer | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-branch-outcome-"));
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startHost(): Promise<{ url: string; threads: ThreadRegistry; inbox: Inbox }> {
  const inbox = new Inbox(path.join(dir, "inbox.jsonl"));
  const threads = new ThreadRegistry(async () => ({ harness: new FakeSession(), tools: [] }));
  await threads.open(TRUNK);
  server = await BantoHostServer.start({ threads, inbox, port: 0 });
  return { url: `ws://localhost:${server.port}${BANTO_WS_PATH}`, threads, inbox };
}

/** 条件が満たされるまで待つ（イベントの到着を待ち合わせる）。 */
async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("[task-0100/a1] 枝を畳むと取次へ知らせが1通積まれる（判断ではない）", () => {
  it("merge すると notice が1通増え、判断待ちの件数（pendingCount）は増えない", async () => {
    const { threads, inbox } = await startHost();
    const trunk = threads.trunk()!;
    const branch = await threads.open(branchSpec("調査"));

    const pendingBefore = inbox.pendingCount();
    threads.merge(branch.id, "調べた結果はAだった");

    const notice = inbox.list().find((i) => i.opens?.threadId === branch.id);
    assert.ok(notice, "枝を畳んだら、その枝を指す知らせが積まれる");
    assert.equal(notice!.notice, true, "知らせの印が付く（判断ではない）");
    assert.equal(notice!.resolvedAt, undefined);
    assert.match(notice!.what, /調べた結果はAだった/, "本文に結論が載る");
    assert.equal(inbox.pendingCount(), pendingBefore, "判断待ちの件数は増えない（決定110）");
    // 幹自身を指す知らせにはしない（決定109：出所はその枝）
    assert.notEqual(notice!.opens?.threadId, trunk.id);
  });

  it("親を引けなくても知らせは積まれる（枝そのものが宛先なので幹の有無に依らない）", async () => {
    const { threads, inbox } = await startHost();
    await threads.open(branchSpec("調査"));
    const before = inbox.list().length;
    // 通常経路（親が引ける状態）でも確実に1通増えることの確認
    const branch2 = await threads.open(branchSpec("調査2"));
    threads.merge(branch2.id, "結論2");
    assert.equal(inbox.list().length, before + 1);
  });

  it("同じ結論で畳み直しても（冪等）知らせは増えない", async () => {
    const { threads, inbox } = await startHost();
    const branch = await threads.open(branchSpec("調査"));
    threads.merge(branch.id, "結論");
    threads.merge(branch.id, "結論"); // 2度目（merge 自体が冪等でここで早期リターンする）
    const notices = inbox.list().filter((i) => i.opens?.threadId === branch.id);
    assert.equal(notices.length, 1);
  });

  it("押すと「読んだ」で片付く。state は open に戻らない（決定111と同じ不変条件）", async () => {
    const { url, threads, inbox } = await startHost();
    const branch = await threads.open(branchSpec("調査"));
    threads.merge(branch.id, "結論");
    const itemId = inbox.list().find((i) => i.opens?.threadId === branch.id)!.id;

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    client.send({ type: "inbox_answer", itemId, actionId: "read" });

    await until(
      () =>
        events.some(
          (e) => e.type === "inbox_state" && e.items.some((i) => i.id === itemId && i.resolvedAt)
        ),
      "知らせが「読んだ」で畳まれること"
    );
    assert.equal(threads.get(branch.id)!.state, "closed", "読んだだけでは開き直らない");
    client.close();
  });
});

describe("[task-0100/a2] 幹の帯の branch_result はそのまま（ADR-0017 決定77 は変えない）", () => {
  it("branch_result は今までどおり配られ、詳細は載らない", async () => {
    const { url, threads } = await startHost();
    const branch = await threads.open(branchSpec("調査"));

    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    client.send({ type: "thread_merge", threadId: branch.id, conclusion: "決まった" });

    await until(() => events.some((e) => e.type === "branch_result"), "branch_result が配られること");
    const result = events.find((e) => e.type === "branch_result") as
      | { type: "branch_result"; conclusion: string; hasDetail?: boolean }
      | undefined;
    assert.equal(result?.conclusion, "決まった");
    assert.equal(result?.hasDetail, undefined, "詳細は幹へ流さない（決定108）");
    client.close();
  });
});
