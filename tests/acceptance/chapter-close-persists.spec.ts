/**
 * inc-0075 / task-0164: **章を畳んだあとも記録がディスクに残る**。
 *
 * 事故の核心の疑問はこれだった——2026-08-15 05:18 に
 * 「thread-61: 記憶を4件追加・0件訂正しました」が出ている＝`ChapterKeeper.closeChapter()`
 * は**成功パスを完走している**。にもかかわらず、その章の印（`role:"chapter"`）も、
 * その後の会話も、記録に1行も残っていなかった。
 *
 * ここではその疑問をそのまま試験にする。LLM には繋がない——要約器は差し替え可能な
 * 引数なので、偽物を渡して機構だけを回す。確かめるのは**別インスタンスの `ThreadStore`
 * でディスクから読み直せるか**の1点（メモリを見ても、写しが書けたことの証拠にならない）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness } from "@banto/core";
import {
  ChapterKeeper,
  HandoffStore,
  ThreadRegistry,
  ThreadStore,
  type ChapterHandoff,
  type ThreadFactory,
} from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-chapter-persist-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 章立てが使うぶんだけの器。**畳めること**が要るので `messageCount` は 0 を返さない
 * （`closeChapter` は 0 のとき何もせず返る）。
 */
class FakeHarness implements BantoHarness {
  readonly backendId = "fake";
  readonly sessionId = "s";
  isStreaming = false;
  chapters = 0;
  subscribe(): () => void {
    return () => undefined;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}
  contextTokens(): number | undefined {
    return 700;
  }
  messageCount(): number {
    return 8;
  }
  transcript(): string {
    return "PO: やって\n\n番頭: はい";
  }
  async startChapter(): Promise<void> {
    this.chapters++;
  }
}

const factory: ThreadFactory = async (threadId) => ({
  harness: new FakeHarness(),
  tools: [],
  sessionFile: path.join(dir, `${threadId}-session.jsonl`),
});

const handoff: ChapterHandoff = {
  summary: { topic: "記録の書き戻し", decided: ["縮小は拒む"], next: ["試験で固定する"] },
  body: "詳細な経緯。",
};

/** ディスクから読み直す（**別インスタンス**でないと写しの検証にならない）。 */
function onDisk(threadId: string) {
  return new ThreadStore(dir).transcript(threadId);
}

describe("[task-0164 a2] 章を畳んだあとの記録がディスクへ書き戻される", () => {
  it("章の印と、畳んだ後に積んだ発言の両方がディスクから読める", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory, store);
    const thread = await registry.open(TRUNK);
    thread.record({ role: "po", text: "やって" });
    thread.record({ role: "banto", text: "はい" });

    const keeper = new ChapterKeeper({
      harness: new FakeHarness(),
      store: new HandoffStore(path.join(dir, "handoffs")),
      threadId: thread.id,
      summarize: async () => handoff,
      contextWindow: 1000,
      // server.markChapter がやっていること（画面に出る区切りの印）
      onChapterClosed: (record) => {
        thread.record({
          role: "chapter",
          chapter: record.chapter,
          topic: record.summary.topic,
          at: new Date().toISOString(),
        });
      },
    });

    const record = await keeper.closeChapter();
    assert.ok(record, "章が畳めていること（畳めていなければこの試験は何も見ていない）");

    registry.flushAll();

    const afterClose = onDisk(thread.id);
    assert.ok(
      afterClose.some((e) => e.role === "chapter"),
      `章の印がディスクに残ること（読めたのは ${JSON.stringify(afterClose.map((e) => e.role))}）`
    );

    // **核心**: 畳んだ後に積んだ発言も残るか（事故ではここが1行も残らなかった）
    thread.record({ role: "po", text: "章の後の発言" });
    thread.record({ role: "banto", text: "章の後の返事" });
    registry.flushAll();

    const afterMore = onDisk(thread.id);
    assert.deepEqual(
      afterMore.map((e) => e.role),
      ["po", "banto", "chapter", "po", "banto"],
      "畳む前・章の印・畳んだ後が順に残ること"
    );
    assert.equal(
      afterMore.filter((e) => "text" in e && e.text === "章の後の発言").length,
      1,
      "畳んだ後の発言が読めること"
    );
  });

  it("再起動しても（別の ThreadRegistry で復元しても）章の印は残る", async () => {
    const registry = new ThreadRegistry(factory, new ThreadStore(dir));
    const thread = await registry.open(TRUNK);
    thread.record({ role: "po", text: "やって" });
    thread.record({ role: "chapter", chapter: 1, topic: "第1章", at: new Date().toISOString() });
    thread.record({ role: "po", text: "章の後" });
    registry.flushAll();

    const restarted = new ThreadRegistry(factory, new ThreadStore(dir));
    await restarted.restore();
    assert.deepEqual(
      restarted.resolve(thread.id).transcript.map((e) => e.role),
      ["po", "chapter", "po"]
    );
  });
});

describe("[task-0164 a6] 要約器が連続で失敗した後でも、畳めたら印が記録に入る", () => {
  it("2回続けて失敗した後の3回目の成功で、印がディスクに残る", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory, store);
    const thread = await registry.open(TRUNK);
    thread.record({ role: "po", text: "やって" });

    let calls = 0;
    const keeper = new ChapterKeeper({
      harness: new FakeHarness(),
      store: new HandoffStore(path.join(dir, "handoffs")),
      threadId: thread.id,
      // 最初の2回だけ投げる（実機で壊れ始めたのがこの形）
      summarize: async () => {
        calls++;
        if (calls <= 2) throw new Error("要約器が落ちました");
        return handoff;
      },
      contextWindow: 1000,
      onChapterClosed: (record) => {
        thread.record({
          role: "chapter",
          chapter: record.chapter,
          topic: record.summary.topic,
          at: new Date().toISOString(),
        });
      },
    });

    for (const attempt of [1, 2]) {
      await assert.rejects(
        () => keeper.closeChapter(),
        /要約器が落ちました/u,
        `${attempt} 回目は畳めないこと（I2: 資料が書けなければ畳まない）`
      );
    }
    registry.flushAll();
    assert.equal(
      onDisk(thread.id).filter((e) => e.role === "chapter").length,
      0,
      "畳めていないのに印を書かないこと"
    );

    const record = await keeper.closeChapter();
    assert.ok(record, "3回目は畳めること（失敗が掛け金を握ったままになっていない）");
    registry.flushAll();

    const entries = onDisk(thread.id);
    assert.equal(
      entries.filter((e) => e.role === "chapter").length,
      1,
      `畳めた回の印がディスクに残ること（読めたのは ${JSON.stringify(entries.map((e) => e.role))}）`
    );

    // 印が入ったあとも会話は続けられ、残る
    thread.record({ role: "po", text: "続き" });
    registry.flushAll();
    assert.deepEqual(
      onDisk(thread.id).map((e) => e.role),
      ["po", "chapter", "po"]
    );
  });
});
