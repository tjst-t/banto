// **管理対象 Project の Thread を読む**（追加・2026-10-23、アーキ仕様 §4.6「読む——Thread 全体を、人が見るのと同じ範囲で」）。
//
// §4.2 の `list_threads` は宛先の一覧だけで中身を読まない。ここはその境界を**メタ Project の専用 Fork に限って**外す口：
//
// - **読めるのは、人が画面で見るのと同じ範囲**——発言・画面つき tool の呼び出しと結果・会話のカード（承認待ち・判断待ち）・
//   ターンのまとめ・区切り（Clear・要約）、走っているターンなら途中の tool 呼び出しと結果。形は人の画面の
//   `GET /api/threads/:id`（`toThreadDetail`）に近い
// - **書き換える口ではない**。承認に答える・Vault の値を見る力は含まない（書くのは `send_message` の新規メッセージだけ）。
//   判断待ちは中身と状態を見せるだけで、答えの口は渡さない
// - **誰がどの Project を読めるかは host が決める**（`readableProjectOf`）。AI の引数では決めない。決まらない Thread には
//   tool を見せない
// - 走行の内部事情（resume-point・札・セッション・使用量）は人の画面にも出さないので、ここでも返さない

import type { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import { judgmentAnswerText } from "../inbox/answer-text.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { MessageEntry, ThreadMarkerEntry } from "../project-thread/types.js";
import type { TurnStreamEvent } from "../http/turn-runner.js";
import { threadLabel, type ThreadActivity } from "./thread-messages.js";

/** 1回に返す件数の既定と上限（発言・区切りを合わせた数） */
export const READ_THREAD_DEFAULT_LIMIT = 30;
export const READ_THREAD_MAX_LIMIT = 100;
/** tool の引数・結果・届いた本文は、これより長ければ切る（文脈を1つの呼び出しで埋めない） */
export const READ_THREAD_VALUE_MAX_CHARS = 4000;
/** 発言の本文は、これより長ければ切る */
export const READ_THREAD_TEXT_MAX_CHARS = 20000;

export interface ReadThreadRequest {
  threadId: string;
  /** この seq より後ろだけ（差分を読む）。古い順に `limit` 件 */
  afterSeq?: number;
  /** この seq より前だけ（遡って読む）。新しいほうから `limit` 件 */
  beforeSeq?: number;
  limit?: number;
}

/** 会話のカード（判断待ち）。人の画面に出るものと同じ中身。**答える口ではない** */
export interface ReadJudgment {
  id: string;
  message: string;
  serverName?: string;
  toolInput?: unknown;
  choices?: string[];
  liveness: JudgmentItem["liveness"];
  answer?: string;
}

/** tool の呼び出し1件（画面つき tool の記録、または走っているターンの途中経過） */
export interface ReadToolCall {
  id: string;
  name: string;
  input?: unknown;
  /** 結果。まだ返っていなければ無い */
  result?: unknown;
  isError?: true;
}

export type ReadThreadEntry =
  | {
      type: "message";
      seq: number;
      role: "user" | "assistant";
      text: string;
      /** 機械から届いたもの（無ければ人の発言） */
      from?: { name: string; title: string; sender?: { projectName: string; threadLabel: string; threadId: string } };
      /** 外から来た本文（Webhook・出来事）。人の画面と同じく本文も見せる */
      external?: Array<{ source: string; title?: string; body: string }>;
      images?: number;
      quotes?: Array<{ module: string; text: string }>;
      toolCalls?: ReadToolCall[];
      judgments?: ReadJudgment[];
      turnSummary?: Record<string, unknown>;
    }
  | { type: "clear"; seq: number }
  | { type: "compact"; seq: number; reason: string };

export interface ReadThreadView {
  projectId: string;
  projectName: string;
  threadId: string;
  label: string;
  kind: "base" | "fork";
  state: ThreadActivity;
  entries: ReadThreadEntry[];
  /** これより前にもある（`beforeSeq` に `entries[0].seq` を渡して遡る） */
  hasOlder: boolean;
  /** これより後ろにもある（`afterSeq` に最後の seq を渡して続きを読む） */
  hasNewer: boolean;
  /** 次に差分を読むときの `afterSeq`（この呼び出しで見えた最後の seq。何も無ければ渡した値） */
  lastSeq?: number;
  /** まだ答えのついていない判断待ち（会話のカードのうち、いま人を待っているもの） */
  waitingJudgments: ReadJudgment[];
  /** 走っているターンの途中経過（記録に入る前の tool 呼び出しと結果、出た判断待ち） */
  runningTurn?: { startedAt: string; toolCalls: ReadToolCall[]; judgmentIds: string[] };
}

export type ReadThreadResult = { ok: true; view: ReadThreadView } | { ok: false; text: string };

export interface ThreadReadingDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  /**
   * **その Thread が中身を読んでよい Project**（アーキ仕様 §4.6「メタ Project の構成」——メタ Project の専用 Fork なら、
   * 対応する管理対象 Project）。無ければ読めない（tool も見せない）。host の記録だけから決める
   */
  readableProjectOf(fromThreadId: string): string | undefined;
  /** 走っているターンの途中経過（`TurnEventBus.snapshot`）。渡されなければ記録だけ返す */
  liveTurn?(threadId: string): { events: TurnStreamEvent[]; startedAt: string } | undefined;
  /** ターンが走っているか（`ThreadTurns.isRunning`） */
  isRunning?(threadId: string): boolean;
}

export class ThreadReading {
  constructor(private readonly deps: ThreadReadingDeps) {}

  /** その Thread が読める Project（無ければ `read_thread` を見せない） */
  scopeOf(fromThreadId: string): string | undefined {
    return this.deps.readableProjectOf(fromThreadId);
  }

  /** 読む。**断る理由は文で返す**——AI が読んで直せるように */
  read(fromThreadId: string, req: ReadThreadRequest): ReadThreadResult {
    const store = this.deps.projectThread;
    const scope = this.deps.readableProjectOf(fromThreadId);
    if (!scope) return { ok: false, text: "この Thread からは、ほかの Thread の中身は読めません（読めるのはメタ Project の専用 Fork だけです）。" };
    const target = store.getThread(req.threadId);
    // 範囲の外の Thread は「無い」と同じ答えにする——ほかの Project の Thread の有無を、この口から探らせない
    if (!target || target.projectId !== scope) {
      return { ok: false, text: `Thread ${req.threadId} は読めません（読めるのは、この Fork が受け持つ Project の Thread だけです。list_threads で確かめてください）。` };
    }
    const project = store.getProject(target.projectId);
    if (!project) return { ok: false, text: "その Thread の Project が見つかりません。" };
    const limit = Math.min(Math.max(Math.trunc(req.limit ?? READ_THREAD_DEFAULT_LIMIT), 1), READ_THREAD_MAX_LIMIT);
    if (req.afterSeq !== undefined && req.beforeSeq !== undefined) {
      return { ok: false, text: "afterSeq と beforeSeq は同時に指せません。" };
    }

    const all: Array<MessageEntry | ThreadMarkerEntry> = [...target.messages, ...target.markers].sort((a, b) => a.seq - b.seq);
    let picked: Array<MessageEntry | ThreadMarkerEntry>;
    let hasOlder: boolean;
    let hasNewer: boolean;
    if (req.afterSeq !== undefined) {
      const after = all.filter((e) => e.seq > req.afterSeq!);
      picked = after.slice(0, limit);
      hasNewer = after.length > limit;
      hasOlder = all.length > after.length;
    } else {
      const before = req.beforeSeq !== undefined ? all.filter((e) => e.seq < req.beforeSeq!) : all;
      picked = before.slice(-limit);
      hasOlder = before.length > limit;
      hasNewer = before.length < all.length;
    }

    const waitingJudgments = this.deps.inbox
      .listOpen()
      .filter((i): i is JudgmentItem => i.kind === "judgment" && i.threadId === target.id && i.liveness === "live")
      .map(readJudgment);
    const running = this.deps.isRunning?.(target.id) === true;
    const live = this.deps.liveTurn?.(target.id);
    const lastSeq = picked.at(-1)?.seq ?? req.afterSeq;
    return {
      ok: true,
      view: {
        projectId: project.id,
        projectName: project.name,
        threadId: target.id,
        label: threadLabel(target),
        kind: target.kind,
        state: target.status === "closed" ? "closed" : waitingJudgments.length > 0 ? "waitingOnHuman" : running || live ? "running" : "idle",
        entries: picked.map((e) => this.entryOf(e)),
        hasOlder,
        hasNewer,
        ...(lastSeq !== undefined ? { lastSeq } : {}),
        waitingJudgments,
        ...(live ? { runningTurn: liveTurnOf(live) } : {}),
      },
    };
  }

  private entryOf(e: MessageEntry | ThreadMarkerEntry): ReadThreadEntry {
    if (!("role" in e)) return e.kind === "clear" ? { type: "clear", seq: e.seq } : { type: "compact", seq: e.seq, reason: e.reason };
    const judgments = (e.judgmentIds ?? []).flatMap((id) => {
      const item = this.deps.inbox.get(id);
      return item?.kind === "judgment" ? [readJudgment(item)] : [];
    });
    const origin = e.origin;
    return {
      type: "message",
      seq: e.seq,
      role: e.role,
      text: clipText(e.text),
      ...(origin
        ? {
            from: {
              name: origin.from,
              title: origin.title,
              ...(origin.sender
                ? { sender: { projectName: origin.sender.projectName, threadLabel: origin.sender.threadLabel, threadId: origin.sender.threadId } }
                : {}),
            },
          }
        : {}),
      ...(origin?.external && origin.external.length > 0
        ? {
            external: origin.external.map((x) => ({
              source: x.source,
              ...(x.event ? { title: x.event.title } : {}),
              body: clipText(x.body, READ_THREAD_VALUE_MAX_CHARS),
            })),
          }
        : {}),
      ...(e.images && e.images.length > 0 ? { images: e.images.length } : {}),
      ...(e.quotes && e.quotes.length > 0 ? { quotes: e.quotes.map((q) => ({ module: q.module, text: clipText(q.text, READ_THREAD_VALUE_MAX_CHARS) })) } : {}),
      ...(e.uiToolCalls && e.uiToolCalls.length > 0
        ? {
            toolCalls: e.uiToolCalls.map((c) => ({
              id: c.toolCallId,
              name: c.toolName,
              ...(c.args !== undefined ? { input: clipValue(c.args) } : {}),
              ...(c.result !== undefined ? { result: clipValue(c.result) } : {}),
            })),
          }
        : {}),
      ...(judgments.length > 0 ? { judgments } : {}),
      ...(e.turnSummary ? { turnSummary: e.turnSummary.summary } : {}),
    };
  }
}

function readJudgment(item: JudgmentItem): ReadJudgment {
  return {
    id: item.id,
    message: item.message,
    ...(item.serverName ? { serverName: item.serverName } : {}),
    ...(item.toolInput !== undefined ? { toolInput: clipValue(item.toolInput) } : {}),
    ...(item.choices ? { choices: item.choices } : {}),
    liveness: item.liveness,
    ...(item.liveness === "answered" ? { answer: judgmentAnswerText(item.answer, item.choices) } : {}),
  };
}

interface RawBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** 走っているターンの途中経過から、tool の呼び出しと結果を組む（画面の `applyMessage` と同じ読み方） */
function liveTurnOf(live: { events: TurnStreamEvent[]; startedAt: string }): NonNullable<ReadThreadView["runningTurn"]> {
  const calls = new Map<string, ReadToolCall>();
  const judgmentIds: string[] = [];
  for (const event of live.events) {
    if (event.type === "judgment") {
      judgmentIds.push(event.judgmentId);
      continue;
    }
    if (event.type !== "message") continue;
    const raw = event.message as { type?: string; message?: { content?: unknown } };
    const content = Array.isArray(raw.message?.content) ? (raw.message.content as RawBlock[]) : [];
    if (raw.type === "assistant") {
      for (const b of content) {
        if (b.type === "tool_use" && b.id && b.name) calls.set(b.id, { id: b.id, name: b.name, ...(b.input !== undefined ? { input: clipValue(b.input) } : {}) });
      }
    } else if (raw.type === "user") {
      for (const b of content) {
        const call = b.type === "tool_result" && b.tool_use_id ? calls.get(b.tool_use_id) : undefined;
        if (!call) continue;
        call.result = clipValue(b.content);
        if (b.is_error) call.isError = true;
      }
    }
  }
  return { startedAt: live.startedAt, toolCalls: [...calls.values()], judgmentIds };
}

function clipText(text: string, max = READ_THREAD_TEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…（${text.length - max} 文字を省略）` : text;
}

/** 長い値は JSON の頭だけにする（形が分かれば足りる。全部要るなら人の画面で見る） */
function clipValue(value: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return "（JSON にできない値）";
  }
  if (json === undefined || json.length <= READ_THREAD_VALUE_MAX_CHARS) return value;
  return { truncated: true, chars: json.length, head: json.slice(0, READ_THREAD_VALUE_MAX_CHARS) };
}
