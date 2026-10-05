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

import { randomId } from "@/lib/random-id";
import type {
  ChatModelAdapter,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadMessageLike,
} from "@assistant-ui/react";
import type { ReadonlyJSONObject } from "assistant-stream/utils";
import {
  answerRealInboxItem,
  fetchRealImageUrl,
  followRealTurn,
  listRealUiTools,
  stopRealTurn,
  streamRealTurn,
  REAL_IMAGE_SRC_PREFIX,
  type OutgoingImage,
  type RealMessageImage,
  type RealToolCard,
  type RealUiTool,
  type RealThread,
  type RealTurnEvent,
} from "./client";
import { refreshRealInbox } from "./real-inbox";
import { decideRun, type LiveTurnState } from "./live-turn-guard";
import { getThreadPermissionMode } from "../mock/permission-mode";
import { appendRealUsage, updateRealThreadData } from "../mock/threads";
import type { MockThread } from "../mock/types";
import { HUMAN_TOOL_NAME } from "../mock/adapter";

/** Project をまたぐメッセージの承認で「以後聞かない」を選ぶ答え（host の `MESSAGE_ALLOW_REMEMBER` と同じ言葉） */
export const MESSAGE_ALLOW_REMEMBER = "許可し、以後この Project からは聞かない";

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
    /** 答えの選択肢（追加・2026-10-01）。無ければ「許可する／拒否する」 */
    choices?: string[];
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
      elicitation: {
        mode: "form",
        enumOptions: options.choices && options.choices.length > 0 ? options.choices : ["許可する", "拒否する"],
        allowFreeText: false,
      },
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

  /**
   * **SDK が届けた文ブロックを1つ足す**（改訂・2026-09-26）。前も文なら段落を分けてつなぐ——別々に届く文は
   * 別々の発言（別の応答・CLI の「API Error: …」など、実データで測った）。以前は貼り合わせていて
   * 「…です。API Error: …」がくっつき、記録（host の `extractAssistantText`、段落で区切る）から組み直した
   * リロード後とも見え方が違った
   */
  addTextBlock(text: string) {
    if (text === "") return;
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === "text") {
      this.parts[this.parts.length - 1] = { ...last, text: `${last.text}\n\n${text}` };
    } else {
      this.parts.push({ type: "text", text });
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
    options?: { toolInput?: unknown; answerable?: boolean; choices?: string[] },
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


/** 復元した判断待ちに答えたあと、記録から取り直した回数。ThreadPanelが
 *  useLocalRuntimeを作り直す合図に使う（initialMessagesは作成時にしか読まれない）。 */
const restoredSyncVersionByThread = new Map<string, number>();

export function restoredSyncVersion(threadId: string): number {
  return restoredSyncVersionByThread.get(threadId) ?? 0;
}

export function getRealJudgmentId(toolCallId: string): string | undefined {
  return judgmentIdByToolCallId.get(toolCallId);
}

interface LiveTurn extends LiveTurnState {
  iterator: AsyncGenerator<RealTurnEvent>;
  acc: PartsAccumulator;
  /** このターンを起こしたときの発言（表示・記録用）。 */
  prompt: string;
  /**
   * **あとから乗った流れ**（この画面が送ったのではないターン——決定・2026-09-26）だけが持つ。読むのをやめたら
   * 受信も止める。自分で送った流れは止めない（host がターンを最後まで流す口でもある）
   */
  close?: () => void;
  /** あとから乗った流れを、まだ会話に描き始めていない（`takeFollowToStart` で描き始める） */
  awaitingStart?: boolean;
  /** この画面が送ったターンの名前（§6.31）。止めるとき host に渡す——乗った流れには無い */
  turnId?: string;
  /** この画面が送った発言に添えた画像（取り消したら入力欄へ戻す——§6.31） */
  localImages?: WithdrawnImage[];
  /** あとから乗った流れの、ターンの始まりの seq（host の `attached`）。記録と流し直しの境界——自分で送った流れには無い */
  startedSeq?: number;
}

// ---- 止める（決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）-------------------------------
//
// 停止ボタンは assistant-ui の `cancelRun()` を呼ぶ。ランタイムは adapter が次を渡すまで「止めた」を描かない（
// `local-thread-runtime-core.js`）——以前は host から次のイベントが届くまで止まらず、しかも host のターンは走り
// 続けていた。いまは止める合図ですぐ読むのをやめ、host に止めてもらう。AI がまだ何も出していなければ host が発言ごと
// 取り消すので、その中身を入力欄へ戻す（`onTurnWithdrawn`）。

/** 取り消した発言に添えていた画像1枚。中身は戻すときに取る */
export interface WithdrawnImage {
  name?: string;
  load(): Promise<Blob>;
}

/** 取り消した発言——入力欄へ戻すもの */
export interface WithdrawnTurn {
  text: string;
  images: WithdrawnImage[];
}

const withdrawnListeners = new Set<(threadId: string, withdrawn: WithdrawnTurn) => void>();

/** その Thread で人が止めて発言が取り消されたら知らせる（会話の面が入力欄へ戻す） */
export function onTurnWithdrawn(listener: (threadId: string, withdrawn: WithdrawnTurn) => void): () => void {
  withdrawnListeners.add(listener);
  return () => withdrawnListeners.delete(listener);
}

function reportWithdrawn(threadId: string, withdrawn: WithdrawnTurn): void {
  for (const listener of withdrawnListeners) listener(threadId, withdrawn);
}

/** host に止めてもらっている最中の Thread。その間は記録から組み直さない——止まりきる前のターンに乗り直さない */
const stoppingThreads = new Set<string>();

/**
 * いまの中断が「人が停止ボタンを押した」ものか。assistant-ui は停止ボタン（`cancelRun`）で `AbortError(detach=false)`、
 * 面を外すとき（`detach`）で `AbortError(detach=true)`、次の run を始めるときは理由なしで止める。画面を離れただけで
 * host のターンを止めてはいけない。こちらが会話を組み直すために止めるものは `cancelRunQuietly` を通す
 */
const quietCancels = new Set<string>();
function isStopButton(signal: AbortSignal, threadId: string): boolean {
  if (quietCancels.has(threadId)) return false;
  const reason = signal.reason as { name?: unknown; detach?: unknown } | undefined;
  return reason?.name === "AbortError" && reason.detach === false;
}

/** 人の停止ではない中断（会話を記録から組み直す前など）。host のターンは止めない */
export function cancelRunQuietly(threadId: string, cancel: () => void): void {
  quietCancels.add(threadId);
  try {
    cancel();
  } finally {
    quietCancels.delete(threadId);
  }
}

/** 中断の合図が立ったら解ける。人の停止かどうかは、立ったその場で決める（`quietCancels` はその瞬間だけ立つ） */
function whenAborted(signal: AbortSignal, threadId: string): Promise<{ stopButton: boolean }> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ stopButton: isStopButton(signal, threadId) });
    else signal.addEventListener("abort", () => resolve({ stopButton: isStopButton(signal, threadId) }), { once: true });
  });
}

/** この画面が送る発言に添えた画像（data URL）を、戻せる形で控える */
function localWithdrawnImages(messages: readonly ThreadMessage[]): WithdrawnImage[] {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last || last.role !== "user") return [];
  const images: WithdrawnImage[] = [];
  for (const attachment of last.attachments ?? []) {
    for (const part of attachment.content ?? []) {
      if (part.type !== "image") continue;
      const src = part.image;
      images.push({ ...(attachment.name ? { name: attachment.name } : {}), load: async () => (await fetch(src)).blob() });
    }
  }
  return images;
}

/** host が取り消した発言の画像（置き場の名前）を、戻せる形にする */
function hostWithdrawnImages(images: readonly RealMessageImage[]): WithdrawnImage[] {
  return images.map((image) => ({
    ...(image.name ? { name: image.name } : {}),
    load: async () => (await fetch(await fetchRealImageUrl(image.id))).blob(),
  }));
}

/**
 * **host に止めてもらう**。画面はもう止まっている（読むのをやめた）。片づいたら、取り消した発言を入力欄へ戻し、
 * 記録から会話を組み直す（取り消した発言は消え、途中まで出たものは「ここで止めました」と一緒に残る）
 */
function stopOnHost(threadId: string, turn: LiveTurn): void {
  stoppingThreads.add(threadId);
  void (async () => {
    try {
      const outcome = await stopRealTurn(threadId, turn.turnId);
      if (outcome.withdrawn) {
        reportWithdrawn(threadId, {
          text: outcome.withdrawn.text,
          // この画面が送った画像は手元にある——取りに行かない
          images: turn.localImages ?? hostWithdrawnImages(outcome.withdrawn.images),
        });
      }
    } catch (err) {
      // **黙らない**（規則2）——止められなかったら、ターンは host で続いている。組み直せば走っていると分かる
      console.warn(`[banto] 会話 ${threadId} のターンを止められませんでした:`, err);
    } finally {
      stoppingThreads.delete(threadId);
      reportStreamOutcome(threadId, "disconnected");
    }
  })();
}

/** **このブラウザがいま読んでいるターン**だけが入る（決定・2026-09-06、見直し起点）。
 *  以前は `done` フラグで「終わったか」を表していたが、フラグが立つのは SSE の
 *  done/error を自分で読んだときだけだった——停止ボタン・パネルのアンマウント
 *  （Fork を畳む／別 Project へ移る／Canvas を開く）・接続断では立たず、その Thread は
 *  「判断待ちのカードが二度と出ない」「次の送信が host に届かず消える」状態で詰んだ
 *  （docs/notes/2026-09-06-tool-approval-review.md）。
 *  いまは run() の finally で必ず取り除くので、**居るか居ないか**だけで表せる（規則3）。 */
const liveTurns = new Map<string, LiveTurn>();
/**
 * **会話が送っている・流しているか**（会話のランタイムが知らせる——決定・2026-09-26）。人が Enter を押すと
 * 発言が会話に入り、host に送り出すまでに短い間がある（画面つき tool の一覧を聞く等）。その間に会話を
 * 組み直すと、送った発言ごと会話が作り直されて送信が消える——この間も「この画面が読んでいる」とみなす
 */
const runtimeBusy = new Map<string, () => boolean>();

/** 会話のランタイムが、送っている・流しているかを答える口を置く。外すときは返り値を呼ぶ */
export function registerRuntimeBusy(threadId: string, isBusy: () => boolean): () => void {
  runtimeBusy.set(threadId, isBusy);
  return () => {
    if (runtimeBusy.get(threadId) === isBusy) runtimeBusy.delete(threadId);
  };
}

/**
 * **会話が走り終えた**（送っている・流している状態から戻った）ことを、最新を出す側に知らせる
 * （決定・2026-09-26）。上の守りで引き返した「最新を出す」を、ここでやり直す——流れが切れたと分かった
 * 瞬間は、まだ会話の run の後片づけの途中で「走っている」ので、そこで引き返したまま次のきっかけが
 * 来ないと、途中の吹き出しのまま止まっていた（実測・2026-09-26、黙って止まった接続の試験で1回）
 */
const runtimeIdleListeners = new Set<(threadId: string) => void>();

export function onRuntimeIdle(listener: (threadId: string) => void): () => void {
  runtimeIdleListeners.add(listener);
  return () => runtimeIdleListeners.delete(listener);
}

export function reportRuntimeIdle(threadId: string): void {
  for (const listener of runtimeIdleListeners) listener(threadId);
}

/**
 * **流れがどう終わったか**を、最新を出す側（`latest-state.ts`）に知らせる（決定・2026-09-26）。
 *  - `done`：最後まで読んだ——会話はもう最新。組み直さない
 *  - `disconnected`：途中で切れた——記録から組み直して、まだ走っていれば乗り直す
 */
export type StreamOutcome = "done" | "disconnected";
const streamOutcomeListeners = new Set<(threadId: string, outcome: StreamOutcome) => void>();

export function onStreamOutcome(listener: (threadId: string, outcome: StreamOutcome) => void): () => void {
  streamOutcomeListeners.add(listener);
  return () => streamOutcomeListeners.delete(listener);
}

function reportStreamOutcome(threadId: string, outcome: StreamOutcome): void {
  for (const listener of streamOutcomeListeners) listener(threadId, outcome);
}

function countUserMessages(messages: readonly ThreadMessage[]): number {
  return messages.filter((m) => m.role === "user").length;
}

function lastUserText(messages: readonly ThreadMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * **最後の人の発言に添えた画像**（決定・2026-09-26）。composer の添付は送るときに data URL になる
 * （`image-attachment.ts`）——その base64 をそのまま host に渡す。形式は host が中身から決める。
 * data URL でないもの（リロードで記録から戻した画像）は、新しく送る発言には来ない——来たら黙って落とさず止める
 */
function lastUserImages(messages: readonly ThreadMessage[]): OutgoingImage[] {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last || last.role !== "user") return [];
  const images: OutgoingImage[] = [];
  for (const attachment of last.attachments ?? []) {
    for (const part of attachment.content ?? []) {
      if (part.type !== "image") continue;
      const data = /^data:[^;,]*;base64,(.*)$/.exec(part.image)?.[1];
      if (!data) throw new Error(`添えた画像「${attachment.name}」を送れる形に読めませんでした`);
      images.push({ data, ...(attachment.name ? { name: attachment.name } : {}) });
    }
  }
  return images;
}

function restoredImageAttachment(image: RealMessageImage) {
  return {
    id: `real-image-${image.id}`,
    type: "image" as const,
    name: image.name ?? "画像",
    status: { type: "complete" as const },
    content: [{ type: "image" as const, image: `${REAL_IMAGE_SRC_PREFIX}${image.id}` }],
  };
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
        acc.addTextBlock(block.text);
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
        const view = threadId
          ? inlineViewByToolCallId.get(viewKey(threadId, block.tool_use_id))
          : undefined;
        if (view && threadId) {
          inlineViewByToolCallId.set(viewKey(threadId, block.tool_use_id), { ...view, toolResult: result });
        }
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
/**
 * **Thread と toolCallId の組**→ 埋める画面。human-tool-card.tsx が引く。
 *
 * 以前は toolCallId だけを鍵にしていた。**Fork は親の履歴をそのまま持つ**ので、
 * Fork を開いた瞬間に同じ toolCallId で上書きされ、**Base の会話に出ている画面が
 * 「自分は Fork のものだ」と言い出す**——画面の橋が張り直され、そこからの
 * tool 呼び出しも Fork の側に記録されていた（実測・2026-09-10、
 * `frontend-interaction-hardening`）。**どの Thread のものかまで鍵にする**。
 */
const inlineViewByToolCallId = new Map<string, RealInlineView>();

function viewKey(threadId: string, toolCallId: string): string {
  return `${threadId}\u0000${toolCallId}`;
}

export interface RealInlineView {
  threadId: string;
  toolCallId: string;
  server: string;
  resourceUri: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  /**
   * **会話にはカードだけを置く**（`dev.banto/card`、決定・2026-10-01、ユーザー）。あれば画面を埋めず、
   * 呼んだ時点から（結果を待たずに）カードを出し、押すと Canvas に開く
   */
  card?: RealToolCard;
  /** その呼び出しの結果。**inline も fullscreen も同じ中身を出す**ので、
   *  面と一緒に覚えておく（決定・2026-09-07）——会話の外（Canvas パネル）
   *  からは会話の parts を読めない。 */
  toolResult?: unknown;
  /**
   * **どの面に出したか**（host の記録から。決定・2026-09-07、ユーザー指摘）。
   * `fullscreen` なら会話には入口（カード）だけを残す——記録から画面を
   * 組み直して埋めると、その画面がまた「大きく出して」と言い、
   * **リロードのたびに Canvas が勝手に開く**。
   */
  displayMode?: "inline" | "fullscreen";
}

/**
 * その Thread の、その呼び出しの画面。**どの Thread で描いているかまで渡す**
 * ——渡さないと、同じ toolCallId を持つ Fork と取り違える（上のコメント）。
 * Canvas のパネル（会話の外）は開いた元の Thread が分からないので、
 * その場合だけ toolCallId だけで引き当てる。
 */
export function getRealInlineView(
  toolCallId: string,
  threadId?: string,
): RealInlineView | undefined {
  if (threadId) return inlineViewByToolCallId.get(viewKey(threadId, toolCallId));
  for (const view of inlineViewByToolCallId.values()) {
    if (view.toolCallId === toolCallId) return view;
  }
  return undefined;
}

/** 画面が「大きく出して」と言ったことを覚えておく（決定・2026-09-07）。
 *  会話が組み直されても、その呼び出しは入口だけを残す——同じ画面が
 *  会話の中と Canvas に二重に出ないようにする。 */
export function markInlineViewDisplayMode(
  threadId: string,
  toolCallId: string,
  displayMode: "inline" | "fullscreen",
): void {
  const view = inlineViewByToolCallId.get(viewKey(threadId, toolCallId));
  if (view) inlineViewByToolCallId.set(viewKey(threadId, toolCallId), { ...view, displayMode });
}

/**
 * **一覧を待つ上限**（追加・2026-09-22）。普段は 0.2 秒ほどで返る（実測）。
 * 越えたら、その回は画面を諦めてターンを始める——**会話が始まらないほうが悪い**。
 */
const UI_TOOLS_WAIT_MS = 5_000;

/**
 * **ターンが始まるたびに聞き直す**——tool が走ってから聞くと間に合わない（改訂・2026-09-29）。
 *
 * 以前は Thread ごとに**一度だけ**聞き、失敗したときも「無い」（`[]`）を覚えていた。しかも聞くのは
 * **この画面で人が送ったときだけ**で、あとから乗ったターン（届いたもので host が始めた・別の画面で送った）
 * では聞かなかった。再起動のあと、人がまだ送っていない画面で届いた結果を AI が読み、Publish の承認を
 * 頼んだら、**承認の画面が会話に出ず、読み込み直すと出た**（実測・2026-09-29）。
 *
 * いまは、自分で送るときも乗るときも聞き直す（1回 0.2 秒ほど）。途中で繋いだ Module の画面も拾える。
 * **失敗したら前に聞けた一覧を使い、失敗を覚えない**——次のターンでまた聞く
 */
async function ensureUiTools(threadId: string): Promise<RealUiTool[]> {
  try {
    const tools = await listRealUiTools(threadId);
    uiToolsByThread.set(threadId, tools);
    return tools;
  } catch {
    // 画面が出ないだけ——会話は続ける。ここは「無い」が正常な状態でもある（画面を持つ Module が無い場合）
    return uiToolsByThread.get(threadId) ?? [];
  }
}

/** 聞き終わるまで待つ。**ただし待ち切らない**——会話が始まる（乗る）ことのほうが、画面が1つ出ることより大事 */
function waitUiTools(threadId: string): Promise<unknown> {
  return Promise.race([ensureUiTools(threadId), new Promise((r) => setTimeout(r, UI_TOOLS_WAIT_MS))]);
}

/** Runner から見える tool 名は `mcp__<Module名>__<tool名>`（Agent SDK の付け方）。 */
function rememberInlineView(threadId: string, toolCallId: string, toolName: string, input: unknown): void {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) return;
  const [, server, tool] = match;
  const found = uiToolsByThread.get(threadId)?.find((t) => t.server === server && t.tool === tool);
  if (!found) return;
  inlineViewByToolCallId.set(viewKey(threadId, toolCallId), {
    threadId,
    toolCallId,
    server: found.server,
    resourceUri: found.resourceUri,
    ...(found.card ? { card: found.card } : {}),
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
      // **大きく出したものは、会話に埋め直さない**（決定・2026-09-07）——
      // 埋め直すと、その画面がまた「大きく出して」と言い、リロードのたびに
      // Canvas が勝手に開く。会話には入口（カード）だけを残す。
      // この場で覚えた分（いま走ったターンで大きく出したもの）も残す
      const known = inlineViewByToolCallId.get(viewKey(threadIdOfRestoredCall, call.toolCallId));
      inlineViewByToolCallId.set(viewKey(threadIdOfRestoredCall, call.toolCallId), {
        threadId: threadIdOfRestoredCall,
        toolCallId: call.toolCallId,
        displayMode: call.displayMode ?? known?.displayMode,
        server: call.server,
        resourceUri: call.resourceUri,
        ...(call.card ? { card: call.card } : {}),
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
    // **届いたものは人の発言として描かない**（決定・2026-09-25）——印を渡し、会話の描き手が札にする
    return {
      id: `real-${m.seq}`,
      role: m.role,
      content,
      // 人が添えた画像（決定・2026-09-26）——送ったときと同じ添付の形で出す
      ...(m.role === "user" && m.images && m.images.length > 0
        ? { attachments: m.images.map(restoredImageAttachment) }
        : {}),
      ...(m.origin ? { metadata: { custom: { origin: m.origin } } } : {}),
    };
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
  live.close?.();
  followsToStart.delete(threadId);
}

/** そのThreadのターンが、いまこのブラウザで生きているか（会話が送っている・流している間も含む）。 */
export function hasLiveRealRun(threadId: string): boolean {
  return liveTurns.has(threadId) || stoppingThreads.has(threadId) || (runtimeBusy.get(threadId)?.() ?? false);
}

export function createRealChatModelAdapter(thread: MockThread): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      let live = liveTurns.get(thread.id);
      // 止める合図（§6.31）——host から次が届くのを待たずに、ここで読むのをやめる
      const aborted = whenAborted(abortSignal, thread.id);

      // **走行中のターンがあるところへ、新しい発言を重ねない**（決定・2026-09-06、
      // 見分け方を改訂・2026-09-10）。assistant-ui の isRunning は requires-action
      // では false なので composer から送れてしまい、以前はここで「同じ SSE を
      // 2つの run が食い合い、送ったプロンプトは host に届かないまま消える」
      // という壊れ方をしていた。塞ぐ場所は composer 側（ThreadPanel が判断待ち中は
      // 送信を止める）だが、経路は1つではないので、ここでも黙って落ちない形にする
      // （規則2）。**見分けは文面ではなく発言の数と「誰かが読んでいるか」**
      // ——同じ文面をもう一度送ると、文面では再開と区別できない
      // （`live-turn-guard.ts`）。
      // あとから乗った流れを描き始める前に届いた送信も、同じく重ねない
      if (live && (live.awaitingStart || decideRun(live, countUserMessages(messages)) === "refuse")) {
        live.acc.appendText(
          live.acc.hasPendingHumanTool()
            ? "\n\n（この発言は送っていません——いま走っているターンが人の判断を待っています。答えてから送ってください）"
            : "\n\n（この発言は送っていません——この会話ではターンがまだ走っています。終わってから、もう一度送ってください）",
        );
        yield { content: live.acc.snapshot(), status: { type: "requires-action", reason: "tool-calls" } };
        return;
      }

      if (!live) {
        // 新規送信——現在進行中のライブなSSE接続が無ければ、実際にターンを開始する。
        const prompt = lastUserText(messages);
        const images = lastUserImages(messages);
        const permissionMode = getThreadPermissionMode(thread.id, thread.projectId);
        // **聞き終わってからターンを始める。ただし待ち切らない**（訂正・2026-09-22）。
        //
        // `void` で投げっぱなしだと、**問い合わせより先に tool_use が返ってくると
        // 画面が出ない**——`rememberInlineView` は一覧を引けないと黙って何もしない
        // ので、Canvas は開かず入口のカードも残らない（`fullscreen-canvas-order-fragility`）。
        // なので待つ。
        //
        // **が、待ち切ってはいけない。** 一度 `await` だけにしたところ、
        // **Module が1本答えないだけで会話そのものが始まらなくなった**
        // ——フル E2E で「ターンが一度も host に届かない」形で出た（2026-09-22）。
        // host 側も1本ずつに上限を置いたが（`listUiToolsForThread`）、
        // **会話が始まることのほうが、画面が1つ出ることより大事**なので、
        // ここでも上限を置く。**待ちで隠しているのではない**——越えたときに
        // 何が起きるか（その Module の画面が出ない）が分かっている（規則6）。
        await Promise.race([waitUiTools(thread.id), aborted]);
        if (abortSignal.aborted) {
          // **送り出す前に止めた**（§6.31）——host には何も届いていない。そのまま入力欄へ戻し、記録から組み直す
          // （会話に入ったこの発言は、記録に無いので消える）
          if ((await aborted).stopButton) {
            reportWithdrawn(thread.id, { text: prompt, images: localWithdrawnImages(messages) });
            reportStreamOutcome(thread.id, "disconnected");
          }
          return;
        }
        // `crypto.randomUUID` は http の LAN アドレスなどでは無い（`lib/random-id.ts`）
        const turnId = randomId();
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
              if (event.type !== "done" && event.type !== "stopped") return;
              if (event.type === "done") appendRealUsage(thread.id, event.contextUsage, event.compactionCount);
              // 「走行中」を降ろす。降ろさないと、ターンのあとに立った判断待ちが
              // 会話に描き直されない（ユーザー報告・2026-09-06）
              if (self.turn && liveTurns.get(thread.id) === self.turn) {
                liveTurns.delete(thread.id);
              }
              // 止めたターンは記録が変わっている（取り消した・「ここで止めました」を足した）——組み直す
              reportStreamOutcome(thread.id, event.type === "done" ? "done" : "disconnected");
            },
            images,
            turnId,
          ),
          acc: new PartsAccumulator(),
          prompt,
          userMessageCount: countUserMessages(messages),
          consuming: false,
          turnId,
          localImages: localWithdrawnImages(messages),
        };
        self.turn = live;
        liveTurns.set(thread.id, live);
      }
      const current = live;
      // **このターンを読むのは、いま自分ひとり**（`live-turn-guard.ts`）
      current.consuming = true;

      // 答え待ちが1つでも残っている間は requires-action のまま保つ
      const status = (): { type: "requires-action"; reason: "tool-calls" } | { type: "running" } =>
        live!.acc.hasPendingHumanTool()
          ? { type: "requires-action", reason: "tool-calls" }
          : { type: "running" };
      let disconnected = false;

      try {
      for (;;) {
        // **止める合図を待ちと競わせる**（§6.31）——待っている間に停止ボタンが押されたら、その瞬間に抜ける
        const step = await Promise.race([live.iterator.next(), aborted]);
        if ("stopButton" in step) {
          if (step.stopButton) stopOnHost(thread.id, current);
          return;
        }
        if (step.done) break;
        const event = step.value;
        if (event.type === "stopped") {
          // 別の画面から止められた（この画面が止めたなら、もう抜けている）——記録から組み直す
          disconnected = true;
          break;
        }
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
              ...(event.choices ? { choices: event.choices } : {}),
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
        } else if (event.type === "answered") {
          // **どこで答えても、そのカードは回答済みになる**（決定・2026-09-26）——別の画面・受信箱で答えたもの、
          // 流し直しで届いた過去の答えも
          const toolCallId = `judgment-${event.judgmentId}`;
          live.acc.finishTool(toolCallId, event.answer);
          liveByJudgmentToolCallId.delete(toolCallId);
          yield { content: live.acc.snapshot(), status: status() };
          continue;
        } else if (event.type === "disconnected") {
          // **流れが切れた**（携帯で別アプリへ移った等）。ターンは host で続いている——人にエラーとしては
          // 見せず、ここで読むのをやめる。記録から組み直して乗り直すのは最新を出す側（`finally` で知らせる）
          disconnected = true;
          break;
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
        current.consuming = false;
        if (liveTurns.get(thread.id) === current) liveTurns.delete(thread.id);
        for (const [toolCallId, turn] of liveByJudgmentToolCallId) {
          if (turn === current) liveByJudgmentToolCallId.delete(toolCallId);
        }
        // あとから乗った流れは受信も止める（停止ボタン・画面を離れた・切れた）
        current.close?.();
        if (disconnected) reportStreamOutcome(thread.id, "disconnected");
      }
    },
  };
}

// ---- あとから乗る（決定・2026-09-26、ユーザー要望「戻ったら最新の状況をそのまま出して」）------------
//
// リロード・開き直し・別アプリから戻った・別の画面や host が始めたターン——**どれも、自分で送ったときと
// 同じ描き方で会話の本文に流す**。host に最初から流し直してもらい（`GET …/stream`）、それを自分の送信と
// 同じ `LiveTurn` として持つ。描くのは会話のランタイムに run を1本始めさせる（`takeFollowToStart`）——
// 読む道も判断待ちの答え方も、自分で送ったターンと1つにする（規則3）。

/** 乗った流れを描き始める会話の版（組み直したときの `restoredSyncVersion`）。その版の会話だけが描き始める */
const followsToStart = new Map<string, number>();
const followListeners = new Set<() => void>();
let followVersionCounter = 0;

export function subscribeFollow(listener: () => void): () => void {
  followListeners.add(listener);
  return () => followListeners.delete(listener);
}

export function followVersion(): number {
  return followVersionCounter;
}

/** 乗ったターン。`startedSeq` はそのターンの始まりの seq——記録から組み直すとき、流し直す分を外す境界（`replayed-turn.ts`） */
export interface FollowedTurn {
  startedSeq?: number;
}

/**
 * **その Thread で host が走らせているターンに乗る**。乗ったら、そのターン（描き始めるのはランタイムが
 * `takeFollowToStart` を見てから）。走っていなければ false。繋げなければ投げる（呼ぶ側が後でやり直す）。
 * すでにこの画面が読んでいるなら何もしない
 */
export async function followRunningTurn(threadId: string): Promise<false | FollowedTurn> {
  const already = liveTurns.get(threadId);
  if (already) return { ...(already.startedSeq !== undefined ? { startedSeq: already.startedSeq } : {}) };
  // **乗る前に、画面を持つ tool の一覧を聞いておく**（追加・2026-09-29）——自分で送るときと同じ。聞かずに乗ると、
  // そのターンで呼ばれた画面つきの tool（Publish の承認など）が会話に出ない
  const uiTools = waitUiTools(threadId);
  const self: { turn: LiveTurn | null } = { turn: null };
  let sawContent!: () => void;
  const contentArrived = new Promise<void>((resolve) => (sawContent = resolve));
  const stream = followRealTurn(threadId, (event) => {
    if (event.type === "attached" || event.type === "idle") return;
    sawContent();
    if (event.type !== "done" && event.type !== "stopped") return;
    if (event.type === "done") appendRealUsage(threadId, event.contextUsage, event.compactionCount);
    if (self.turn && liveTurns.get(threadId) === self.turn) liveTurns.delete(threadId);
    // 止めたターンは記録が変わっている——組み直す（§6.31）
    reportStreamOutcome(threadId, event.type === "done" ? "done" : "disconnected");
  });
  const head = await stream.events.next();
  const first = head.done ? undefined : head.value;
  if (!first || first.type === "idle") {
    stream.close();
    return false;
  }
  if (first.type !== "attached") {
    stream.close();
    throw new Error(first.type === "disconnected" ? first.message : `走行中のターンに乗れませんでした（${first.type}）`);
  }
  // **最初の中身が届くまで待つ**——host はターンの入力（人の発言・届いたもの）を記録してから Runner を起こす
  // ので、中身が1つでも来ていれば、記録にはその入力がある。開き直した場合は流し直しがすぐ届く。
  // 起きるのが遅い回（コンテナが起きる等）でも止まり続けないよう、上限を置く——越えても描くのは同じ
  await Promise.race([contentArrived, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  await uiTools;
  if (hasLiveRealRun(threadId)) {
    // 待っている間に、この画面が自分で送り始めた——そちらを読む。**乗ったとは答えない**（改訂・2026-09-28、
    // レビュー指摘）：以前は true を返し、呼ぶ側が「乗った」として記録から組み直して、送ったばかりの
    // ターンを会話ごと捨てていた
    stream.close();
    return false;
  }
  const turn: LiveTurn = {
    iterator: stream.events as AsyncGenerator<RealTurnEvent>,
    acc: new PartsAccumulator(),
    prompt: "",
    // 乗った流れには人の発言を数える起点が無い——新しい送信は `consuming` で見分ける（`live-turn-guard.ts`）
    userMessageCount: Number.MAX_SAFE_INTEGER,
    consuming: false,
    close: stream.close,
    awaitingStart: true,
    ...(first.startedSeq !== undefined ? { startedSeq: first.startedSeq } : {}),
  };
  self.turn = turn;
  liveTurns.set(threadId, turn);
  // 描き始めるのは、このあと記録から組み直した会話（`applyThreadRecord`）——ここでは印を付けない
  return { ...(first.startedSeq !== undefined ? { startedSeq: first.startedSeq } : {}) };
}

/**
 * 会話のランタイムが、乗った流れを描き始めてよいか（1回だけ true）。true なら run を1本始めること。
 * **組み直した版の会話だけが描き始める**（`build`＝その会話を作ったときの `restoredSyncVersion`）——
 * 組み直す前の、すぐ捨てられる会話が先に印を取ると、最後に残る会話では誰も描き始めず、判断待ちも
 * 出ないまま止まっていた（実測・2026-09-26、フル E2E で1回）
 */
export function takeFollowToStart(threadId: string, build: number): boolean {
  if (followsToStart.get(threadId) !== build) return false;
  followsToStart.delete(threadId);
  const live = liveTurns.get(threadId);
  if (!live?.awaitingStart) return false;
  live.awaitingStart = false;
  return true;
}

/**
 * **記録から会話を組み直す**（ランタイムを作り直す——流れていた途中の吹き出しは消え、乗った流れがあれば
 * 新しいランタイムがそれを描き始める）。**記録の写しは、組み直すときにだけ書き換える**——会話の中の
 * 目印（Fork の入口・Clear の横線）は、組み立てたときの記録の番号（`real-<seq>`）で置き場所を探すので、
 * 写しだけ新しくすると、いまの会話に無い番号を探して目印が消える（実測・2026-09-26）
 */
export function applyThreadRecord(threadId: string, record: RealThread): void {
  const build = restoredSyncVersion(threadId) + 1;
  restoredSyncVersionByThread.set(threadId, build);
  // 乗った流れがまだ描かれていなければ、この版の会話が描き始める
  if (liveTurns.get(threadId)?.awaitingStart) followsToStart.set(threadId, build);
  updateRealThreadData(threadId, record.messages, record.markers, record.usage);
  followVersionCounter += 1;
  for (const listener of followListeners) listener();
}

/** 承認/Elicitationの答えを実hostへ送る。human-tool-card.tsxのonAnsweredから呼ぶ。
 *  **戻り値がtrueなら、ランタイムのaddResultを呼んではいけない**——実Threadの
 *  待ちはhost側にあり、addResultはrunを新しく起こしてpartsを二重にする（上のcontinue参照）。 */
export async function sendRealAnswer(toolCallId: string, answer: string): Promise<boolean> {
  const judgmentId = judgmentIdByToolCallId.get(toolCallId);
  if (!judgmentId) return false;
  // 「許可し、以後この Project からは聞かない」（Project をまたぐメッセージの承認、§4.2）は、許可に「覚える」を添える
  const permissionResult =
    answer === "許可する"
      ? { behavior: "allow" as const }
      : answer === MESSAGE_ALLOW_REMEMBER
        ? { behavior: "allow" as const, remember: true }
        : { behavior: "deny" as const, message: answer };
  await answerRealInboxItem(judgmentId, permissionResult);
  const live = liveByJudgmentToolCallId.get(toolCallId);
  if (live) {
    // 答えを走っているrunのpartsに書き戻す——次にhostから何か届いたときの
    // yieldで「回答：許可する」として画面に出る。addResultの代わり。
    live.acc.finishTool(toolCallId, answer);
  }
  // 流れを読んでいないカードは無い（判断待ちは走っているターンの流れでだけ出る——改訂・2026-09-26）。
  // 読むのをやめたあとに答えても、続きは host が走らせ、終われば `turn.ended` で最新が出る
  // 決着したものは受信箱から消える（§2.4.1「解決済みは状態として持たない」）
  await refreshRealInbox();
  return true;
}

/**
 * **記録から会話を組み直す**（決定・2026-09-11）。Clear のように「もう走っていない
 * ところで記録が変わった」ときに使う。
 *
 * 組み直すと、会話の各発言が**host の物差し（seq）を持つ**——Clear の横線が
 * 起きた場所に出るのも、「ここから Fork」が出せるのも、これがあってこそ
 * （どちらも `real-<seq>` を鍵にしている）。
 *
 * **走行中には呼ばない**——流れている表示を壊す（呼ぶ側が `hasLiveRealRun` で見る）。
 */
export function rebuildThreadFromRecord(threadId: string): void {
  restoredSyncVersionByThread.set(threadId, restoredSyncVersion(threadId) + 1);
}
