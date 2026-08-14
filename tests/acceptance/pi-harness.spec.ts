/**
 * **pi バックエンドの翻訳**（ADR-0020 決定89・90・91）。
 *
 * seam を切ったとき、`server.ts` にあった「生の pi イベント → 番頭の語彙」の変換を
 * `PiHarness` へ下ろした。**その検証もここへ移す**——server 側の試験は「配って残るか」
 * だけを見るようになったので、文言と名前の変換はここが唯一の見張りになる。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { HarnessEvent } from "@banto/core";
import { PiHarness, renderTranscript } from "@banto/host";

/** pi のセッションの、翻訳に要る部分だけの偽物。 */
function fakePiSession(messages: unknown[] = []) {
  const listeners = new Set<(e: unknown) => void>();
  return {
    sessionId: "s-1",
    isStreaming: false,
    agent: { state: { messages } },
    setAutoCompactionEnabled(): void {},
    subscribe(listener: (e: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: unknown): void {
      for (const l of [...listeners]) l(event);
    },
    async prompt(): Promise<void> {},
    async abort(): Promise<void> {},
  };
}

function harnessWith(session: ReturnType<typeof fakePiSession>): PiHarness {
  return new PiHarness({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 偽のセッション（翻訳に要る部分だけ）
    session: session as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同じ偽物が pi の内部も兼ねる
    agentSession: session as any,
    toLogicalName: (wire) => (wire.includes("__") ? wire.replace(/__/g, ".") : wire),
    renderTranscript,
  });
}

/** 1つ流して、翻訳された出来事を集める。 */
function translate(events: unknown[]): HarnessEvent[] {
  const session = fakePiSession();
  const harness = harnessWith(session);
  const out: HarnessEvent[] = [];
  harness.subscribe((e) => out.push(e));
  for (const e of events) session.emit(e);
  return out;
}

describe("[ADR-0020 決定89] pi のイベントを番頭の語彙へ翻訳する", () => {
  it("本文の差分は text_delta になる", () => {
    const out = translate([
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "はい" } },
    ]);
    assert.deepEqual(out, [{ type: "text_delta", delta: "はい" }]);
  });

  it("思考は本文と別のチャネルで出る（決定90）", () => {
    const out = translate([
      { type: "message_update", assistantMessageEvent: { type: "thinking_start" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "考え中" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
    ]);
    assert.equal(out.length, 2, "thinking_start は出来事にならない（開始時刻を覚えるだけ）");
    assert.deepEqual(out[0], { type: "reasoning_delta", delta: "考え中" });
    assert.equal(out[1]?.type, "reasoning_end");
    assert.ok(out[1]?.type === "reasoning_end" && out[1].durationMs >= 0);
  });

  it("開始を見ていない思考の終わりは 0 を返す（時間を推測して名乗らない・I1）", () => {
    const out = translate([
      { type: "message_update", assistantMessageEvent: { type: "thinking_end" } },
    ]);
    assert.deepEqual(out, [{ type: "reasoning_end", durationMs: 0 }]);
  });

  it("道具の名前は wire 名から論理名へ戻る（決定22・91）", () => {
    const out = translate([
      { type: "tool_execution_start", toolCallId: "t1", toolName: "memory__save", args: { a: 1 } },
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "memory__save",
        result: { ok: true },
        isError: false,
      },
    ]);
    assert.deepEqual(out[0], {
      type: "tool_start",
      toolCallId: "t1",
      name: "memory.save",
      input: { a: 1 },
    });
    assert.deepEqual(out[1], {
      type: "tool_end",
      toolCallId: "t1",
      name: "memory.save",
      isError: false,
      output: { ok: true },
    });
  });

  it("名前空間規則に従わない名前（pi 組み込み等）はそのまま通す", () => {
    const out = translate([
      { type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} },
    ]);
    assert.ok(out[0]?.type === "tool_start" && out[0].name === "read");
  });

  it("ターンの終わりは入力＋キャッシュ＋出力を合算する", () => {
    const out = translate([
      {
        type: "turn_end",
        message: {
          role: "assistant",
          usage: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 0 },
        },
      },
    ]);
    assert.deepEqual(out, [{ type: "turn_end", contextTokens: 2000 }]);
  });

  it("使用量が取れないターンは量を名乗らない（0 と偽らない・I1）", () => {
    const out = translate([{ type: "turn_end", message: { role: "assistant" } }]);
    assert.deepEqual(out, [{ type: "turn_end" }]);
  });

  it("**agent_end は run_end。turn_end と畳まない**（章の判定が二重に走る）", () => {
    const out = translate([{ type: "turn_end" }, { type: "agent_end" }]);
    assert.deepEqual(
      out.map((e) => e.type),
      ["turn_end", "run_end"],
      "1ターンにつき run_end はちょうど1回"
    );
  });

  it("まとめ直しは知らせになる（黙って話が削られない）", () => {
    const out = translate([
      {
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        result: { tokensBefore: 180000 },
      },
    ]);
    assert.equal(out.length, 1);
    assert.ok(out[0]?.type === "notice" && out[0].source === "system");
    assert.match(out[0].text, /まとめ直しました/);
    assert.match(out[0].text, /180,000/, "どれだけの量をまとめたか出す");
  });

  it("中断は知らせない／失敗は知らせる（I2）", () => {
    assert.deepEqual(translate([{ type: "compaction_end", aborted: true }]), []);
    const failed = translate([
      { type: "compaction_end", aborted: false, errorMessage: "要約に失敗" },
    ]);
    assert.ok(failed[0]?.type === "notice");
    assert.match(failed[0].text, /まとめ直しに失敗しました：要約に失敗/);
  });

  it("知らない出来事は黙って捨てる（番頭の語彙に無いものは流さない）", () => {
    assert.deepEqual(translate([{ type: "something_else" }, null, undefined]), []);
  });

  it("**会話の口の皮を pi の内部として渡したら、その場で落ちる（I2）**", () => {
    // 実機で踏んだ形：`withEmptyResponseGuard` の戻り値は HostSession の口しか持たず、
    // `agent` / `sessionManager` / `setAutoCompactionEnabled` を通さない。以前は
    // 章を閉じる段（＝会話を開き直す段）で初めて落ち、**全会話が開けなくなった**
    const facade = {
      sessionId: "s-1",
      isStreaming: false,
      subscribe: () => () => {},
      async prompt(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    assert.throws(
      () =>
        new PiHarness({
          session: facade,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 皮を誤って渡す再現
          agentSession: facade as any,
          toLogicalName: (n: string) => n,
          renderTranscript,
        } as never),
      /pi の内部がありません/
    );
  });

  it("ハーネスを組んだ時点で自動コンパクションが切れる（決定89）", () => {
    let disabled: boolean | undefined;
    const session = {
      ...fakePiSession(),
      setAutoCompactionEnabled(v: boolean) {
        disabled = v;
      },
    };
    harnessWith(session as ReturnType<typeof fakePiSession>);
    assert.equal(disabled, false, "章の境界は番頭が持つ——契約の前提として生成時に切る");
  });
});
