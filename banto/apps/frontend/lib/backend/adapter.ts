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
import {
  answerRealInboxItem,
  getRealThread,
  listRealUiTools,
  streamRealTurn,
  type RealUiTool,
  type RealInboxJudgment,
  type RealTurnEvent,
} from "./client";
import { refreshRealInbox } from "./real-inbox";
import { getThreadPermissionMode } from "../mock/permission-mode";
import { appendRealUsage, getThread, updateRealThreadData } from "../mock/threads";
import type { MockThread } from "../mock/types";
import { HUMAN_TOOL_NAME } from "../mock/adapter";

/** 判断待ちのカード1枚ぶんのpart。走行中（PartsAccumulator）とリロード後の
 *  復元（restoredJudgmentMessages）で同じものを使う——見た目も答え方も同じ1種類
 *  にする（規則3）。 */
function humanToolPart(
  toolCallId: string,
  serverName: string,
  message: string,
  options: {
    /** 承認する tool の引数。**何を承認するのか**を画面に出す（§6.0） */
    toolInput?: unknown;
    /** false なら答えても元の呼び出しには届かない（Elicitation由来、§2.4.1）
     *  ——答える口を出さない（規則13：繋がっていないものを押せるように見せない） */
    answerable?: boolean;
  } = {},
): Extract<ThreadAssistantMessagePart, { type: "tool-call" }> {
  return {
    type: "tool-call",
    toolCallId,
    toolName: HUMAN_TOOL_NAME,
    args: {
      serverName,
      message,
      toolInput: options.toolInput,
      answerable: options.answerable !== false,
      elicitation: { mode: "form", enumOptions: ["許可する", "拒否する"], allowFreeText: false },
    } as unknown as ReadonlyJSONObject,
    argsText: JSON.stringify({ serverName, message, toolInput: options.toolInput }),
  };
}

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

  startHumanTool(
    toolCallId: string,
    serverName: string,
    message: string,
    options?: { toolInput?: unknown; answerable?: boolean },
  ) {
    this.parts.push(humanToolPart(toolCallId, serverName, message, options));
  }

  /** まだ答えられていない判断待ちが残っているか。
   *  assistant-uiは**結果の無いtool-call partの状態に、メッセージ全体の状態を
   *  そのまま使う**（node_modules/@assistant-ui/core/.../normalizePartStatus.js の
   *  toMessagePartStatus）。つまりメッセージをrunningに戻すと、**まだ答えて
   *  いない判断待ちのカードまで「実行中」になり、答える口が消えて
   *  「回答済みです」に見える**（ユーザー報告・2026-09-06、tool呼び出しが
   *  2回あるときに発生）。ここを見て状態を決める。 */
  hasPendingHumanTool(): boolean {
    return this.parts.some(
      (p) => p.type === "tool-call" && p.toolName === HUMAN_TOOL_NAME && p.result === undefined,
    );
  }

  snapshot(): readonly ThreadAssistantMessagePart[] {
    return [...this.parts];
  }
}

/** toolCallId（judgment-<id>の形）→ 実Inboxのjudgment id。human-tool-card.tsxが答えを送るときに引く。 */
const judgmentIdByToolCallId = new Map<string, string>();

/** 判断待ちのtoolCallId → それを出した走行中のターン。答えをpartsへ書き戻すのに使う。 */
const liveByJudgmentToolCallId = new Map<string, LiveTurn>();

/** 復元した判断待ちのtoolCallId → そのThread。答えた後に記録を取り直すのに使う。 */
const threadIdByJudgmentToolCallId = new Map<string, string>();

/** 復元した判断待ちに答えたあと、記録から取り直した回数。ThreadPanelが
 *  useLocalRuntimeを作り直す合図に使う（initialMessagesは作成時にしか読まれない）。 */
const restoredSyncVersionByThread = new Map<string, number>();

export function restoredSyncVersion(threadId: string): number {
  return restoredSyncVersionByThread.get(threadId) ?? 0;
}

export function getRealJudgmentId(toolCallId: string): string | undefined {
  return judgmentIdByToolCallId.get(toolCallId);
}

interface LiveTurn {
  iterator: AsyncGenerator<RealTurnEvent>;
  acc: PartsAccumulator;
  /** このターンを起こしたときの発言。run() が呼び直されたとき、
   *  「同じターンの再開」か「新しい発言」かを見分けるのに使う。 */
  prompt: string;
}

/** **このブラウザがいま読んでいるターン**だけが入る（決定・2026-09-06、見直し起点）。
 *  以前は `done` フラグで「終わったか」を表していたが、フラグが立つのは SSE の
 *  done/error を自分で読んだときだけだった——停止ボタン・パネルのアンマウント
 *  （Fork を畳む／別 Project へ移る／Canvas を開く）・接続断では立たず、その Thread は
 *  「判断待ちのカードが二度と出ない」「次の送信が host に届かず消える」状態で詰んだ
 *  （docs/notes/2026-09-06-tool-approval-review.md）。
 *  いまは run() の finally で必ず取り除くので、**居るか居ないか**だけで表せる（規則3）。 */
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

function applyMessage(acc: PartsAccumulator, raw: unknown, threadId?: string): void {
  const message = raw as RawSdkMessage;
  if (message.type === "assistant") {
    const content = (message.message?.content ?? []) as AssistantContentBlock[];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        acc.appendText(block.text);
      } else if (block.type === "tool_use" && block.id && block.name) {
        acc.startTool(block.id, block.name, block.input ?? {});
        // その tool が画面を持つなら、会話のカードに埋める先として覚えておく
        // （MCP Apps の inline、§6.2）
        if (threadId) rememberInlineView(threadId, block.id, block.name, block.input);
      }
    }
  } else if (message.type === "user") {
    const content = (message.message?.content ?? []) as UserContentBlock[];
    for (const block of content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        const result = block.is_error ? { error: block.content } : block.content;
        acc.finishTool(block.tool_use_id, result);
        // 画面つきなら、結果も覚えておく（Canvas パネルから引くため）
        const view = inlineViewByToolCallId.get(block.tool_use_id);
        if (view) inlineViewByToolCallId.set(block.tool_use_id, { ...view, toolResult: result });
      }
    }
  }
}

// ---- Module の画面（MCP Apps の inline、決定・2026-09-06、§6.2）------------
//
// **どの tool が画面を持つかは Module が決める**（`_meta.ui.resourceUri`）。
// banto はそれを host 越しに聞いて、会話のカードの中に埋める場所を用意するだけ。

/** Thread ごとの「画面を持つ tool」の一覧。host が真実で、ここは引き当て用の控え。 */
const uiToolsByThread = new Map<string, RealUiTool[]>();
/** toolCallId → 埋める画面。human-tool-card.tsx が引く。 */
const inlineViewByToolCallId = new Map<string, RealInlineView>();

export interface RealInlineView {
  threadId: string;
  server: string;
  resourceUri: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  /** その呼び出しの結果。**inline も fullscreen も同じ中身を出す**ので、
   *  面と一緒に覚えておく（決定・2026-09-07）——会話の外（Canvas パネル）
   *  からは会話の parts を読めない。 */
  toolResult?: unknown;
}

export function getRealInlineView(toolCallId: string): RealInlineView | undefined {
  return inlineViewByToolCallId.get(toolCallId);
}

/**
 * **いま画面が tool を呼んでいて、承認を自分で出している Thread**
 * （決定・2026-09-06、改訂・2026-09-07——どちらもユーザー報告）。
 *
 * 画面からの tool 呼び出しは、承認を会話のカードとして出すと**会話が組み直され、
 * その画面自身が消える**（復元は host の記録＝テキストからしか作れないので、
 * tool のカードは残らない）。承認は**画面のその場**に出し、その間は会話に
 * 描き直さない——答える口を2つにしないため（規則3）。
 *
 * **判断待ちの id ではなく Thread で覚える。** id で覚えようとすると、
 * id を知るには受信箱を取り直す必要があり、**取り直した瞬間に会話が
 * 組み直されてしまう**（印を付ける前に再描画が走る）——実機で踏んだ
 * （ユーザー報告・2026-09-07：ボタンを押すと会話が消えて、承認すると
 * 会話は戻るが画面が消える）。**呼ぶ前に分かっている Thread で覚える。**
 */
const canvasCallsByThread = new Map<string, number>();

export function beginCanvasToolCall(threadId: string): void {
  canvasCallsByThread.set(threadId, (canvasCallsByThread.get(threadId) ?? 0) + 1);
}

export function endCanvasToolCall(threadId: string): void {
  const next = (canvasCallsByThread.get(threadId) ?? 1) - 1;
  if (next <= 0) canvasCallsByThread.delete(threadId);
  else canvasCallsByThread.set(threadId, next);
}

/** ターンが始まる前に一度だけ聞いておく——tool が走ってから聞くと間に合わない。 */
async function ensureUiTools(threadId: string): Promise<RealUiTool[]> {
  const cached = uiToolsByThread.get(threadId);
  if (cached) return cached;
  try {
    const tools = await listRealUiTools(threadId);
    uiToolsByThread.set(threadId, tools);
    return tools;
  } catch {
    // 画面が出ないだけ——会話は続ける。**黙って別経路へ落ちる**のとは違い、
    // ここは「無い」が正常な状態でもある（画面を持つ Module が無い場合）
    uiToolsByThread.set(threadId, []);
    return [];
  }
}

/** Runner から見える tool 名は `mcp__<Module名>__<tool名>`（Agent SDK の付け方）。 */
function rememberInlineView(threadId: string, toolCallId: string, toolName: string, input: unknown): void {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) return;
  const [, server, tool] = match;
  const found = uiToolsByThread.get(threadId)?.find((t) => t.server === server && t.tool === tool);
  if (!found) return;
  inlineViewByToolCallId.set(toolCallId, {
    threadId,
    server: found.server,
    resourceUri: found.resourceUri,
    toolName,
    toolArgs:
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined,
  });
}

/** リロード時の会話表示復元用（決定・2026-09-04）。banto hostのThreadState.messages
 *  （発言者＋テキストのみ）をuseLocalRuntimeのinitialMessagesへ変換する。 */
export function realMessagesToInitial(
  messages: MockThread["realMessages"],
  /** どの Thread の記録か。画面を出すのに要る（`ui-tool-call` の宛先）。 */
  threadIdOfRestoredCall: string,
): ThreadMessageLike[] {
  if (!messages) return [];
  return messages.map((m) => {
    const content: Array<Exclude<ThreadMessageLike["content"], string>[number]> = [];
    // **画面つき tool を先に置く**——AI の説明より前に呼ばれたものなので、
    // 会話の順番としてもそちらが先
    for (const call of m.uiToolCalls ?? []) {
      // 会話の外に置く inline の面は、この登録を見て描かれる
      inlineViewByToolCallId.set(call.toolCallId, {
        threadId: threadIdOfRestoredCall,
        server: call.server,
        resourceUri: call.resourceUri,
        toolName: call.toolName,
        toolArgs:
          typeof call.args === "object" && call.args !== null && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : undefined,
        toolResult: call.result,
      });
      content.push({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: (call.args ?? {}) as ReadonlyJSONObject,
        argsText: JSON.stringify(call.args ?? {}),
        result: call.result,
      });
    }
    if (m.text) content.push({ type: "text", text: m.text });
    return { id: `real-${m.seq}`, role: m.role, content };
  });
}

/**
 * このブラウザがそのThreadのターンを**読むのをやめる**（決定・2026-09-06、見直し起点）。
 * ThreadPanel の解体時に呼ぶ。
 *
 * run() の `finally` だけでは足りない——判断待ちで止まっている間、ジェネレータは
 * SSE の次のイベントを待って**中断している**ので、パネルが消えても誰も `return()` を
 * 呼ばず、`finally` に到達しない（実測・2026-09-06）。結果、`hasLiveRealRun` が
 * 永久に true になり、生きている判断待ちが二度と復元されず、次の送信も
 * 「新しいターン」と見なされずに消えていた。
 *
 * host 側のターンは hold-the-line で**生きたまま**にする（止めない）——
 * 判断待ちは受信箱に残り、次に開いたときカードとして描き直せる。
 */
export function releaseRealRun(threadId: string): void {
  const live = liveTurns.get(threadId);
  if (!live) return;
  liveTurns.delete(threadId);
  for (const [toolCallId, turn] of liveByJudgmentToolCallId) {
    if (turn === live) liveByJudgmentToolCallId.delete(toolCallId);
  }
  // 読むのをやめたSSEは閉じる（開いたままにしても誰も読まない）
  void live.iterator.return(undefined as never);
}

/** そのThreadのターンが、いまこのブラウザで生きているか。 */
export function hasLiveRealRun(threadId: string): boolean {
  return liveTurns.has(threadId);
}

/**
 * リロード後の判断待ちの復元（決定・2026-09-06、ユーザー報告起点）。
 *
 * ターンのSSEは `POST /api/threads/:id/messages` の応答の中にしか無いので、
 * ページを読み直すとその走行の出力はUIから切れる。**hostは hold-the-line で
 * 止まったまま**なので、判断待ちは生きて残る——このとき会話の画面には何も
 * 出ず、受信箱には答えるUIが無いので、**誰も答えられない**（実測・2026-09-06）。
 * そこで、走行中のrunが無いThreadを開いたときは、host側で生きている判断待ちを
 * カードとして描き直す。答え先は同じ `/api/inbox/:id/answer` なので、
 * これだけで止まっていたターンが動き出す。
 */
export function restoredJudgmentMessages(
  threadId: string,
  judgments: readonly RealInboxJudgment[],
): ThreadMessageLike[] {
  return judgments
    .filter((j) => j.threadId === threadId)
    // 画面がその場で承認を出している間は、会話に二重に出さない
    .filter(() => !canvasCallsByThread.has(threadId))
    // hostは新しい順で返す（listOpen）——会話に差し込むので**古い順**に直す
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((j) => {
      const toolCallId = `judgment-${j.id}`;
      judgmentIdByToolCallId.set(toolCallId, j.id);
      threadIdByJudgmentToolCallId.set(toolCallId, threadId);
      return {
        id: `restored-${j.id}`,
        role: "assistant" as const,
        // 呼び出し元の tool 名は判断待ちの本文が既に持っている
        // （「tool呼び出しの承認: mcp__filesystem__listDirectory」）ので、
        // 差出人は host が知っていればそれ、無ければ banto
        content: [
          humanToolPart(toolCallId, j.serverName ?? "banto", j.message, {
            toolInput: j.toolInput,
            answerable: j.source !== "elicitation",
          }),
        ],
      };
    });
}

export function createRealChatModelAdapter(thread: MockThread): ChatModelAdapter {
  return {
    async *run({ messages }) {
      let live = liveTurns.get(thread.id);

      // **走行中のターンがあるところへ、新しい発言を重ねない**（決定・2026-09-06）。
      // assistant-ui の isRunning は requires-action では false なので composer から
      // 送れてしまい、以前はここで「同じ SSE を2つの run が食い合い、送った
      // プロンプトは host に届かないまま消える」という壊れ方をしていた。
      // 塞ぐ場所は composer 側（ThreadPanel が判断待ち中は送信を止める）だが、
      // 経路は1つではないので、ここでも黙って落ちない形にする（規則2）。
      if (live && lastUserText(messages) !== live.prompt) {
        live.acc.appendText(
          "\n\n（この発言は送っていません——いま走っているターンが人の判断を待っています。答えてから送ってください）",
        );
        yield { content: live.acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
        return;
      }

      if (!live) {
        // 新規送信——現在進行中のライブなSSE接続が無ければ、実際にターンを開始する。
        const prompt = lastUserText(messages);
        const permissionMode = getThreadPermissionMode(thread.id, thread.projectId);
        void ensureUiTools(thread.id);
        // 終了イベントで「この走行」を降ろすために、自分自身を指す入れ物を用意する
        // （コールバックは live を作るより先に書く必要があるため）
        const self: { turn: LiveTurn | null } = { turn: null };
        live = {
          iterator: streamRealTurn(
            thread.id,
            prompt,
            permissionMode === "auto" ? undefined : permissionMode,
            // **受信した時点で**終わりを片付ける（描く側の都合に依存させない）
            (event) => {
              if (event.type !== "done") return;
              appendRealUsage(thread.id, event.contextUsage, event.compactionCount);
              // 「走行中」を降ろす。降ろさないと、ターンのあとに立った判断待ちが
              // 会話に描き直されない（ユーザー報告・2026-09-06）
              if (self.turn && liveTurns.get(thread.id) === self.turn) {
                liveTurns.delete(thread.id);
              }
            },
          ),
          acc: new PartsAccumulator(),
          prompt,
        };
        self.turn = live;
        liveTurns.set(thread.id, live);
      }
      const current = live;

      // 答え待ちが1つでも残っている間は requires-action のまま保つ
      const status = (): { type: "requires-action"; reason: "tool-calls" } | { type: "running" } =>
        live!.acc.hasPendingHumanTool()
          ? { type: "requires-action", reason: "tool-calls" }
          : { type: "running" };

      try {
      for await (const event of live.iterator) {
        if (event.type === "message") {
          applyMessage(live.acc, event.message, thread.id);
          // 答え待ちが無くなったらrunningへ戻す。**戻さないと**status が
          // requires-action のまま残り、ターンが終わってもカードが答えを
          // 待ち続ける（ランタイムが最後にcompleteへ寄せるのは
          // status==="running" のときだけ——local-thread-runtime-core.js の
          // performRoundtrip、実測で確認）。**逆に、答え待ちが残っている間に
          // 戻してはいけない**（hasPendingHumanTool のコメント）
          yield { content: live.acc.snapshot(), status: status() };
        } else if (event.type === "judgment") {
          const toolCallId = `judgment-${event.judgmentId}`;
          judgmentIdByToolCallId.set(toolCallId, event.judgmentId);
          liveByJudgmentToolCallId.set(toolCallId, live);
          // 受信箱にも即座に出す——取り直すだけで、ここでローカルに積まない
          // （真実はhost、規則3）
          void refreshRealInbox();
          live.acc.startHumanTool(
            toolCallId,
            event.serverName ?? event.toolName ?? "banto",
            event.message,
            {
              toolInput: event.toolInput,
              // Elicitation由来は host に解決先が無い（§2.4.1、実測・2026-09-06）
              // ——答えても届かないので、答える口を出さない
              answerable: event.kind !== "elicitation",
            },
          );
          yield { content: live.acc.snapshot(), status: status() };
          // **ここで return しない。** hostは canUseTool を hold-the-line で
          // 止めているだけで、答えれば同じSSE接続がそのまま続く——止まっているのは
          // hostであってUIではない。runを終わらせてaddResultで再開させると、
          // ランタイムが「メッセージの既存content」＋「再開したrunがyieldした
          // content」を**連結する**ため、累積partsを再びyieldした瞬間に
          // 同じtoolCallIdが2つ並び、Reactのkey衝突で画面が落ちる
          // （`Duplicate key toolCallId-… in useResources`——実測・2026-09-06。
          //  lib/mock/adapter.ts の同じ罠のコメントも参照）。
          // 待ちの機構はhost側の1つに保つ（規則3）。
          continue;
        } else if (event.type === "error") {
          live.acc.appendText(`\n\nエラー: ${event.message}`);
          // **答え待ちが残っていれば requires-action のまま**にする——固定で
          // running を返すと、未回答のカードが「回答済み」表示になって
          // 答える口が消える（見直し・2026-09-06。他の yield と揃える）
          yield { content: live.acc.snapshot(), status: status() };
          return;
        }
        // `done` はここでは扱わない——**このループは、描く側が引き取らないと
        // 進まない**（実測・2026-09-07：ランタイムは最後の yield のあと次を
        // 要求しないことがあり、終了イベントが一度も処理されなかった）。
        // 終了時の処理は streamRealTurn の onEvent 側で行う。
      }

      yield { content: live.acc.snapshot(), status: status() };
      } finally {
        // **どう終わってもここを通る**——正常終了・エラー・停止ボタン・
        // パネルのアンマウント（ジェネレータが捨てられる）。
        // 「このブラウザはもう読んでいない」を必ず記録する。host 側のターンは
        // hold-the-line で生きたままなので、次に開いたときは
        // restoredJudgmentMessages が判断待ちを描き直して拾える。
        if (liveTurns.get(thread.id) === current) liveTurns.delete(thread.id);
        for (const [toolCallId, turn] of liveByJudgmentToolCallId) {
          if (turn === current) liveByJudgmentToolCallId.delete(toolCallId);
        }
      }
    },
  };
}

/** 承認/Elicitationの答えを実hostへ送る。human-tool-card.tsxのonAnsweredから呼ぶ。
 *  **戻り値がtrueなら、ランタイムのaddResultを呼んではいけない**——実Threadの
 *  待ちはhost側にあり、addResultはrunを新しく起こしてpartsを二重にする（上のcontinue参照）。 */
export async function sendRealAnswer(toolCallId: string, answer: string): Promise<boolean> {
  const judgmentId = judgmentIdByToolCallId.get(toolCallId);
  if (!judgmentId) return false;
  const permissionResult =
    answer === "許可する" ? { behavior: "allow" as const } : { behavior: "deny" as const, message: answer };
  await answerRealInboxItem(judgmentId, permissionResult);
  const live = liveByJudgmentToolCallId.get(toolCallId);
  if (live) {
    // 答えを走っているrunのpartsに書き戻す——次にhostから何か届いたときの
    // yieldで「回答：許可する」として画面に出る。addResultの代わり。
    live.acc.finishTool(toolCallId, answer);
  } else {
    // リロード後に復元した判断待ち——このブラウザにはターンのSSEが無いので、
    // 続きは流れてこない。hostの記録から取り直して画面に反映する
    // （楽観的な写しは作らない、真実はhost・規則3）
    const threadId = threadIdByJudgmentToolCallId.get(toolCallId);
    if (threadId) void syncRestoredThread(threadId);
  }
  // 決着したものは受信箱から消える（§2.4.1「解決済みは状態として持たない」）
  await refreshRealInbox();
  return true;
}

/**
 * 復元した判断待ちに答えたあと、hostが進めたターンの結果を記録から取り直す。
 *
 * **打ち切りは「返事が増えたか」では決めない**（改訂・2026-09-06、見直し起点）。
 * hostがassistantの発言を追記するのは**ターンの終わり**なので、以前の
 * 「2秒×3回変化が無ければ打ち切り（＝実質6秒）」だと、承認後の処理が
 * 6秒を超える普通のターンで**続きが永久に画面へ入らなかった**。
 * ターンが本当に終わったか＝**assistantの返事が増えたか**を待ち、
 * それまでは待ち続ける（上限は5分）。
 */
async function syncRestoredThread(threadId: string): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  const assistantCount = (messages: MockThread["realMessages"]): number =>
    (messages ?? []).filter((m) => m.role === "assistant").length;
  const before = assistantCount(getThread(threadId)?.realMessages);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    try {
      const updated = await getRealThread(threadId);
      // 続きで別の判断待ちが立つこともある——それも拾って復元できるようにする
      await refreshRealInbox();
      const changed =
        updated.messages.length !== (getThread(threadId)?.realMessages?.length ?? 0);
      if (changed) {
        restoredSyncVersionByThread.set(threadId, restoredSyncVersion(threadId) + 1);
        updateRealThreadData(threadId, updated.messages, updated.markers, updated.usage);
      }
      // assistantの返事が増えた＝そのターンは終わった
      if (assistantCount(updated.messages) > before) return;
    } catch {
      // hostが落ちている等。**画面の中身は消さない**（規則2）。次の周回で取り直す
    }
  }
}
