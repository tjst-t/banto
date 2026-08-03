/**
 * 空応答ガード（imp-0016 再発防止）のユニットテスト。
 *
 * 実プロバイダを呼ばずに、判定の純関数と、偽セッションに対する再試行の振る舞いを
 * 検証する。判定ロジックが turn-guard.ts の純関数に分離されているから、ここでは
 * pi も LLM も起動しない。
 *
 * 偽セッション（FakeGuardedSession）は GuardableSession 契約だけを実装し、prompt() /
 * continue() のたびにあらかじめ仕込んだ turn_end イベントを流す。pi の agent-loop と
 * 同じく、assistant message とツール結果を state.messages へ積む。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_RESPONSE_MAX_RETRIES,
  findLastEmptyAssistantIndex,
  isEmptyResponse,
  isRetryableEmptyResponse,
  resumeInterruptedTurn,
  withEmptyResponseGuard,
  type GuardableSession,
} from "@banto/host";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, StopReason, ToolResultMessage } from "@mariozechner/pi-ai";

/** テスト用の AssistantMessage。判定で使わないフィールド（api/provider/usage 等）は省略する。 */
function assistantMessage(content: AssistantMessage["content"], stopReason: StopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content,
    stopReason,
  } as AssistantMessage;
}

function toolResultMessage(id: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "kobo.query.ready",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
  };
}

/** 1回のターン（turn_end）の仕様。 */
interface TurnEndSpec {
  /** このターンで実行されたツール結果の数（0 ならツール実行なし） */
  toolResults: number;
  /** このターンの assistant メッセージ */
  message: AssistantMessage;
}

/** GuardableSession を満たす偽セッション。 */
class FakeGuardedSession implements GuardableSession {
  readonly sessionId = "test-guarded";
  isStreaming = false;
  promptCalls = 0;
  continueCalls = 0;
  prompts: string[] = [];
  /** prompt() のたびに消費される turn_end の列 */
  promptTurns: TurnEndSpec[][] = [];
  /** continue() のたびに消費される turn_end の列 */
  continueTurns: TurnEndSpec[][] = [];
  private listeners = new Set<(event: unknown) => void>();

  readonly agent = {
    state: {
      messages: [] as AgentMessage[],
    },
    continue: async (): Promise<void> => {
      this.continueCalls += 1;
      for (const turn of this.continueTurns.shift() ?? []) this.emitTurnEnd(turn);
    },
  };

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls += 1;
    this.prompts.push(text);
    for (const turn of this.promptTurns.shift() ?? []) this.emitTurnEnd(turn);
  }

  async abort(): Promise<void> {}

  /** turn_end を流し、pi と同じく assistant とツール結果を state.messages へ積む。 */
  emitTurnEnd(spec: TurnEndSpec): void {
    this.agent.state.messages.push(spec.message);
    for (let i = 0; i < spec.toolResults; i++) {
      this.agent.state.messages.push(toolResultMessage(`call-${i}`));
    }
    const toolResults = spec.toolResults > 0 ? [toolResultMessage("call-0")] : [];
    for (const listener of this.listeners) {
      listener({ type: "turn_end", message: spec.message, toolResults });
    }
  }
}

describe("turn-guard: 空応答の判定（純関数）", () => {
  it("isEmptyResponse: text があれば空ではない", () => {
    assert.equal(isEmptyResponse(assistantMessage([{ type: "text", text: "こんにちは" }])), false);
  });

  it("isEmptyResponse: toolCall があれば空ではない", () => {
    assert.equal(
      isEmptyResponse(assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }])),
      false
    );
  });

  it("isEmptyResponse: content が空なら空", () => {
    assert.equal(isEmptyResponse(assistantMessage([])), true);
  });

  it("isEmptyResponse: thinking のみは空（imp-0016 の思考フォーマット）", () => {
    assert.equal(isEmptyResponse(assistantMessage([{ type: "thinking", thinking: "…" }])), true);
  });

  it("isEmptyResponse: thinking と text が混在していれば空ではない", () => {
    assert.equal(
      isEmptyResponse(assistantMessage([{ type: "thinking", thinking: "…" }, { type: "text", text: "答" }])),
      false
    );
  });

  it("isRetryableEmptyResponse: 3条件すべて成立で true", () => {
    assert.equal(isRetryableEmptyResponse(true, assistantMessage([], "stop")), true);
  });

  it("isRetryableEmptyResponse: ツール実行が無ければ再試行しない（条件1）", () => {
    assert.equal(isRetryableEmptyResponse(false, assistantMessage([], "stop")), false);
  });

  it("isRetryableEmptyResponse: stopReason が error なら再試行しない（条件3）", () => {
    assert.equal(isRetryableEmptyResponse(true, assistantMessage([], "error")), false);
  });

  it("isRetryableEmptyResponse: stopReason が aborted なら再試行しない（条件3）", () => {
    assert.equal(isRetryableEmptyResponse(true, assistantMessage([], "aborted")), false);
  });

  it("isRetryableEmptyResponse: stopReason が length なら再試行しない（条件3）", () => {
    assert.equal(isRetryableEmptyResponse(true, assistantMessage([], "length")), false);
  });

  it("isRetryableEmptyResponse: text があれば再試行しない（条件2）", () => {
    assert.equal(isRetryableEmptyResponse(true, assistantMessage([{ type: "text", text: "答" }])), false);
  });

  it("isRetryableEmptyResponse: toolCall があれば再試行しない（条件2）", () => {
    assert.equal(
      isRetryableEmptyResponse(true, assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }])),
      false
    );
  });

  it("findLastEmptyAssistantIndex: 末尾の空 assistant を見つける", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "調べて", timestamp: 0 },
      assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]),
      toolResultMessage("c1"),
      assistantMessage([]),
    ];
    assert.equal(findLastEmptyAssistantIndex(messages), 3);
  });

  it("findLastEmptyAssistantIndex: 末尾の assistant が空でなければ -1", () => {
    const messages: AgentMessage[] = [assistantMessage([{ type: "text", text: "答" }])];
    assert.equal(findLastEmptyAssistantIndex(messages), -1);
  });

  it("findLastEmptyAssistantIndex: 空配列は -1", () => {
    assert.equal(findLastEmptyAssistantIndex([]), -1);
  });

  it("findLastEmptyAssistantIndex: thinking のみの assistant は空として見つける", () => {
    const messages: AgentMessage[] = [
      assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]),
      toolResultMessage("c1"),
      assistantMessage([{ type: "thinking", thinking: "…" }]),
    ];
    assert.equal(findLastEmptyAssistantIndex(messages), 2);
  });
});

describe("turn-guard: 再試行（withEmptyResponseGuard）", () => {
  it("正常応答（ツールなし）なら prompt 1回で終わり、再試行しない", async () => {
    const session = new FakeGuardedSession();
    session.promptTurns = [[{ toolResults: 0, message: assistantMessage([{ type: "text", text: "答え" }]) }]];
    const guarded = withEmptyResponseGuard(session);

    await guarded.prompt("在庫を確認して");

    assert.equal(session.promptCalls, 1);
    assert.equal(session.continueCalls, 0);
  });

  it("ツール実行 → 空応答 → 再試行で続きが生成される（continue が 1 回）", async () => {
    const session = new FakeGuardedSession();
    session.promptTurns = [
      [
        { toolResults: 1, message: assistantMessage([{ type: "toolCall", id: "c1", name: "git.status", arguments: {} }]) },
        { toolResults: 0, message: assistantMessage([]) }, // 空応答（imp-0016）
      ],
    ];
    session.continueTurns = [
      [{ toolResults: 0, message: assistantMessage([{ type: "text", text: "確認しました" }]) }],
    ];
    const guarded = withEmptyResponseGuard(session);

    await guarded.prompt("検証して");

    assert.equal(session.promptCalls, 1, "ユーザー発話は 1 回だけ（2 回目は continue で続ける）");
    assert.equal(session.continueCalls, 1);
    // 空応答は履歴から除かれ、最後は正常な応答になる（continue() が動ける形）
    const last = session.agent.state.messages[session.agent.state.messages.length - 1];
    assert.ok(last.role === "assistant" && last.content.some((c) => c.type === "text"));
  });

  it("ツール実行なしの空応答は再試行しない（条件1）", async () => {
    const session = new FakeGuardedSession();
    session.promptTurns = [[{ toolResults: 0, message: assistantMessage([]) }]];
    const guarded = withEmptyResponseGuard(session);

    await guarded.prompt("こんにちは");

    assert.equal(session.promptCalls, 1);
    assert.equal(session.continueCalls, 0);
  });

  it("stopReason error の空応答は再試行しない（条件3）", async () => {
    const session = new FakeGuardedSession();
    session.promptTurns = [
      [
        { toolResults: 1, message: assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]) },
        { toolResults: 0, message: assistantMessage([], "error") },
      ],
    ];
    const guarded = withEmptyResponseGuard(session);

    await guarded.prompt("読んで");

    assert.equal(session.promptCalls, 1);
    assert.equal(session.continueCalls, 0);
  });

  it("再試行が 2 回必要な場合も続く", async () => {
    const session = new FakeGuardedSession();
    session.promptTurns = [
      [
        { toolResults: 1, message: assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]) },
        { toolResults: 0, message: assistantMessage([]) },
      ],
    ];
    session.continueTurns = [
      [{ toolResults: 0, message: assistantMessage([]) }], // 1回目も空
      [{ toolResults: 0, message: assistantMessage([{ type: "text", text: "ようやく答え" }]) }], // 2回目で成功
    ];
    const guarded = withEmptyResponseGuard(session);

    await guarded.prompt("続けて");

    assert.equal(session.continueCalls, 2);
  });

  it("上限（EMPTY_RESPONSE_MAX_RETRIES）を超えたらエラーとして打ち切る（I2）", async () => {
    const session = new FakeGuardedSession();
    session.promptTurns = [
      [
        { toolResults: 1, message: assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]) },
        { toolResults: 0, message: assistantMessage([]) },
      ],
    ];
    // 再試行しても全部空
    session.continueTurns = Array.from({ length: EMPTY_RESPONSE_MAX_RETRIES }, () => [
      { toolResults: 0, message: assistantMessage([]) },
    ]);
    const guarded = withEmptyResponseGuard(session);

    await assert.rejects(guarded.prompt("止まらないで"), (err: unknown) => {
      assert.match(String(err), /空/);
      assert.match(String(err), /打ち切り/);
      return true;
    });
    assert.equal(session.continueCalls, EMPTY_RESPONSE_MAX_RETRIES);
  });

  it("subscribe と abort は素通しする（HostSession 契約を保つ）", async () => {
    const session = new FakeGuardedSession();
    const guarded = withEmptyResponseGuard(session);
    const types: string[] = [];
    guarded.subscribe((e) => {
      const t = (e as { type?: string }).type;
      if (t) types.push(t);
    });

    session.emitTurnEnd({ toolResults: 0, message: assistantMessage([{ type: "text", text: "こんにちは" }]) });
    assert.deepEqual(types, ["turn_end"]);

    await guarded.abort();
  });
});

// ── imp-0016 主対策: 復元時ターン再開 ──────────────────────────────────────────

describe("turn-guard: 復元時ターン再開（resumeInterruptedTurn）", () => {
  it("最後が toolResult なら continue() で再開し true を返す", async () => {
    const session = new FakeGuardedSession();
    // toolCall assistant → toolResult の順に積む（pi と同じ順序）
    session.agent.state.messages.push(
      assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: {} }]),
      toolResultMessage("c1")
    );

    const resumed = await resumeInterruptedTurn(session);

    assert.equal(resumed, true, "ツール結果で終わっているので再開する");
    assert.equal(session.continueCalls, 1, "continue() が呼ばれる");
  });

  it("最後が assistant なら再開せず false を返す（応答生成済み）", async () => {
    const session = new FakeGuardedSession();
    session.agent.state.messages.push(assistantMessage([{ type: "text", text: "答えました" }]));

    const resumed = await resumeInterruptedTurn(session);

    assert.equal(resumed, false, "assistant で終わっているので再開不要");
    assert.equal(session.continueCalls, 0, "continue() は呼ばれない");
  });

  it("最後が user なら再開せず false を返す", async () => {
    const session = new FakeGuardedSession();
    session.agent.state.messages.push({ role: "user", content: "こんにちは", timestamp: 0 });

    const resumed = await resumeInterruptedTurn(session);

    assert.equal(resumed, false, "user で終わっているので再開不要");
    assert.equal(session.continueCalls, 0);
  });

  it("messages が空なら再開せず false を返す", async () => {
    const session = new FakeGuardedSession();
    // messages を空にする
    session.agent.state.messages = [];

    const resumed = await resumeInterruptedTurn(session);

    assert.equal(resumed, false, "履歴が空なので再開不要");
    assert.equal(session.continueCalls, 0);
  });
});
