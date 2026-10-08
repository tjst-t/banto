// **AI が tool から Fork を立てる**（決定・2026-09-27、ユーザー。アーキ仕様 §2.2「AI が Fork を立てる」）。
//
// 人とやり取りしながら進める話が複数あるとき、AI が名前と最初の指示を付けて Fork を立て、並行して進める
// （人とのやり取りが要らないならサブエージェントでよい）。
//
// - **tool は予約を受けるだけ。Fork を作るのは、このターンが終わってから**。親の resume-point が記録に
//   載るのはターンの終わり（`updateResumePoint`）なので、呼ばれた時点で作ると、このターンの会話
//   （課題の分析・Fork を立てた理由）が Fork に入らない。途中のセッションから枝を分ける危うさも避けられる
// - **Fork の中からは立てられない**（ユーザー決定——Fork から Fork は画面にも無い）。ただし tool は
//   Base でも Fork でも同じものを見せる。tool の一覧はキャッシュの先頭に入るので、Base と Fork で変えると
//   Fork が親のキャッシュを引き継げなくなる（§3）。Fork で呼ばれたら断る
// - 承認は特別扱いしない——その Thread の承認モードに従う（ユーザー決定・案A）
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadMessaging } from "../delivery/thread-messages.js";
import { backgroundItemsOf, type BackgroundItem } from "./app-events.js";
import {
  REPORT_TURN_ACCEPTED_TEXT,
  REPORT_TURN_DESCRIPTION,
  REPORT_TURN_TOOL_NAME,
  reportTurnShape,
  validateTurnSummary,
  type TurnSummaryEntry,
  type TurnSummaryState,
} from "./turn-summary.js";

/**
 * **ターンの終わりのまとめ**（決定・2026-10-06、`turn-summary.ts`）。スイッチがオンの Project のターンだけ渡す——渡さなければ
 * tool を見せない（オンオフは Project ごとなので、Base と Fork で一覧は食い違わない）
 */
export interface TurnSummaryTool {
  state: TurnSummaryState;
  /** 受け付けたまとめを会話の記録に残す */
  record(entry: TurnSummaryEntry): Promise<void>;
  now?(): Date;
}

/** 1回に立てられる数（仮置き・2026-09-27）。3つ並行が想定の典型で、それを少し超える余裕 */
export const MAX_FORKS_PER_CALL = 5;

export interface ForkRequest {
  title: string;
  instruction: string;
}

export const FORK_SERVER_NAME = "banto-thread";
export const FORK_TOOL_NAME = "start_forks";
export const LIST_THREADS_TOOL_NAME = "list_threads";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const CLOSE_FORK_TOOL_NAME = "close_fork";

/**
 * **AI が自分の Fork を閉じる予約**（決定・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。tool は理由を
 * ここに置くだけ——閉じるのはターンが最後まで終わってから（turn-runner）。2回呼ばれたら最後の理由
 */
export interface CloseForkReservation {
  reason?: string;
  settled?: boolean;
}

/** 残っている裏の仕事を1行ずつ（題・Module 名）。題が無ければ tool の名前 */
export function describeBackgroundItems(items: readonly BackgroundItem[]): string {
  return items.map((i) => `- 「${i.title ?? i.toolName ?? "（題なし）"}」（${i.module}）`).join("\n");
}

/**
 * **閉じなかったとき、そのターンの会話に残す印**（決定・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）。
 * 受信箱には出さない——閉じなかったことはその Fork の会話で分かれば足りる。`STOPPED_NOTE` と同じ括弧書き
 */
export const CLOSE_FORK_DROPPED_NOTE = "この Fork を閉じるのをやめました";

/** 閉じなかった印の文。`items` があれば、予約のあとに頼んだ裏の仕事が残っていたため */
export function closeForkDroppedNote(reason: string, items?: readonly BackgroundItem[]): string {
  if (items && items.length > 0) {
    const titles = items.map((i) => `「${i.title ?? i.toolName ?? "（題なし）"}」`).join("、");
    return `（${CLOSE_FORK_DROPPED_NOTE}——閉じると予約したあとで裏の仕事を頼んだため。残っている仕事：${titles}。予約の理由：${reason}）`;
  }
  return `（${CLOSE_FORK_DROPPED_NOTE}——ターンが途中で終わったため。予約の理由：${reason}）`;
}

/**
 * 閉じてよいかを確かめる。**断る理由を文で返す**。通れば `undefined`。呼ばれたときと、実際に閉じる直前の2回使う
 */
export function validateCloseFork(store: ProjectThreadStore, threadId: string): string | undefined {
  const thread = store.getThread(threadId);
  if (!thread) return "この Thread が見つかりません。";
  if (thread.kind !== "fork") {
    return "Base Thread は閉じられません（閉じられるのは、いま話している Fork Thread 自身だけです）。";
  }
  const items = backgroundItemsOf(thread.awaitingReplies);
  if (items.length > 0) {
    return [
      "この Fork が頼んだ裏の仕事がまだ残っているので、閉じられません。閉じても仕事は止まらず、結果は閉じた Fork に溜まるだけで誰も読みません。",
      "止めるか、引き継ぎ先へ send_message で送ってから、もう一度閉じてください。残っている仕事：",
      describeBackgroundItems(items),
    ].join("\n");
  }
  return undefined;
}

/**
 * 呼ばれた内容を確かめる。**断る理由を文で返す**（AI が読んで直せるように）。通れば `undefined`
 */
export function validateForkRequests(
  store: ProjectThreadStore,
  threadId: string,
  forks: readonly ForkRequest[],
  alreadyReserved: number,
): string | undefined {
  const thread = store.getThread(threadId);
  if (!thread) return "この Thread が見つかりません。";
  if (thread.kind === "fork") {
    return "Fork Thread の中からは Fork を立てられません（Base Thread からだけ立てられます）。人に Base Thread で頼むよう伝えてください。";
  }
  if (forks.length === 0) return "立てる Fork が1つもありません。";
  if (alreadyReserved + forks.length > MAX_FORKS_PER_CALL) {
    return `1ターンに立てられる Fork は ${MAX_FORKS_PER_CALL} つまでです（このターンで予約済み ${alreadyReserved}）。`;
  }
  const titles = forks.map((f) => f.title.trim());
  if (titles.some((t) => t === "")) return "名前（title）が空の Fork があります。";
  if (forks.some((f) => f.instruction.trim() === "")) return "最初の指示（instruction）が空の Fork があります。";
  if (new Set(titles).size !== titles.length) return "同じ名前の Fork が並んでいます。見分けられる名前にしてください。";
  return undefined;
}

/**
 * Fork の最初のメッセージ（届いたものとして AI に渡る本文）。**担当をはっきりさせる**——同時に立てた
 * ほかの Fork の名前と担当も添えて、同じ作業に手を出さないようにする
 */
export function composeForkInstruction(
  self: ForkRequest,
  siblings: readonly ForkRequest[],
  parentLabel: string,
): string {
  const others = siblings.filter((s) => s !== self);
  return [
    `あなたは、${parentLabel} の AI が立てた Fork「${self.title.trim()}」です。ここまでの会話は親から引き継いでいます。`,
    "",
    "この Fork の担当：",
    self.instruction.trim(),
    ...(others.length > 0
      ? [
          "",
          "同時に立てたほかの Fork（それぞれ別に進んでいます。担当に手を出さないでください）：",
          ...others.map((o) => `- 「${o.title.trim()}」：${oneLine(o.instruction)}`),
        ]
      : []),
    "",
    "人とのやり取りは、この Fork の中で行ってください。",
  ].join("\n");
}

function oneLine(text: string, max = 120): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * core 自身の MCP サーバ（`banto-memory` と同じく in-process）。`reserve` はこのターンの予約の入れ物
 * ——ターンの終わりに turn-runner が取り出して Fork を立てる
 */
export function createForkMcpServer(
  store: ProjectThreadStore,
  threadId: string,
  reserved: ForkRequest[],
  /**
   * **Thread 間・Project 間のメッセージ**（決定・2026-10-01、アーキ仕様 §4.2）。渡されなければ（試験の構成）、
   * tool は見せたまま断る——構成で tool の一覧を変えない（§3）
   */
  messaging?: ThreadMessaging,
  turnSummary?: TurnSummaryTool,
  /** このターンの「閉じる」の予約の入れ物——ターンの終わりに turn-runner が見て閉じる */
  closing: CloseForkReservation = {},
) {
  const unavailable = { content: [{ type: "text" as const, text: "この banto ではメッセージを送れません。" }], isError: true };
  return createSdkMcpServer({
    name: FORK_SERVER_NAME,
    // 遅延ロードの裏に隠すと自発的に使われない（memory-tool.ts と同じ理由）
    alwaysLoad: true,
    tools: [
      ...(turnSummary
        ? [
            tool(REPORT_TURN_TOOL_NAME, REPORT_TURN_DESCRIPTION, reportTurnShape, async (args) => {
              const problem = validateTurnSummary(args);
              if (problem) return { content: [{ type: "text" as const, text: problem }], isError: true };
              const entry: TurnSummaryEntry = { summary: args, at: (turnSummary.now?.() ?? new Date()).toISOString() };
              // **2回呼ばれたら最後の1回**（画面も記録も後ろのものを出す）
              turnSummary.state.accepted = entry;
              await turnSummary.record(entry);
              return { content: [{ type: "text" as const, text: REPORT_TURN_ACCEPTED_TEXT }] };
            }),
          ]
        : []),
      tool(
        LIST_THREADS_TOOL_NAME,
        [
          "メッセージの宛先になる Thread の一覧（Project・Thread の id と名前、Base か Fork か、状態）。",
          "会話の中身は見えない。既定はこの Project だけ、allProjects でほかの Project も。",
        ].join(""),
        {
          allProjects: z.boolean().optional().describe("true ならほかの Project の Thread も並べる"),
        },
        async ({ allProjects }) => {
          if (!messaging) return unavailable;
          const list = messaging.listThreads(threadId, allProjects === true);
          return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
        },
      ),
      tool(
        SEND_MESSAGE_TOOL_NAME,
        [
          "別の Thread（この Project の Base・Fork、またはほかの Project）の AI にメッセージを送る。届いたら相手の AI が起きる。",
          "宛先は threadId（と projectId）で指す。threadId を省き projectId だけ指すと、その Project に会話を引き継がない新しい Fork を立てて届ける。",
          "相手には送り元（この Thread）が伝わり、返事はこの Thread に届く。届いたメッセージに返すときは、その送り元の projectId・threadId を指す。",
          "ほかの Project へ送るときは、人の承認を待つことがある。",
        ].join(""),
        {
          projectId: z.string().optional().describe("宛先の Project の id（list_threads で分かる）"),
          threadId: z
            .string()
            .optional()
            .describe("宛先の Thread の id。省くと projectId の Project に新しい Fork を立てて届ける"),
          title: z.string().describe("題。相手の画面と受信箱に出る1行（新しい Fork を立てるときはその名前）"),
          text: z.string().describe("本文。相手はこちらの会話を見られないので、要ることを全部書く"),
        },
        async ({ projectId, threadId: to, title, text }, extra) => {
          if (!messaging) return unavailable;
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
          const result = await messaging.send(
            threadId,
            { ...(projectId ? { projectId } : {}), ...(to ? { threadId: to } : {}), title, text },
            signal,
          );
          return { content: [{ type: "text", text: result.text }], ...(result.ok ? {} : { isError: true }) };
        },
      ),
      tool(
        CLOSE_FORK_TOOL_NAME,
        [
          "いま話しているこの Fork Thread を閉じる。仕事を引き継いだ・担当を終えたときに使う。人の承認は要らない。",
          "閉じるのはこのターンが最後まで終わってから（人への返事はこのあとに書いてよい）。report_turn を呼ぶならそれより前に呼ぶ（report_turn でターンが終わるため）。",
          "閉じても会話と Memory は残り、人は履歴から開き直せる。Base Thread では使えない。",
          "この Fork が頼んだ裏の仕事（返事を待っているサブエージェント・コマンド・Factory など）が残っていると断る——止めるか、引き継ぎ先へ送ってから呼ぶ。",
        ].join(""),
        {
          reason: z.string().describe("閉じる理由（1行）。閉じた Fork の一覧に「AI が閉じました」と一緒に出る"),
        },
        async ({ reason }) => {
          const line = reason.trim().replace(/\s+/g, " ");
          if (line === "") return { content: [{ type: "text" as const, text: "閉じる理由（reason）が空です。" }], isError: true };
          const problem = validateCloseFork(store, threadId);
          if (problem) return { content: [{ type: "text" as const, text: problem }], isError: true };
          closing.reason = line;
          return {
            content: [
              {
                type: "text" as const,
                text: "受け付けた。このターンが終わったらこの Fork を閉じる。人への返事・report_turn はこのあとに。",
              },
            ],
          };
        },
      ),
      tool(
        FORK_TOOL_NAME,
        [
          "Fork Thread を立て、名前と最初の指示を与えて並行して進める。人とやり取りしながら進める話が複数あるときに使う",
          "（人とのやり取りが要らない仕事ならサブエージェントでよい）。",
          "Fork はこのターンが終わってから立ち、ここまでの会話と Memory を引き継いで、最初の指示で自動で始まる。",
          `Base Thread からだけ使える。1ターンに ${MAX_FORKS_PER_CALL} つまで。`,
        ].join(""),
        {
          forks: z
            .array(
              z.object({
                title: z.string().describe("Fork の名前（人が一覧で見分ける短い名前）"),
                instruction: z
                  .string()
                  .describe("その Fork の AI への最初の指示。何を担当し、どこまでやるか"),
              }),
            )
            .describe("立てる Fork。1回の呼び出しで複数立てられる"),
        },
        async ({ forks }) => {
          const problem = validateForkRequests(store, threadId, forks, reserved.length);
          if (problem) return { content: [{ type: "text", text: problem }], isError: true };
          reserved.push(...forks.map((f) => ({ title: f.title.trim(), instruction: f.instruction.trim() })));
          const names = forks.map((f) => `「${f.title.trim()}」`).join("");
          return {
            content: [
              {
                type: "text",
                text: `受け付けた。このターンが終わったら Fork ${names}を立て、それぞれ最初の指示で始める。人には、立てた Fork を開けば進み具合が見えると伝えてよい。`,
              },
            ],
          };
        },
      ),
    ],
  });
}
