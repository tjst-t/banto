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

    const a = await first.open("最初の相談");
    a.record({ role: "po", text: "こんにちは" });
    a.record({ role: "banto", text: "はい" });
    const b = await first.open("別の話");
    b.record({ role: "po", text: "こっちは畳む" });
    first.close(b.id);
    first.flushAll();

    // 別のインスタンス＝再起動した想定
    const seen: Array<string | undefined> = [];
    const second = new ThreadRegistry(factoryRecording(seen), new ThreadStore(dir));
    await second.restore();

    const restoredA = second.resolve(a.id);
    assert.equal(restoredA.title, "最初の相談");
    assert.deepEqual(
      restoredA.transcript.map((e) => ("text" in e ? e.text : e.role)),
      ["こんにちは", "はい"]
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
    await first.open();
    await first.open();
    first.flushAll();

    const second = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await second.restore();
    const fresh = await second.open("3本目");
    assert.equal(fresh.id, "thread-3", "続きから振ること");
    assert.equal(second.list().length, 3);
  });

  it("保存先を渡さなければ何も書かない（テストと使い捨てのため）", async () => {
    const registry = new ThreadRegistry(factoryRecording([]));
    const thread = await registry.open();
    thread.record({ role: "po", text: "残らない" });
    registry.flushAll();
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("開き直したときに、開いていた面も戻る", async () => {
    // canvas を持たない器なので tabs は空のまま。索引に canvasTabs の欄が出ることだけ見る
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factoryRecording([]), store);
    const thread = await registry.open();
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

describe("[task-0059] 何も無いまま閉じた会話は保存先にも残さない（PO要望 2026-08-05）", () => {
  it("索引・記録・番頭の文脈のどれも残らない", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factoryRecording([]), store);
    const keep = await registry.open("残る会話");
    keep.record({ role: "po", text: "ひとこと" });
    const empty = await registry.open();
    registry.flushAll();
    const sessionFile = path.join(dir, `${empty.id}-session.jsonl`);
    fs.writeFileSync(sessionFile, "番頭の文脈\n");

    registry.close(empty.id);

    const saved = new ThreadStore(dir).threads();
    assert.deepEqual(saved.map((t) => t.id), [keep.id], "索引から消える");
    assert.equal(fs.existsSync(path.join(dir, `${empty.id}.jsonl`)), false, "記録も消える");
    assert.equal(fs.existsSync(sessionFile), false, "番頭の文脈も消える");
  });

  it("捨てた会話は再起動後にも出てこない", async () => {
    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    const keep = await registry.open("残る会話");
    keep.record({ role: "po", text: "ひとこと" });
    const empty = await registry.open();
    registry.close(empty.id);
    registry.flushAll();

    const restarted = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await restarted.restore();
    assert.deepEqual(restarted.list().map((t) => t.id), [keep.id]);
  });

  it("id の番号は使い回さない（捨てても次は続きから振る）", async () => {
    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    const first = await registry.open();
    first.record({ role: "po", text: "ひとこと" });
    const empty = await registry.open();
    registry.close(empty.id);

    const next = await registry.open();
    assert.equal(next.id, "thread-3", "捨てた番号を再利用すると、過去の記録と混ざる");
  });
});
