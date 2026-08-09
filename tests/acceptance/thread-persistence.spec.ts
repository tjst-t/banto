/**
 * task-0036: 会話がホストの再起動を越えて残る。
 *
 * **2つの別々のものを残す必要がある**——POに見えていた会話（記録）と、番頭が覚えている
 * 中身（pi のセッション）。片方だけだと「画面には会話があるのに番頭は何も覚えていない」か、
 * その逆になる。ここでは前者と、後者へ繋ぐ紐（セッションファイルが器へ渡ること）を見る。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ThreadRegistry, ThreadStore, type HostSession, type ThreadFactory } from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

class FakeSession implements HostSession {
  readonly sessionId = "s";
  isStreaming = false;
  subscribe(): () => void {
    return () => undefined;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
}

/** 器を作るたびに、渡された復元元を記録する。 */
function factoryRecording(seen: Array<string | undefined>): ThreadFactory {
  return async (threadId, resumeFrom) => {
    seen.push(resumeFrom);
    return {
      session: new FakeSession(),
      tools: [],
      sessionFile: path.join(dir, `${threadId}-session.jsonl`),
    };
  };
}

describe("[task-0036] 会話が再起動を越えて残る", () => {
  it("発言・題・畳んだ状態が読み戻せる", async () => {
    const store = new ThreadStore(dir);
    const first = new ThreadRegistry(factoryRecording([]), store);

    const a = await first.open({ kind: "trunk", title: "最初の相談" });
    a.record({ role: "po", text: "こんにちは" });
    a.record({ role: "banto", text: "はい" });
    const b = await first.open(branchSpec("別の話"));
    b.record({ role: "po", text: "こっちは畳む" });
    first.merge(b.id, "結論");
    first.flushAll();

    // 別のインスタンス＝再起動した想定
    const seen: Array<string | undefined> = [];
    const second = new ThreadRegistry(factoryRecording(seen), new ThreadStore(dir));
    await second.restore();

    const restoredA = second.resolve(a.id);
    assert.equal(restoredA.title, "最初の相談");
    // 幹には枝の札（開いた1行）と結論（還った1行）が積まれる（決定77）
    assert.deepEqual(
      restoredA.transcript.map((e) => ("text" in e ? e.text : e.role)),
      ["こんにちは", "はい", "branch", "branch_result"]
    );

    const restoredB = second.resolve(b.id);
    assert.equal(restoredB.state, "closed", "畳んだ会話は畳んだまま戻ること");
    assert.equal(restoredB.transcript.length, 1);

    // **番頭の文脈へ繋ぐ紐**。これが渡らないと、画面だけ戻って番頭は忘れている
    assert.deepEqual(seen, [
      path.join(dir, `${a.id}-session.jsonl`),
      path.join(dir, `${b.id}-session.jsonl`),
    ]);
  });

  it("id の番号は再起動を越えて続く（過去の会話を上書きしない）", async () => {
    const store = new ThreadStore(dir);
    const first = new ThreadRegistry(factoryRecording([]), store);
    await first.open(TRUNK);
    await first.open(branchSpec("枝1"));
    first.flushAll();

    const second = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await second.restore();
    const fresh = await second.open(branchSpec("3本目"));
    assert.equal(fresh.id, "thread-3", "続きから振ること");
    assert.equal(second.list().length, 3);
  });

  it("保存先を渡さなければ何も書かない（テストと使い捨てのため）", async () => {
    const registry = new ThreadRegistry(factoryRecording([]));
    const thread = await registry.open(TRUNK);
    thread.record({ role: "po", text: "残らない" });
    registry.flushAll();
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("開き直したときに、開いていた面も戻る", async () => {
    // canvas を持たない器なので tabs は空のまま。索引に canvasTabs の欄が出ることだけ見る
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factoryRecording([]), store);
    const thread = await registry.open(TRUNK);
    registry.flushAll();
    const saved = new ThreadStore(dir).threads().find((t) => t.id === thread.id)!;
    assert.equal(saved.state, "open");
    assert.ok(saved.createdAt);
  });
});

describe("[task-0036] 壊れた保存で黙って会話を失わない（I2）", () => {
  it("索引が壊れていたら止まる（空から始めない）", () => {
    fs.writeFileSync(path.join(dir, "index.json"), "{ これはJSONではない");
    assert.throws(() => new ThreadStore(dir), /会話の索引が壊れています/);
  });

  it("記録の1行が壊れていても、残りは読める", () => {
    const store = new ThreadStore(dir);
    store.append("thread-1", { role: "po", text: "1つ目" });
    fs.appendFileSync(path.join(dir, "thread-1.jsonl"), "壊れた行\n");
    store.append("thread-1", { role: "po", text: "2つ目" });

    const entries = new ThreadStore(dir).transcript("thread-1");
    assert.deepEqual(
      entries.map((e) => ("text" in e ? e.text : e.role)),
      ["1つ目", "2つ目"]
    );
  });

  it("保存されていない会話を読んでも落ちない", () => {
    assert.deepEqual(new ThreadStore(dir).transcript("thread-999"), []);
  });
});

/**
 * [task-0059] 「何も無いまま閉じた会話は保存先にも残さない」は**役目を終えた**
 * （ADR-0017 決定77）。枝は生まれた瞬間に幹へ札が立ち、畳むには結論が要るので、
 * 空の器が保存先に並ぶ経路そのものが無い。詳細は `banto-threads.spec.ts`。
 */

/**
 * [task-0088] 幹と枝より前の索引を読み戻す（ADR-0017 決定77）。
 *
 * 実運用の索引は**畳んだ会話から並んでいる**ので、「並びの先頭を幹」にすると
 * 畳まれた幹ができる——幹は永続で畳まない、が最初の起動で破れる。
 */
describe("[task-0088] 古い索引（kind の無い会話）を読み戻す", () => {
  /** kind を持たない索引を直に書く（幹と枝より前の形）。 */
  function writeLegacyIndex(threads: Array<Record<string, unknown>>): void {
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({ version: 1, counter: threads.length, threads }, null, 2)
    );
  }

  it("[task-0088] 畳んだ会話が先頭でも、幹に選ばれるのは開いている会話", async () => {
    writeLegacyIndex([
      { id: "thread-1", title: "はじめの会話", state: "closed", createdAt: "2026-07-01T00:00:00.000Z", closedAt: "2026-07-02T00:00:00.000Z" },
      { id: "thread-2", title: "会話 2", state: "closed", createdAt: "2026-07-03T00:00:00.000Z", closedAt: "2026-07-04T00:00:00.000Z" },
      { id: "thread-3", title: "いまの話", state: "open", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "thread-4", title: "別の話", state: "open", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);

    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await registry.restore();

    const trunk = registry.trunk();
    assert.ok(trunk, "幹が1本ある");
    assert.equal(trunk.id, "thread-3", "開いている先頭が幹");
    assert.equal(trunk.state, "open", "幹は畳まれていない");
    assert.equal(registry.list({ kind: "trunk" }).length, 1);

    // 残りは枝。**還す条件は遡って書けない**ので、読み戻したことが分かる条件が入る
    const branch = registry.resolve("thread-4");
    assert.equal(branch.kind, "branch");
    assert.equal(branch.parentId, trunk.id);
    assert.match(branch.returnCondition ?? "", /幹と枝より前/u);
    // 畳んでいた会話は畳んだまま（枝として履歴に残る）
    assert.equal(registry.resolve("thread-1").state, "closed");
  });

  it("[task-0088] 読み戻した枝にも幹の札が立つ（埋没しない不変条件）", async () => {
    writeLegacyIndex([
      { id: "thread-1", title: "いまの話", state: "open", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "thread-2", title: "別の話", state: "open", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);

    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await registry.restore();

    for (const seen of registry.branchVisibility()) {
      assert.ok(seen.trunkCard, `枝 ${seen.title} の札が幹に無い`);
      assert.ok(seen.visible);
    }

    // 二度目の起動で札が二重にならない（追記のみ・D3）
    registry.flushAll();
    const again = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await again.restore();
    const cards = again.trunk()!.transcript.filter((e) => e.role === "branch");
    assert.equal(cards.length, 1);
  });

  it("[task-0088] 全部畳まれていても幹は開いて戻す（幹の無い店は無い）", async () => {
    writeLegacyIndex([
      { id: "thread-1", title: "古い話", state: "closed", createdAt: "2026-07-01T00:00:00.000Z", closedAt: "2026-07-02T00:00:00.000Z" },
      { id: "thread-2", title: "最後の話", state: "closed", createdAt: "2026-07-03T00:00:00.000Z", closedAt: "2026-08-01T00:00:00.000Z" },
    ]);

    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await registry.restore();

    const trunk = registry.trunk();
    assert.ok(trunk, "幹が1本ある");
    assert.equal(trunk.id, "thread-2", "最後に畳んだものを幹にする");
    assert.equal(trunk.state, "open");
    assert.equal(registry.defaultThreadId, "thread-2");
  });
});

