/**
 * 提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.4 の受け入れ検証。
 *
 * 眼目は「**既存の記憶を LLM に書き直させない**」こと。
 * 「Useful Memories Become Faulty When Continuously Updated by LLMs」（arXiv 2605.12978）が
 * 示した劣化——統合を繰り返すと記憶なしより悪くなる——への対処が、この形そのものである。
 *
 * - 抽出器が出せるのは差分（ADD / FIX）だけ
 * - 適用は追記のみ。既存の記憶の本文が上書きされることはない
 * - 出所は `extracted` として残り、PO が消せる（決定28）
 * - 発火は章の境界だけ（explicit gate）
 * - 抽出が失敗しても会話は止まらない（task-0022 a5）
 *
 * LLM には繋がない。抽出器は差し替え可能な引数なので、偽物を渡して機構だけを検証する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { JsonlMemoryStore } from "@banto/core";
import {
  ChapterKeeper,
  HandoffStore,
  applyMemoryDeltas,
  parseDeltas,
  type ChapterHandoff,
} from "@banto/host";

let dir: string;
let store: JsonlMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-extract-"));
  store = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 差分の読み取り ──────────────────────────────────────────────────────────

describe("[提案§3.4] 抽出器が出せるのは差分だけ", () => {
  it("ADD と FIX を読む", () => {
    const deltas = parseDeltas(
      ["ADD fact POの名前は「たくみ」である", "FIX mem-1 preference 結論から話す"].join("\n")
    );

    assert.deepEqual(deltas, [
      { op: "add", kind: "fact", text: "POの名前は「たくみ」である" },
      { op: "supersede", id: "mem-1", kind: "preference", text: "結論から話す" },
    ]);
  });

  it("NONE は何も出さない", () => {
    assert.deepEqual(parseDeltas("NONE"), []);
  });

  it("知らない kind の行は捨てる（無理に解釈して覚えない）", () => {
    assert.deepEqual(parseDeltas("ADD episode 今日バグXを直した"), []);
  });

  it("形式を外れた行は捨てる", () => {
    const deltas = parseDeltas("POは日本語を好みます。\nADD preference 日本語で返答する");
    assert.deepEqual(deltas, [{ op: "add", kind: "preference", text: "日本語で返答する" }]);
  });
});

// ── 適用 ────────────────────────────────────────────────────────────────────

describe("[提案§3.4] 差分の適用は追記のみ", () => {
  it("追加した記憶には出所が付く（決定28：PO が消せるように）", () => {
    const result = applyMemoryDeltas(store, [
      { op: "add", kind: "fact", text: "POの名前は「たくみ」である" },
    ]);

    assert.equal(result.added.length, 1);
    assert.equal(result.added[0]!.origin, "extracted");
  });

  it("既に覚えていることは足さない（task-0022 a6）", () => {
    store.save({ kind: "fact", text: "POの名前は「たくみ」である", origin: "explicit" });

    const result = applyMemoryDeltas(store, [
      { op: "add", kind: "fact", text: "POの名前は「たくみ」である" },
    ]);

    assert.equal(result.added.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /既に覚えている/);
    assert.equal(store.list().length, 1, "二重に覚えてはいけない");
  });

  it("空白と大小文字の違いでは二重に覚えない", () => {
    store.save({ kind: "preference", text: "結論 から 話す" });
    const result = applyMemoryDeltas(store, [
      { op: "add", kind: "preference", text: "結論から話す" },
    ]);
    assert.equal(result.added.length, 0);
  });

  it("訂正は追記で表され、元の記憶の本文は書き換わらない", () => {
    const original = store.save({ kind: "preference", text: "古い前提" });
    applyMemoryDeltas(store, [
      { op: "supersede", id: original.id, kind: "preference", text: "新しい前提" },
    ]);

    // 有効な記憶は新しいほうだけ
    assert.deepEqual(store.list().map((r) => r.text), ["新しい前提"]);
    // ファイルには元の記憶がそのまま残っている（一級の証拠・D3）
    const raw = fs.readFileSync(path.join(dir, "memory.jsonl"), "utf-8");
    assert.match(raw, /古い前提/);
    assert.equal(store.get(original.id)?.text, "古い前提", "元の記憶が書き換わってはいけない");
  });

  it("知らないIDの訂正は適用しない（IDの捏造で誤りを増やさない）", () => {
    const result = applyMemoryDeltas(store, [
      { op: "supersede", id: "mem-does-not-exist", kind: "fact", text: "でっちあげ" },
    ]);

    assert.equal(result.corrected.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0]!.reason, /知らないID/);
    assert.deepEqual(store.list(), [], "黙って新規作成してはいけない");
  });

  it("適用しなかった差分は黙って消えず、理由つきで返る（I2）", () => {
    store.save({ kind: "fact", text: "既知" });
    const result = applyMemoryDeltas(store, [
      { op: "add", kind: "fact", text: "既知" },
      { op: "supersede", id: "nope", kind: "fact", text: "x" },
    ]);
    assert.equal(result.skipped.length, 2);
  });

  it("同じ差分が2件来ても1件しか足さない", () => {
    const result = applyMemoryDeltas(store, [
      { op: "add", kind: "habit", text: "毎朝キューを見る" },
      { op: "add", kind: "habit", text: "毎朝キューを見る" },
    ]);
    assert.equal(result.added.length, 1);
    assert.equal(result.skipped.length, 1);
  });
});

// ── 発火の門（explicit gate）────────────────────────────────────────────────

describe("[提案§3.4] 抽出は章の境界だけで走る（explicit gate）", () => {
  const handoff = async (): Promise<ChapterHandoff> => ({
    summary: { topic: "章", decided: [], next: [] },
    body: "詳細",
  });

  function session(messages: unknown[], sm: SessionManager) {
    return {
      agent: { state: { messages } },
      sessionManager: sm,
      setAutoCompactionEnabled() {},
      subscribe: () => () => {},
    };
  }

  it("章を閉じたときに抽出が呼ばれ、材料は書き起こしだけ", async () => {
    const seen: string[] = [];
    const keeper = new ChapterKeeper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 偽のセッション
      session: session(
        [
          { role: "user", content: [{ type: "text", text: "日本語で返答して" }] },
          { role: "assistant", content: [{ type: "text", text: "承知しました" }] },
        ],
        SessionManager.inMemory()
      ) as any,
      store: new HandoffStore(path.join(dir, "handoffs")),
      threadId: "thread-1",
      summarize: handoff,
      extractMemories: async (transcript) => {
        seen.push(transcript);
      },
    });

    await keeper.closeChapter();
    await new Promise((r) => setImmediate(r));

    assert.equal(seen.length, 1, "章を閉じたら1回だけ走る");
    assert.match(seen[0]!, /日本語で返答して/);
  });

  it("抽出が失敗しても章は閉じ、会話は止まらない（task-0022 a5）", async () => {
    const handoffStore = new HandoffStore(path.join(dir, "handoffs"));
    const keeper = new ChapterKeeper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 偽のセッション
      session: session(
        [{ role: "user", content: [{ type: "text", text: "A" }] }],
        SessionManager.inMemory()
      ) as any,
      store: handoffStore,
      threadId: "thread-1",
      summarize: handoff,
      extractMemories: async () => {
        throw new Error("抽出用のLLMが落ちた");
      },
    });

    const record = await keeper.closeChapter();
    assert.ok(record, "抽出の失敗で章の完了を巻き戻してはいけない");
    await new Promise((r) => setTimeout(r, 20));
  });
});
