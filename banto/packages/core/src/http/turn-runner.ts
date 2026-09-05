// Thread に対する1ターンを実際に走らせ、SSEで配信できる形にまとめる。
// canUseTool・onElicitationはInboxへ判断待ちとして記録し、発生した時点で
// 即座にSSEへも流す（アーキ仕様§2.4「人に聞くはElicitationに乗せる」・
// §6.0 hold-the-line）——ターンが終わってからまとめて返すのではない。

import { runTurn } from "../runner/adapter.js";
import { assertRelayHealthy } from "../relay/health.js";
import { createMemoryMcpServer, MEMORY_SYSTEM_PROMPT_APPEND } from "./memory-tool.js";
import type { InboxStore } from "../inbox/store.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Runnerが`/agent-relay/<name>`へ実HTTPで繋ぐための宛先1件。 */
export interface ModuleEndpoint {
  name: string;
  url: string;
  /** /agent-relayの認証ヘッダ（bootstrap.authTokenのbearer）。 */
  headers?: Record<string, string>;
}

export type TurnStreamEvent =
  | { type: "message"; message: unknown }
  | {
      type: "judgment";
      judgmentId: string;
      kind: "approval" | "elicitation";
      toolName?: string;
      message: string;
    }
  | { type: "done"; sessionId?: string; contextUsage?: unknown; compactionCount: number }
  | { type: "error"; message: string };

export interface RunThreadTurnInput {
  threadId: string;
  prompt: string;
  modules: ModuleEndpoint[];
  cwd?: string;
  permissionMode?: Options["permissionMode"];
}

export async function* runThreadTurn(
  deps: { projectThread: ProjectThreadStore; inbox: InboxStore; pendingApprovals: PendingApprovalRegistry },
  input: RunThreadTurnInput,
): AsyncGenerator<TurnStreamEvent> {
  const thread = deps.projectThread.getThread(input.threadId);
  if (!thread) {
    yield { type: "error", message: `thread ${input.threadId} not found` };
    return;
  }

  await deps.projectThread.appendMessage(input.threadId, "user", input.prompt);

  const mcpServers: Record<string, unknown> = {};
  for (const m of input.modules) mcpServers[m.name] = { type: "http", url: m.url, headers: m.headers };
  mcpServers["banto-memory"] = createMemoryMcpServer(deps.projectThread, input.threadId);

  const messages: unknown[] = [];
  let sessionId: string | undefined;
  let contextUsage: unknown;
  let compactionCount = 0;
  try {
    const gen = runTurn({
      resumeSessionId: thread.resumePoint,
      prompt: input.prompt,
      mcpServers: mcpServers as Options["mcpServers"],
      permissionMode: input.permissionMode,
      cwd: input.cwd,
      systemPromptAppend: MEMORY_SYSTEM_PROMPT_APPEND,
    });

    let next = await gen.next();
    while (!next.done) {
      const event = next.value;
      if (event.type === "message") {
        messages.push(event.message);
        yield { type: "message", message: event.message };
      } else if (event.type === "approval_requested") {
        const judgment = await deps.inbox.raiseJudgment({
          threadId: input.threadId,
          source: "text",
          message: `tool呼び出しの承認: ${event.pending.toolName}`,
          toolCallId: event.pending.toolCallId,
        });
        deps.pendingApprovals.register(judgment.id, event.pending.resolve);
        yield {
          type: "judgment",
          judgmentId: judgment.id,
          kind: "approval",
          toolName: event.pending.toolName,
          message: judgment.message,
        };
      } else if (event.type === "elicitation_requested") {
        const judgment = await deps.inbox.raiseJudgment({
          threadId: input.threadId,
          source: "elicitation",
          message: event.pending.message,
          mode: event.pending.mode,
          requestedSchema: event.pending.requestedSchema,
          url: event.pending.url,
        });
        yield { type: "judgment", judgmentId: judgment.id, kind: "elicitation", message: judgment.message };
      }
      next = await gen.next();
    }
    const result = next.value;
    sessionId = result.sessionId;
    contextUsage = result.contextUsage;
    compactionCount = result.compactionCount;
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  try {
    assertRelayHealthy(
      messages as Parameters<typeof assertRelayHealthy>[0],
      input.modules.map((m) => m.name),
    );
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (sessionId) {
    await deps.projectThread.updateResumePoint(input.threadId, sessionId);
  }
  const assistantText = extractAssistantText(messages);
  if (assistantText) {
    await deps.projectThread.appendMessage(input.threadId, "assistant", assistantText);
  }
  await deps.projectThread.recordUsage(input.threadId, contextUsage, compactionCount);
  yield { type: "done", sessionId, contextUsage, compactionCount };
}

/** リロード時の表示復元用に、assistantのテキスト応答だけを抜き出す
 *  （決定・2026-09-04）。tool_use等SDKの内部詳細は持たない——表示に要るのは
 *  発言テキストだけ（docs/notes参照）。 */
function extractAssistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const m = raw as { type?: string; message?: { content?: unknown } };
    if (m.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n");
}
