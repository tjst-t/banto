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
 * [task-0088] 幹と枝より前の索引を読み戻す（ADR-0017 決定77・PO裁定 2026-08-09）。
 *
 * **並んでいた会話は、1本残らず幹として戻す。** 幹がプロジェクトの単位なので、
 * それぞれ独立した話であって、どれかの枝ではない——**還す条件を後から捏造しない**
 * （決定77：書けないものは枝にしない）。
 */
describe("[task-0088] 古い索引（kind の無い会話）を読み戻す", () => {
  /** kind を持たない索引を直に書く（幹と枝より前の形）。 */
  function writeLegacyIndex(threads: Array<Record<string, unknown>>): void {
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({ version: 1, counter: threads.length, threads }, null, 2)
    );
  }

  it("[task-0088] 開いていた会話は全部が幹になり、枝はゼロ", async () => {
    writeLegacyIndex([
      { id: "thread-1", title: "はじめの会話", state: "closed", createdAt: "2026-07-01T00:00:00.000Z", closedAt: "2026-07-02T00:00:00.000Z" },
      { id: "thread-2", title: "いまの話", state: "open", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "thread-3", title: "別の話", state: "open", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);

    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await registry.restore();

    assert.deepEqual(
      registry.trunks({ state: "open" }).map((t) => t.title),
      ["いまの話", "別の話"],
      "開いていた会話はそれぞれ幹（＝プロジェクト）"
    );
    assert.equal(registry.list({ kind: "branch" }).length, 0, "枝はゼロ");
    assert.equal(registry.defaultThreadId, "thread-2");
    // 畳んでいたものは畳んだまま（履歴で読める）
    assert.equal(registry.resolve("thread-1").state, "closed");
    assert.equal(registry.resolve("thread-1").kind, "trunk");
  });

  it("[task-0088] 還す条件を捏造しない（枝を作らないので条件も要らない）", async () => {
    writeLegacyIndex([
      { id: "thread-1", title: "いまの話", state: "open", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "thread-2", title: "別の話", state: "open", createdAt: "2026-08-02T00:00:00.000Z" },
    ]);

    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await registry.restore();

    for (const t of registry.list()) {
      assert.equal(t.returnCondition, undefined, `${t.title} に条件が捏造されている`);
    }
    // 枝がゼロなので、埋没しない不変条件の走査も空
    assert.deepEqual(registry.branchVisibility(), []);
    // 幹には札も立たない（追記のみ・D3）
    assert.deepEqual(registry.resolve("thread-1").transcript, []);
  });

  it("[task-0088] 枝は親の幹の下に戻り、札の無いものには札が立つ", async () => {
    writeLegacyIndex([
      { id: "thread-1", title: "banto", kind: "trunk", state: "open", createdAt: "2026-08-01T00:00:00.000Z" },
      {
        id: "thread-2",
        title: "間欠的に落ちる試験",
        kind: "branch",
        parentId: "thread-1",
        returnCondition: "再現条件が特定できたら",
        openedBy: "banto",
        state: "open",
        createdAt: "2026-08-02T00:00:00.000Z",
      },
    ]);

    const registry = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await registry.restore();

    const seen = registry.branchVisibility();
    assert.equal(seen.length, 1);
    assert.ok(seen[0]!.trunkCard, "札が立て直されている");

    // 二度目の起動で札が二重にならない（追記のみ・D3）
    registry.flushAll();
    const again = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await again.restore();
    assert.equal(again.resolve("thread-1").transcript.filter((e) => e.role === "branch").length, 1);
  });
});

describe("[PO裁定 2026-08-10] 帳場は再起動を越えて帳場のまま", () => {
  it("読み戻しても帳場は1つで、宛先はそこ", async () => {
    const store = new ThreadStore(dir);
    const first = new ThreadRegistry(factoryRecording([]), store);
    await first.open({ kind: "trunk", title: "banto" });
    const main = await first.open({ kind: "trunk", main: true, title: "帳場" });
    first.flushAll();

    const second = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await second.restore();

    assert.equal(second.main()?.id, main.id);
    assert.equal(second.defaultThreadId, main.id);
    assert.equal(second.trunks().length, 2);
  });
});

describe("[PO報告 2026-08-10] 読み戻した会話にも「いまどの会話か」が渡る", () => {
  it("再起動しても帳場は帳場として渡される（立場を忘れない）", async () => {
    const first = new ThreadRegistry(factoryRecording([]), new ThreadStore(dir));
    await first.open({ kind: "trunk", main: true, title: "帳場" });
    const proj = await first.open({ kind: "trunk", title: "loamium" });
    await first.open(
      {
        kind: "branch",
        title: "エディタUI調査",
        returnCondition: "描画方式が決まったら",
        openedBy: "banto",
        reason: "往復が続く",
      },
      proj.id
    );
    first.flushAll();

    const seen: Array<Record<string, unknown> | undefined> = [];
    const second = new ThreadRegistry(async (threadId, _resume, _model, identity) => {
      seen.push(identity as Record<string, unknown> | undefined);
      return { session: new FakeSession(), tools: [] };
    }, new ThreadStore(dir));
    await second.restore();

    const main = seen.find((i) => i?.["isMain"] === true);
    assert.ok(main, "帳場の素性が渡っていない");
    const branch = seen.find((i) => i?.["kind"] === "branch");
    assert.equal(branch?.["returnCondition"], "描画方式が決まったら");
    // **どの幹の枝か**まで渡る（幹を先に読み戻しているので親が引ける）
    assert.equal(branch?.["parentTitle"], "loamium");
    // 読み戻しでも記憶の区画は親の幹（幹ごとの記憶が再起動で迷子にならない）
    assert.equal(branch?.["trunkId"], proj.id);
  });
});

