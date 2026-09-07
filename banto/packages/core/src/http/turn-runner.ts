// Thread に対する1ターンを実際に走らせ、SSEで配信できる形にまとめる。
// canUseTool・onElicitationはInboxへ判断待ちとして記録し、発生した時点で
// 即座にSSEへも流す（アーキ仕様§2.4「人に聞くはElicitationに乗せる」・
// §6.0 hold-the-line）——ターンが終わってからまとめて返すのではない。

import type { UiToolCallEntry } from "../project-thread/types.js";
import { runTurn } from "../runner/adapter.js";
import { buildSystemPrompt } from "../runner/system-prompt.js";
import { buildTurnContext } from "../runner/turn-context.js";
import { splitMemory } from "../project-thread/memory-split.js";
import { assertRelayHealthy } from "../relay/health.js";
import { createMemoryMcpServer } from "./memory-tool.js";
import type { GlobalMemoryStore } from "../global-memory/store.js";
import type { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
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
      /** 承認する tool の引数（approvalのみ）。何を承認するのかを画面に出すため。 */
      toolInput?: unknown;
      /** 発信元の Module 名（elicitationのみ、§2.4.1 の MUST）。 */
      serverName?: string;
      kind: "approval" | "elicitation";
      toolName?: string;
      message: string;
    }
  | {
      type: "done";
      sessionId?: string;
      contextUsage?: unknown;
      compactionCount: number;
      /** そのターンの入出力とキャッシュの内訳（決定・2026-09-06） */
      apiUsage?: unknown;
    }
  | { type: "error"; message: string };

/** 画面を持つ tool（`_meta.ui.resourceUri`）の対応表。表示の復元に使う。 */
export interface UiToolBinding {
  /** Runner から見える名前（`mcp__<Module名>__<tool名>`）。 */
  toolName: string;
  server: string;
  resourceUri: string;
}

export interface RunThreadTurnInput {
  threadId: string;
  prompt: string;
  modules: ModuleEndpoint[];
  cwd?: string;
  permissionMode?: Options["permissionMode"];
  /** 画面つき tool の一覧（決定・2026-09-07）。**これに載っている呼び出しだけ**を
   *  記録する——記録の目的は Module の画面をリロード後に出し直すことなので、
   *  画面を持たない tool の結果まで残す理由が無い（会話の記録を膨らませない）。 */
  uiTools?: UiToolBinding[];
}

export async function* runThreadTurn(
  deps: {
    projectThread: ProjectThreadStore;
    globalMemory: GlobalMemoryStore;
    inbox: InboxStore;
    pendingApprovals: PendingApprovalRegistry;
  },
  input: RunThreadTurnInput,
): AsyncGenerator<TurnStreamEvent> {
  const thread = deps.projectThread.getThread(input.threadId);
  if (!thread) {
    yield { type: "error", message: `thread ${input.threadId} not found` };
    return;
  }
  const project = deps.projectThread.getProject(thread.projectId);
  if (!project) {
    // Threadがあって Project が無いのは fold の不整合——黙って既定値で
    // 走らせない（規則2）。system prompt の層3が組めない。
    yield { type: "error", message: `project ${thread.projectId} not found for thread ${input.threadId}` };
    return;
  }

  await deps.projectThread.appendMessage(input.threadId, "user", input.prompt);

  const mcpServers: Record<string, unknown> = {};
  for (const m of input.modules) mcpServers[m.name] = { type: "http", url: m.url, headers: m.headers };
  mcpServers["banto-memory"] = createMemoryMcpServer(deps.projectThread, thread.projectId, input.threadId);

  // system promptに入れるのは確定した分、ターンに添えるのはそれ以降の分
  // （§2.3、決定・2026-09-05）。Project MemoryもGlobal Memoryも同じ規律・
  // 同じ物差し（Event Storeのseq）なので、分け方の判断はsplitMemoryに1つだけ置く。
  const memory = deps.projectThread.memoryForThread(input.threadId);
  const global_ = splitMemory(
    deps.globalMemory.list(),
    thread.memoryBaselineSeq,
    thread.memoryDeliveredSeq,
  );
  const turnContext = buildTurnContext({
    thread,
    pendingMemory: [...memory.pending, ...global_.pending].sort((a, b) => a.changedAtSeq - b.changedAtSeq),
    openJudgments: deps.inbox
      .listOpen()
      .filter((i): i is JudgmentItem => i.kind === "judgment" && i.threadId === input.threadId),
    startedAt: new Date(),
  });
  const deliveredUpToSeq = [...memory.pending, ...global_.pending].reduce(
    (max, m) => Math.max(max, m.changedAtSeq),
    0,
  );

  const messages: unknown[] = [];
  let sessionId: string | undefined;
  let contextUsage: unknown;
  let compactionCount = 0;
  let apiUsage: unknown;
  let deliveryRecorded = false;
  try {
    const gen = runTurn({
      resumeSessionId: thread.resumePoint,
      // 親から借りたresume-pointのままなら、このターンで枝を分ける（§2.2）
      // ——分けないと親と同じセッションを共有し、会話が1本に混ざる。
      // 既に共有されてしまっているもの（2026-09-05以前に作られたFork）も、
      // ここで検知して分ける——黙って壊れたまま続けない（規則2）。
      forkSession:
        thread.resumePoint !== undefined &&
        (!thread.ownsSession || deps.projectThread.resumePointSharedWithOtherThread(input.threadId)),
      prompt: `${turnContext}\n\n${input.prompt}`,
      mcpServers: mcpServers as Options["mcpServers"],
      permissionMode: input.permissionMode,
      cwd: input.cwd,
      // system promptに入れるのはThread作成時に確定した分だけ（§2.3）。
      // 確定より後に増えた分は先頭を変えずにターンへ添える（Cで実装）。
      systemPrompt: buildSystemPrompt({
        globalMemory: global_.established.filter((m) => !m.invalidated).map((m) => m.text),
        project: { name: project.name, root: project.root },
        memory: memory.established,
      }),
    });

    let next = await gen.next();
    while (!next.done) {
      const event = next.value;
      if (event.type === "message") {
        // 最初のメッセージが返ってきた＝添えたブロックがモデルに届いた。
        // ここで初めて「届けた」を記録する——組み立てた時点で記録すると、
        // プロセスが起動できなかったときに届いていない差分を失う（規則2）。
        if (!deliveryRecorded && deliveredUpToSeq > 0) {
          deliveryRecorded = true;
          await deps.projectThread.markMemoryDelivered(input.threadId, deliveredUpToSeq);
        }
        messages.push(event.message);
        yield { type: "message", message: event.message };
      } else if (event.type === "approval_requested") {
        const judgment = await deps.inbox.raiseJudgment({
          threadId: input.threadId,
          source: "text",
          message: `tool呼び出しの承認: ${event.pending.toolName}`,
          toolCallId: event.pending.toolCallId,
          // **何を承認するのか**を一緒に残す（決定・2026-09-06、見直し起点）。
          // 引数を見せずに承認させると、runCommand を中身を見ないまま
          // 許可することになる（§6.0「サーバを呼ぶ前に人に見せる」）
          toolInput: event.pending.input,
        });
        deps.pendingApprovals.register(judgment.id, event.pending.resolve);
        yield {
          type: "judgment",
          judgmentId: judgment.id,
          kind: "approval",
          toolName: event.pending.toolName,
          toolInput: event.pending.input,
          message: judgment.message,
        };
      } else if (event.type === "elicitation_requested") {
        const judgment = await deps.inbox.raiseJudgment({
          threadId: input.threadId,
          source: "elicitation",
          message: event.pending.message,
          // どのサーバが聞いているか（§2.4.1 の MUST）
          serverName: event.pending.serverName,
          mode: event.pending.mode,
          requestedSchema: event.pending.requestedSchema,
          url: event.pending.url,
        });
        yield {
          type: "judgment",
          judgmentId: judgment.id,
          kind: "elicitation",
          serverName: event.pending.serverName,
          message: judgment.message,
        };
      }
      next = await gen.next();
    }
    const result = next.value;
    sessionId = result.sessionId;
    contextUsage = result.contextUsage;
    compactionCount = result.compactionCount;
    apiUsage = result.apiUsage;
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
  const uiToolCalls = extractUiToolCalls(messages, input.uiTools ?? []);
  if (assistantText || uiToolCalls.length > 0) {
    await deps.projectThread.appendMessage(input.threadId, "assistant", assistantText, uiToolCalls);
  }
  await deps.projectThread.recordUsage(input.threadId, contextUsage, compactionCount, apiUsage);
  yield { type: "done", sessionId, contextUsage, compactionCount, apiUsage };
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


/**
 * そのターンで呼ばれた**画面つきの tool**を拾う（決定・2026-09-07、ユーザー報告）。
 *
 * リロードすると会話は host の記録から組み直される。記録が文章だけだと
 * **Module の画面が消える**（tool のカードごと失われる）ので、画面を出すのに
 * 要る分——どの tool を、どの引数で呼んで、何が返ったか——を残す。
 * **画面を持つ tool だけ**が対象。
 */
function extractUiToolCalls(messages: unknown[], uiTools: UiToolBinding[]): UiToolCallEntry[] {
  if (uiTools.length === 0) return [];
  const byToolName = new Map(uiTools.map((t) => [t.toolName, t]));
  const calls = new Map<string, UiToolCallEntry>();

  for (const raw of messages) {
    const message = raw as {
      type?: string;
      message?: { content?: unknown };
    };
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;

    if (message.type === "assistant") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : undefined;
        const id = typeof block.id === "string" ? block.id : undefined;
        const binding = name ? byToolName.get(name) : undefined;
        if (!id || !name || !binding) continue;
        calls.set(id, {
          toolCallId: id,
          toolName: name,
          server: binding.server,
          resourceUri: binding.resourceUri,
          args: block.input,
        });
      }
    } else if (message.type === "user") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result") continue;
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const call = id ? calls.get(id) : undefined;
        if (!call) continue;
        call.result = block.is_error ? { error: block.content } : block.content;
      }
    }
  }
  return [...calls.values()];
}
