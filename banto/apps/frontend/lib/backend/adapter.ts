// 実banto hostに繋がるChatModelAdapter。lib/mock/adapter.tsのcreateMockChatModelAdapter
// から、thread.realが立っているときだけ呼ばれる（デモの台本はそのまま、実接続は
// 別経路として追加しただけ——docs/notes/2026-09-03-agent-relay-http-transport.md
// と同じ「仕様は変えない、実装だけ足す」判断）。
//
// assistant-uiのローカルランタイムは「requires-actionでrun()をreturnし、
// addResultの後にrun()を呼び直す」契約（lib/mock/adapter.tsの実測コメント参照）。
// banto hostは逆に「SSE接続を1本開いたまま、答えは/api/inbox/:id/answerという
// 別経路で送る」——この2つを橋渡しするため、Thread単位の生きたSSE接続を
// モジュールレベルに保持し、run()の再呼び出しではそれを読み進めるだけにする。

import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { ReadonlyJSONObject } from "assistant-stream/utils";
import { answerRealInboxItem, streamRealTurn, type RealTurnEvent } from "./client";
import { getThreadPermissionMode } from "../mock/permission-mode";
import { appendRealUsage } from "../mock/threads";
import type { MockThread } from "../mock/types";
import { HUMAN_TOOL_NAME } from "../mock/adapter";

/** 累積parts。lib/mock/adapter.tsのPartsAccumulatorと同じ形——yieldのたびにコピーを返す。 */
class PartsAccumulator {
  private parts: ThreadAssistantMessagePart[] = [];

  appendText(chunk: string) {
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === "text") {
      this.parts[this.parts.length - 1] = { ...last, text: last.text + chunk };
    } else {
      this.parts.push({ type: "text", text: chunk });
    }
  }

  startTool(toolCallId: string, toolName: string, args: unknown) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName,
      args: args as ReadonlyJSONObject,
      argsText: JSON.stringify(args),
    });
  }

  finishTool(toolCallId: string, result: unknown) {
    const idx = this.parts.findIndex((p) => p.type === "tool-call" && p.toolCallId === toolCallId);
    if (idx === -1) return;
    const part = this.parts[idx];
    if (part.type !== "tool-call") return;
    this.parts[idx] = { ...part, result };
  }

  startHumanTool(toolCallId: string, serverName: string, message: string) {
    this.parts.push({
      type: "tool-call",
      toolCallId,
      toolName: HUMAN_TOOL_NAME,
      args: {
        serverName,
        message,
        elicitation: { mode: "form", enumOptions: ["許可する", "拒否する"], allowFreeText: false },
      } as unknown as ReadonlyJSONObject,
      argsText: JSON.stringify({ serverName, message }),
    });
  }

  snapshot(): readonly ThreadAssistantMessagePart[] {
    return [...this.parts];
  }
}

/** toolCallId（judgment-<id>の形）→ 実Inboxのjudgment id。human-tool-card.tsxが答えを送るときに引く。 */
const judgmentIdByToolCallId = new Map<string, string>();

export function getRealJudgmentId(toolCallId: string): string | undefined {
  return judgmentIdByToolCallId.get(toolCallId);
}

interface LiveTurn {
  iterator: AsyncGenerator<RealTurnEvent>;
  acc: PartsAccumulator;
  done: boolean;
}

const liveTurns = new Map<string, LiveTurn>();

function lastUserText(messages: readonly ThreadMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// SDKMessageの中身はbanto core（@anthropic-ai/claude-agent-sdk）の語彙——
// このファイルはUI側なのでその型定義に直接依存せず、必要な形だけ受け取る。
interface AssistantContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface UserContentBlock {
  type: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface RawSdkMessage {
  type: string;
  message?: { content?: unknown };
}

function applyMessage(acc: PartsAccumulator, raw: unknown): void {
  const message = raw as RawSdkMessage;
  if (message.type === "assistant") {
    const content = (message.message?.content ?? []) as AssistantContentBlock[];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        acc.appendText(block.text);
      } else if (block.type === "tool_use" && block.id && block.name) {
        acc.startTool(block.id, block.name, block.input ?? {});
      }
    }
  } else if (message.type === "user") {
    const content = (message.message?.content ?? []) as UserContentBlock[];
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        acc.finishTool(block.tool_use_id, block.is_error ? { error: block.content } : block.content);
      }
    }
  }
}

/** リロード時の会話表示復元用（決定・2026-09-04）。banto hostのThreadState.messages
 *  （発言者＋テキストのみ）をuseLocalRuntimeのinitialMessagesへ変換する。 */
export function realMessagesToInitial(
  messages: MockThread["realMessages"],
): ThreadMessageLike[] {
  if (!messages) return [];
  return messages.map((m) => ({
    id: `real-${m.seq}`,
    role: m.role,
    content: [{ type: "text", text: m.text }],
  }));
}

export function createRealChatModelAdapter(thread: MockThread): ChatModelAdapter {
  return {
    async *run({ messages, unstable_getMessage }) {
      let live = liveTurns.get(thread.id);

      if (!live || live.done) {
        // 新規送信——現在進行中のライブなSSE接続が無ければ、実際にターンを開始する。
        const prompt = lastUserText(messages);
        const permissionMode = getThreadPermissionMode(thread.id, thread.projectId);
        live = {
          iterator: streamRealTurn(thread.id, prompt, permissionMode === "auto" ? undefined : permissionMode),
          acc: new PartsAccumulator(),
          done: false,
        };
        liveTurns.set(thread.id, live);
      } else {
        // requires-actionからの再開——既存のacc（今まで届いた分）をそのまま引き継ぐ。
        // addResultで人が答えたぶんは、既に/api/inbox/:id/answer経由でhost側に届いている
        // （human-tool-card.tsxのonAnswered）ので、ここでは同じ接続を読み進めるだけでよい。
        void unstable_getMessage; // mockのように既存partsを付け直す必要は無い（accが真実）
      }

      for await (const event of live.iterator) {
        if (event.type === "message") {
          applyMessage(live.acc, event.message);
          yield { content: live.acc.snapshot() };
        } else if (event.type === "judgment") {
          const toolCallId = `judgment-${event.judgmentId}`;
          judgmentIdByToolCallId.set(toolCallId, event.judgmentId);
          live.acc.startHumanTool(toolCallId, event.toolName ?? "banto", event.message);
          yield { content: live.acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
          return;
        } else if (event.type === "error") {
          live.done = true;
          live.acc.appendText(`\n\nエラー: ${event.message}`);
          yield { content: live.acc.snapshot() };
          return;
        } else if (event.type === "done") {
          live.done = true;
          appendRealUsage(thread.id, event.contextUsage, event.compactionCount);
        }
      }

      yield { content: live.acc.snapshot() };
    },
  };
}

/** 承認/Elicitationの答えを実hostへ送る。human-tool-card.tsxのonAnsweredから呼ぶ。 */
export async function sendRealAnswer(toolCallId: string, answer: string): Promise<boolean> {
  const judgmentId = judgmentIdByToolCallId.get(toolCallId);
  if (!judgmentId) return false;
  const permissionResult =
    answer === "許可する" ? { behavior: "allow" as const } : { behavior: "deny" as const, message: answer };
  await answerRealInboxItem(judgmentId, permissionResult);
  return true;
}
