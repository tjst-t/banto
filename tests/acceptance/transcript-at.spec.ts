/**
 * task-0279: 会話の各エントリに記録時刻（`at`・UTC ISO）が付く。
 *
 * Slack 風の日時表示（発言の時刻・日付の区切り線）は、この `at` を UI が描くことで
 * 成り立つ。ここで固定するのは記録側——
 *
 * - 新しい行（po / banto / notice / error / reasoning / tool / utsuwa 等）を積むと
 *   `at`（`new Date().toISOString()` の UTC ISO）が付く
 * - 既に `at` を持つ行（branch_result / branch_note / chapter）は**上書きしない**
 * - 継ぎ足される行（番頭の発言・思考の差分）は**最初の差分の at を保つ**
 * - この変更より前の保存済み JSONL（`at` の無い行）は読み戻しても `at` を付けない
 *   ——過去の発言が「読み戻した時刻」で表示されてしまうのを避ける
 *
 * 表示側（web）の機械検査はブラウザが要るため回らない（imp-0068 の既知問題）。
 * 見た目は PO レビューで確かめる——ここはホスト側の材料（`at`）を固定する。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness } from "@banto/core";
import { ThreadRegistry, ThreadStore, type ThreadFactory } from "@banto/host";
import type { TranscriptEntry } from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-at-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

class FakeSession implements BantoHarness {
  readonly sessionId = "s";
  isStreaming = false;
  subscribe(): () => void {
    return () => undefined;
  }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> {}

  // ── BantoHarness の残り（ADR-0020 決定89）。この試験では使わない ──
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

function factory(): ThreadFactory {
  return async (threadId) => ({
    harness: new FakeSession(),
    tools: [],
    sessionFile: path.join(dir, `${threadId}-session.jsonl`),
  });
}
function isUtcIso(at: unknown): at is string {
  if (typeof at !== "string") return false;
  const date = new Date(at);
  return !Number.isNaN(date.getTime()) && date.toISOString() === at;
}

/** 全ての行に `at` が付いていることを確かめる（壊れた行は無いはずなので）。 */
function assertAllHaveAt(entries: readonly TranscriptEntry[]): void {  for (const entry of entries) {
    assert.ok(
      isUtcIso(entry.at),
      `${entry.role} の行に at（UTC ISO）が付くこと（実際: ${JSON.stringify(entry.at)}）`
    );
  }
}

describe("[task-0279] 会話の各エントリに記録時刻（at）が付く", () => {
  it("発言・知らせ・思考・道具・失敗を積むと、どの行にも at（UTC ISO）が付く", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory(), store);
    const thread = await registry.open(TRUNK);

    thread.record({ role: "po", text: "こんにちは" });
    thread.record({ role: "banto", text: "はい" });
    thread.record({ role: "notice", source: "worker", text: "職人からの報告" });
    thread.record({ role: "error", text: "失敗しました" });
    thread.record({ role: "reasoning", text: "まず前提を確かめる" });
    thread.record({ role: "tool", name: "memory.save", state: "running", input: {} });
    thread.record({ role: "tool", name: "memory.save", state: "ok", output: {} });

    assertAllHaveAt(thread.transcript);
  });

  it("既に at を持つ行（chapter / branch_result / branch_note）は上書きしない", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory(), store);
    const thread = await registry.open(TRUNK);

    // 記録済みの at（過去の時刻）——再記録の経路でも書き換わってはいけない
    const past = "2026-08-18T03:00:00.000Z";
    thread.record({ role: "chapter", chapter: 1, topic: "第1章", at: past });
    thread.record({
      role: "branch_result",
      branchId: "branch-x",
      title: "枝の話",
      conclusion: "結論が出た",
      at: past,
    });
    thread.record({
      role: "branch_note",
      branchId: "branch-x",
      title: "枝の話",
      kind: "report",
      text: "中間報告",
      at: past,
    });

    assert.equal(
      thread.transcript.find((e) => e.role === "chapter")?.at,
      past,
      "chapter の at を書き換えない"
    );
    assert.equal(
      thread.transcript.find((e) => e.role === "branch_result")?.at,
      past,
      "branch_result の at を書き換えない"
    );
    assert.equal(
      thread.transcript.find((e) => e.role === "branch_note")?.at,
      past,
      "branch_note の at を書き換えない"
    );
  });

  it("継ぎ足される発言・思考は、最初の差分の at を保つ", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory(), store);
    const thread = await registry.open(TRUNK);

    // 番頭の発言は1文字ずつ届いて1行に継ぎ足される（画面と同じ形に揃える）
    thread.record({ role: "banto", text: "は" });
    const firstAt = thread.transcript[thread.transcript.length - 1]!.at;
    thread.record({ role: "banto", text: "い" });
    thread.record({ role: "banto", text: "。" });

    assert.equal(thread.transcript.length, 1, "番頭の発言は1行にまとまること");
    const banto = thread.transcript[0];
    assert.equal(banto?.role, "banto");
    assert.equal(banto?.text, "はい。");
    assert.equal(banto?.at, firstAt, "継ぎ足しても最初の差分の at を保つこと");

    // 思考も同じ
    thread.record({ role: "reasoning", text: "まず" });
    const reasoningAt = thread.transcript[thread.transcript.length - 1]!.at;
    thread.record({ role: "reasoning", text: "確認する" });
    const reasoning = thread.transcript.find((e) => e.role === "reasoning");
    assert.equal(reasoning?.text, "まず確認する");
    assert.equal(reasoning?.at, reasoningAt, "思考も最初の差分の at を保つこと");
  });

  it("道具の行は開始した時刻の at を保つ（終了差分で付け替えない）", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory(), store);
    const thread = await registry.open(TRUNK);

    thread.record({ role: "tool", name: "memory.save", state: "running", input: {} });
    const runningAt = thread.transcript[thread.transcript.length - 1]!.at;
    thread.record({ role: "tool", name: "memory.save", state: "ok", output: {} });

    const tool = thread.transcript.find((e) => e.role === "tool");
    assert.equal(tool?.state, "ok");
    assert.equal(tool?.at, runningAt, "開始の行の at を保つこと");
  });

  it("store.append の直接の追記にも at が付く", () => {
    const store = new ThreadStore(dir);
    store.append("thread-1", { role: "po", text: "1つ目" });
    store.append("thread-1", { role: "banto", text: "2つ目" });

    const entries = new ThreadStore(dir).transcript("thread-1");
    assert.equal(entries.length, 2);
    assertAllHaveAt(entries);
  });

  it("at の無い過去の記録（JSONL）は読み戻しても at を付けない", () => {
    const store = new ThreadStore(dir);
    // 新しい追記は at が付く
    store.append("thread-1", { role: "po", text: "新しい発言" });
    // task-0279 より前の記録の形——生の JSONL に at の無い行を直接書く
    fs.appendFileSync(
      path.join(dir, "thread-1.jsonl"),
      `${JSON.stringify({ role: "banto", text: "古い返事" })}\n`,
      "utf-8"
    );

    const entries = new ThreadStore(dir).transcript("thread-1");
    const po = entries.find((e) => e.role === "po");
    const old = entries.find((e) => e.role === "banto");
    assert.ok(isUtcIso(po?.at), "新しい行には at が付くこと");
    assert.equal(old?.at, undefined, "過去の行には at を付けない（読み戻し時刻で誤表示しない）");
  });

  it("記録した at は保存をまたいで残る（再起動後も同じ時刻）", async () => {
    const store = new ThreadStore(dir);
    const registry = new ThreadRegistry(factory(), store);
    const thread = await registry.open(TRUNK);

    thread.record({ role: "po", text: "残る発言" });
    const recordedAt = thread.transcript[thread.transcript.length - 1]!.at;
    registry.flushAll();

    const reread = new ThreadStore(dir).transcript(thread.id);
    assert.equal(reread.length, 1);
    assert.equal(reread[0]?.at, recordedAt, "再起動をまたいで同じ at が読めること");
  });
});
