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
import type { TurnEventBus } from "./turn-events.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSkillSet } from "../skills/types.js";

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
  /** AI 自身に伝える、いま動いているモデル（決定・2026-09-24）。分からなければ無い */
  modelIdentity?: { name: string; id: string };
  /** 画面つき tool の一覧（決定・2026-09-07）。**これに載っている呼び出しだけ**を
   *  記録する——記録の目的は Module の画面をリロード後に出し直すことなので、
   *  画面を持たない tool の結果まで残す理由が無い（会話の記録を膨らませない）。 */
  uiTools?: UiToolBinding[];
}

/**
 * 1ターンを走らせ、イベントを流す。**流したものは `turnEvents` にも覚えさせる**
 * （`turn-stream-reattach`、2026-09-10）——走行中にリロードされても
 * `GET /api/threads/:id/stream` から**最初から流し直せる**ようにするため。
 * 覚えるのはここ1箇所（規則3——各 yield の場所に書き足さない）。
 */
export async function* runThreadTurn(
  deps: Parameters<typeof runThreadTurnInner>[0],
  input: RunThreadTurnInput,
): AsyncGenerator<TurnStreamEvent> {
  deps.turnEvents?.begin(input.threadId, new Date().toISOString());
  try {
    for await (const event of runThreadTurnInner(deps, input)) {
      deps.turnEvents?.record(input.threadId, event);
      yield event;
    }
  } finally {
    // **どう終わってもここを通る**——終わったターンの途中経過は残さない
    deps.turnEvents?.end(input.threadId);
  }
}

async function* runThreadTurnInner(
  deps: {
    projectThread: ProjectThreadStore;
    globalMemory: GlobalMemoryStore;
    inbox: InboxStore;
    pendingApprovals: PendingApprovalRegistry;
    /** ターンの外（host の中継ゲート等）で起きた判断待ちの流し込み口。 */
    turnEvents?: TurnEventBus;
    /** Runner の差し替え口（試験用）。本番は既定の `runTurn`。 */
    runTurn?: typeof runTurn;
    /**
     * **新しいセッションで効かせる Skill の集合を決める**（決定・2026-09-23、§5.7）。
     * 繋がっている Module が配っている Skill を集め、設定で絞る（cli.ts）。
     * 渡されなければ Skill は1つも効かせない。
     */
    resolveSessionSkills?(threadId: string): Promise<SessionSkillSet>;
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

  // **効かせる Skill は、新しいセッションの最初のターンで決まる**（決定・2026-09-23、§5.7）。
  // `instructions` は `resume` では読み直されない（実測）——続きのターンで決め直しても
  // モデルには届かず、記録だけが嘘になる。**resume しないターン**（新しい会話・Clear の
  // 後）だけがここを通り、決めたものを会話に刻む。代理サーバはその記録から
  // `instructions` を作る（cli.ts の `instructionsFor`）ので、**刻むのは走らせる前**。
  // Fork は親の記録を引き継いでいる（fold）——Fork も resume なので、ここは通らない。
  // 刻むのは人の発言より前——「その発言の時点で何が効いていたか」が seq の順で引ける
  if (thread.resumePoint === undefined && deps.resolveSessionSkills) {
    try {
      const set = await deps.resolveSessionSkills(input.threadId);
      for (const p of set.problems) console.warn(`[host] Skill（${p.module}）: ${p.message}`);
      await deps.projectThread.fixSessionSkills(input.threadId, set);
    } catch (err) {
      // **決められないまま走らせない**（規則2）——黙って「何も効かせない」会話を始めると、
      // その会話のあいだずっと効かないまま、誰も気づけない
      yield {
        type: "error",
        message: `効かせる Skill を決められませんでした: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
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

  // **ターンの外から来る判断待ち**（host の中継ゲート、docs/specs/v4-frontend.md
  // 「Module 間中継の承認」）。SDK の出力を待っている最中に割り込むので、
  // 溜めておいて、下のループで SDK の続きと**どちらが先に来ても**流せるようにする。
  const sideEvents: TurnStreamEvent[] = [];
  let wakeSide: (() => void) | undefined;
  // 健全性検査で中断するときに、走り出した query を止めるための紐
  const abortTurn = new AbortController();
  const unsubscribeSide = deps.turnEvents?.subscribeSide(input.threadId, (event) => {
    sideEvents.push(event);
    wakeSide?.();
  });
  try {
    const gen = (deps.runTurn ?? runTurn)({
      signal: abortTurn.signal,
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
      // 人がこの Thread で選んだモデルと effort（決定・2026-09-23）。host が持つ値を
      // そのまま渡す——選んでいなければ渡さず、CLI の既定で走る
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.effort ? { effort: thread.effort } : {}),
      cwd: input.cwd,
      // system promptに入れるのはThread作成時に確定した分だけ（§2.3）。
      // 確定より後に増えた分は先頭を変えずにターンへ添える（Cで実装）。
      systemPrompt: buildSystemPrompt({
        globalMemory: global_.established.filter((m) => !m.invalidated).map((m) => m.text),
        project: { name: project.name, root: project.root },
        memory: memory.established,
        ...(input.modelIdentity ? { model: input.modelIdentity } : {}),
      }),
    });

    type Step = Awaited<ReturnType<typeof gen.next>>;
    // **1回の gen.next() を包むのは1回だけ**——race のたびに `.then` で
    // 包み直すと、負けた側の派生 Promise が誰にも読まれない rejection になる
    const settle = (p: Promise<Step>): Promise<{ step: Step } | { error: unknown }> =>
      p.then(
        (step) => ({ step }),
        (error: unknown) => ({ error }),
      );

    let pending = settle(gen.next());
    let sideSignal: Promise<"side"> | undefined;
    let result!: Extract<Step, { done: true }>["value"];
    for (;;) {
      if (sideEvents.length > 0) {
        yield sideEvents.shift()!;
        continue;
      }
      if (!sideSignal) {
        sideSignal = new Promise<"side">((resolve) => {
          wakeSide = () => {
            wakeSide = undefined;
            resolve("side");
          };
        });
      }
      const winner = await Promise.race([pending, sideSignal]);
      if (winner === "side") {
        sideSignal = undefined;
        continue;
      }
      if ("error" in winner) throw winner.error;
      const next = winner.step;
      if (next.done) {
        result = next.value;
        break;
      }

      const event = next.value;
      if (event.type === "message") {
        // **道具が繋がっているかは、最初に届く `system/init` で分かる**
        // （改訂・2026-09-10）。以前はターンが**終わってから**見ていたので、
        // AI は道具なしで最後まで走り、それらしい返事を書き、resume-point まで
        // 更新されていた——「守れていないのに動く」（規則2）。
        // ここで止める：記録も残さず、人には理由を返す
        const initError = relayHealthError(event.message, input.modules.map((m) => m.name));
        if (initError) {
          abortTurn.abort();
          await gen.return?.(undefined as never).catch(() => undefined);
          yield { type: "error", message: initError };
          return;
        }
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
      pending = settle(gen.next());
    }
    sessionId = result.sessionId;
    contextUsage = result.contextUsage;
    compactionCount = result.compactionCount;
    apiUsage = result.apiUsage;
    // 走行が終わった後に届いた分（人が答える前にターンが終わった等）も落とさない
    while (sideEvents.length > 0) yield sideEvents.shift()!;
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  } finally {
    unsubscribeSide?.();
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

/**
 * `system/init` が届いた時点で、配線した代理サーバが全部繋がっているかを見る。
 * init 以外のメッセージでは何も言わない（`undefined`）。
 */
function relayHealthError(message: unknown, expectedServerNames: string[]): string | undefined {
  const m = message as { type?: string; subtype?: string };
  if (m?.type !== "system" || m?.subtype !== "init") return undefined;
  try {
    assertRelayHealthy([message] as Parameters<typeof assertRelayHealthy>[0], expectedServerNames);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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
