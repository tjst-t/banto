// **AI が tool から Fork を立てる**（決定・2026-09-27、ユーザー。アーキ仕様 §2.2「AI が Fork を立てる」）。
//
// 人とやり取りしながら進める話が複数あるとき、AI が名前と最初の指示を付けて Fork を立て、並行して進める
// （人とのやり取りが要らないならサブエージェントでよい）。
//
// - **tool は予約を受けるだけ。Fork を作るのは、このターンが終わってから**。親の resume-point が記録に
//   載るのはターンの終わり（`updateResumePoint`）なので、呼ばれた時点で作ると、このターンの会話
//   （課題の分析・Fork を立てた理由）が Fork に入らない。途中のセッションから枝を分ける危うさも避けられる
// - **Base でも Fork でも立てられる**（改訂・2026-10-11、ユーザー「AI だけ制限があると混乱する」。以前は Base からだけ）。
//   人もサイドバーから Fork の Fork を作れる。連鎖は届けもののホップ（maxHop）と1ターン5本で止まる
// - 承認は特別扱いしない——その Thread の承認モードに従う（ユーザー決定・案A）
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { readOnlyCoreToolsOf, type ReadOnlyTurnShape } from "../relay/read-only.js";
import { z } from "zod";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadMessaging } from "../delivery/thread-messages.js";
import type { AutomationTools } from "../automation/tools.js";
import { ANSWER_DECISION_TOOL_NAME, type TurnDecisions } from "../automation/turn-decisions.js";
import {
  FINISH_MISSION_TOOL_NAME,
  SCHEDULE_FOLLOWUP_TOOL_NAME,
  START_MISSION_TOOL_NAME,
  type Missions,
} from "../mission/missions.js";
import { NOTIFY_TOOL_NAME, PATROL_NOTIFY_PER_RUN, type NotifyInput, type NotifyResult } from "../automation/patrol.js";
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
export const CLAUDE_USAGE_TOOL_NAME = "claude_usage";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const CLOSE_FORK_TOOL_NAME = "close_fork";
/** **自動化**（決定・2026-10-15、アーキ仕様 §4.3「人と AI の作り方」）。作る・変える・再開する・消すは必ず人に聞く */
export const CREATE_AUTOMATION_TOOL_NAME = "create_automation";
export const UPDATE_AUTOMATION_TOOL_NAME = "update_automation";
export const LIST_AUTOMATIONS_TOOL_NAME = "list_automations";
export const PAUSE_AUTOMATION_TOOL_NAME = "pause_automation";
export const RESUME_AUTOMATION_TOOL_NAME = "resume_automation";
export const REMOVE_AUTOMATION_TOOL_NAME = "remove_automation";
/**
 * 自動化の tool は Runner の承認（canUseTool）を通さない——作る・変える・再開する・消すは tool の中で必ず人に聞くので、
 * 承認モードで2回聞かない。一覧・一時停止は聞かない（§4.3）
 */
export const AUTOMATION_TOOL_NAMES = [
  CREATE_AUTOMATION_TOOL_NAME,
  UPDATE_AUTOMATION_TOOL_NAME,
  LIST_AUTOMATIONS_TOOL_NAME,
  PAUSE_AUTOMATION_TOOL_NAME,
  RESUME_AUTOMATION_TOOL_NAME,
  REMOVE_AUTOMATION_TOOL_NAME,
] as const;

const automationTimeShape = z
  .string()
  .describe("H:MM（24時間、例 9:00）");
const automationTimeSourceShape = z
  .object({
    kind: z.literal("time"),
    timeZone: z.string().describe("IANA のタイムゾーン（例 Asia/Tokyo）"),
    repeat: z.union([
      z.object({ kind: z.literal("daily"), time: automationTimeShape }),
      z.object({ kind: z.literal("weekdays"), time: automationTimeShape }),
      z.object({ kind: z.literal("weekly"), day: z.number().int().describe("0＝日曜〜6＝土曜"), time: automationTimeShape }),
      z.object({ kind: z.literal("interval"), hours: z.number().int().describe("1〜168 時間ごと") }),
      z.object({ kind: z.literal("cron"), expr: z.string().describe("5つの欄（分 時 日 月 曜日）。間隔は最短15分") }),
    ]),
  })
  .describe("決まった時刻");
const automationEventValueShape = z.union([z.string(), z.number(), z.boolean()]);
// **出来事**（追加・2026-10-16、アーキ仕様 §4.3「段2」）。名前と属性は Module の名乗り（Project ごとに違う）。名乗っていない名前を
// 渡すと、待てる出来事の一覧つきで断る
const automationEventSourceShape = z
  .object({
    kind: z.literal("event"),
    event: z
      .string()
      .describe(
        "待つ出来事の名前（<出どころ>.<名前>、例 service.crashed・factory.item-stopped・backlog.item-changed、banto 自身の banto.turn-decisions）。名乗っていない名前なら、待てる出来事の一覧つきで断られる",
      ),
    where: z
      .record(z.string(), z.union([automationEventValueShape, z.array(automationEventValueShape)]))
      .optional()
      .describe("条件：属性の名前ごとに、等しい値か値の配列（どれか）。省くと、その出来事が起きるたびに動く"),
    batchSeconds: z.number().int().optional().describe("続けて起きた出来事を1回にまとめる待ち時間（0〜300 秒、既定 30）"),
    allowSelfTriggered: z
      .boolean()
      .optional()
      .describe("この自動化自身の回が起こした出来事でも動くか（既定 false＝動かない。輪にならないように）"),
  })
  .describe("出来事が起きたとき");
const automationSourceShape = z
  .union([automationTimeSourceShape, automationEventSourceShape])
  .describe(
    "きっかけ。決まった時刻（time）か出来事（event）。Webhook は人が自動化の画面から作る。banto.turn-decisions を待つ自動化（判断役）の届け先は専用の Fork だけ",
  );
const automationTargetShape = z
  .union([
    z.object({
      kind: z.literal("dedicated"),
      mode: z.enum(["fresh", "continue"]).describe("fresh＝毎回まっさら（既定）、continue＝前の回を引き継ぐ"),
    }),
    z.object({ kind: z.literal("thread"), threadId: z.string().describe("この Project のいまある Thread の id") }),
  ])
  .describe("どの会話で動かすか。省くと専用の Fork で毎回まっさら");

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
  /** **自動化**（§4.3）。渡されなければ（試験の構成）、tool は見せたまま断る——構成で tool の一覧を変えない（§3） */
  automations?: AutomationTools,
  /** **判断役の答え**（§4.3「banto.turn-decisions と判断役」）。渡されなければ tool は見せたまま断る */
  decisions?: Pick<TurnDecisions, "answer">,
  /**
   * **Claude の使用量**（追加・2026-10-20、v4-security.md §2「AI が使用量を見る」）。この会話の Thread を渡すと、その
   * Project で使える全部のアカウントの使用量を返す。渡されなければ tool は見せたまま断る（§3）
   */
  claudeUsage?: (threadId: string) => string,
  /**
   * **読むだけの回**（追加・2026-10-20、アーキ仕様 §4.4 の守りの 2.）。サーバを読むだけの tool（`READ_ONLY_CORE_TOOLS`）だけで
   * 組む——人にカードを出す tool（`create_automation` 等）・Fork を立てる tool は、その回には存在しない
   */
  readOnly = false,
  /** **任務**（§4.4）。渡されなければ tool は見せたまま断る（構成で tool の一覧を変えない、§3）。読むだけの回には出さない */
  missions?: Pick<Missions, "start" | "scheduleFollowup" | "finish" | "reportTurnProblem">,
  /**
   * **見回りの `notify`**（追加・2026-10-20、アーキ仕様 §4.4「知らせる tool」）。見回りの Fork のターンにだけ渡す——渡さなければ
   * tool を見せない（見回りの Fork は毎回まっさらなので、一覧が変わってもキャッシュを引き継ぐ相手がいない）
   */
  patrol?: { notify(input: Partial<NotifyInput>): Promise<NotifyResult> },
  /**
   * **読むだけの回の形**（追加・2026-10-21、アーキ仕様 §4.4「見回りが消えたあとの Fork」）。見回りの自動化が消えたあとの見回りの
   * Fork なら、読むだけの tool に `close_fork` だけを足す
   */
  readOnlyShape: ReadOnlyTurnShape = {},
) {
  const unavailable = { content: [{ type: "text" as const, text: "この banto ではメッセージを送れません。" }], isError: true };
  const noAutomations = { content: [{ type: "text" as const, text: "この banto では自動化を扱えません。" }], isError: true };
  const noMissions = { content: [{ type: "text" as const, text: "この banto では任務を扱えません。" }], isError: true };
  const automationReply = (r: { ok: boolean; text: string }) => ({
    content: [{ type: "text" as const, text: r.text }],
    ...(r.ok ? {} : { isError: true }),
  });
  const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;
  const tools = [
      ...(patrol
        ? [
            tool(
              NOTIFY_TOOL_NAME,
              [
                "見回りで気づいたことを、人の受信箱の「気づき」に出す。人が読んで「やって」「任務にする」を決める。",
                `1回に ${PATROL_NOTIFY_PER_RUN} 件まで、1日の上限もある。同じことには同じ key を付ける——前に知らせた key は 7日の間は出し直されず、`,
                "人が「今後知らせない」にした key は出ない（そのときも断りではなく、その旨が返る）。何も無ければ呼ばない。",
              ].join(""),
              {
                key: z.string().describe("同じことかを見分ける短い名前（例 pr-123-ci-failed）"),
                title: z.string().describe("題（受信箱のカードの見出し、120 文字まで）"),
                finding: z.string().describe("気づいたこと"),
                evidence: z.string().optional().describe("根拠（ファイル・URL・ログの行の場所）"),
                suggestion: z.string().optional().describe("やるならこう（1〜2文）"),
                urgent: z.boolean().optional().describe("急ぎなら true（受信箱の気づきの先頭に寄る）"),
              },
              async (args) => automationReply(await patrol.notify(args)),
            ),
          ]
        : []),
      ...(turnSummary
        ? [
            tool(REPORT_TURN_TOOL_NAME, REPORT_TURN_DESCRIPTION, reportTurnShape, async (args) => {
              const problem = validateTurnSummary(args) ?? missions?.reportTurnProblem(threadId, args.decisions.length);
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
        CLAUDE_USAGE_TOOL_NAME,
        [
          "この Project で使える Claude のアカウント全部の使用量（5時間・週）・閾値・この会話がどのアカウントか。",
          "banto は会話ごとにアカウントを選び、閾値を越えたら次のアカウントへ移す——返事の見出し・Claude Code の警告・",
          "/usage で見えるのはいまの会話のアカウント1つだけなので、それだけで「使用量が足りない」と判断しない。",
          "使用量を理由に仕事を止める・減らす・人に知らせる前に、これを呼んで全体を見る。",
        ].join(""),
        {},
        async () => {
          if (!claudeUsage) return { content: [{ type: "text" as const, text: "この banto では Claude の使用量を読めません。" }], isError: true };
          return { content: [{ type: "text" as const, text: claudeUsage(threadId) }] };
        },
      ),
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
        LIST_AUTOMATIONS_TOOL_NAME,
        "この Project の自動化（決まった時刻・出来事で、決まった指示でこの Project の AI を動かす仕組み）の一覧。id・名前・きっかけ・届け先・一時停止か・直近の回の結果。",
        {},
        async () => (automations ? automationReply(automations.list(threadId)) : noAutomations),
      ),
      tool(
        CREATE_AUTOMATION_TOOL_NAME,
        [
          "自動化を作る：決まった時刻に、または Module や banto で出来事が起きたときに、決まった指示（instruction）でこの Project の AI を動かす。",
          "人が見ていない時間に繰り返し動くので、**作る前に必ず会話のカードで人に聞く**（承認モードに依らない）。人が断ったら作らない。",
          "既定では自動化の名前の専用の Fork が立ち、毎回まっさらな会話で指示が届く。",
          "指示は、その時刻に何も知らない AI が読んでも分かるように、要ることを全部書く。",
        ].join(""),
        {
          name: z.string().describe("名前（一覧と専用の Fork の名前になる短いもの）"),
          instruction: z.string().describe("毎回届ける指示"),
          source: automationSourceShape,
          target: automationTargetShape.optional(),
          reviewOnDone: z
            .boolean()
            .optional()
            .describe("完了した回を受信箱に出すか（既定 true）。判断待ち・決めること・失敗した回はいつも出す"),
          mode: z
            .enum(["normal", "patrol"])
            .optional()
            .describe(
              "patrol＝見回り：読むだけの tool で決めた対象を見て、気づいたことを受信箱の「気づき」に出す。届け先は専用の Fork（毎回まっさら）に決まり、完了した回は受信箱に出さない。作ったあと変えられない",
            ),
          dailyFindingLimit: z.number().int().optional().describe("見回りが1日に出せる気づきの上限（既定 10）"),
        },
        async (args, extra) =>
          automations ? automationReply(await automations.create(threadId, args, signalOf(extra))) : noAutomations,
      ),
      tool(
        UPDATE_AUTOMATION_TOOL_NAME,
        "この Project の自動化を変える。渡した欄だけ変わる。**変える前に必ず会話のカードで人に聞く**。人が断ったら変えない。",
        {
          id: z.string().describe("自動化の id（list_automations で分かる）"),
          name: z.string().optional(),
          instruction: z.string().optional(),
          source: automationSourceShape.optional(),
          target: automationTargetShape.optional(),
          reviewOnDone: z.boolean().optional(),
          dailyFindingLimit: z.number().int().optional().describe("見回りだけ：1日に出せる気づきの上限"),
        },
        async ({ id, ...changes }, extra) =>
          automations ? automationReply(await automations.update(threadId, id, changes, signalOf(extra))) : noAutomations,
      ),
      tool(
        PAUSE_AUTOMATION_TOOL_NAME,
        "この Project の自動化を一時停止する（台帳と専用の Fork は残る）。人には聞かない。",
        { id: z.string().describe("自動化の id（list_automations で分かる）") },
        async ({ id }) => (automations ? automationReply(await automations.pause(threadId, id)) : noAutomations),
      ),
      tool(
        RESUME_AUTOMATION_TOOL_NAME,
        "一時停止している自動化を再開する。**再開する前に必ず会話のカードで人に聞く**。人が断ったら一時停止のまま。",
        { id: z.string().describe("自動化の id（list_automations で分かる）") },
        async ({ id }, extra) =>
          automations ? automationReply(await automations.resume(threadId, id, signalOf(extra))) : noAutomations,
      ),
      tool(
        REMOVE_AUTOMATION_TOOL_NAME,
        "この Project の自動化を消す（台帳と直近の回の記録が消え、もう動かない。専用の Fork とその会話は残る）。**消すときも、消す前に必ず会話のカードで人に聞く**（承認モードに依らない）。人が断ったら消さない。止めるだけなら pause_automation。",
        { id: z.string().describe("自動化の id（list_automations で分かる）") },
        async ({ id }, extra) =>
          automations ? automationReply(await automations.remove(threadId, id, signalOf(extra))) : noAutomations,
      ),
      tool(
        START_MISSION_TOOL_NAME,
        [
          "この会話に任務（目標・終わりの条件・枠）を付ける。任務を持つ会話では、あなたは枠の中で自分を「あとでもう一度」起こせる（schedule_followup）——人が見ていない間も、CI が通るまで直す・残りの仕事を最後まで見る、のような終わりのある仕事を続けられる。",
          "人が見ていない時間に繰り返し動くので、**始める前に必ず会話のカードで人に聞く**（承認モードに依らない）。人は枠を変えてから答えられる。人が断ったら始めない。",
          "1つの会話に動いている任務は1つまで。枠：起きる回数の上限（既定 20、最大 100）・期限（既定 3日、最長 14日）・最短の間隔（既定 15分、15分より短くはできない）。",
        ].join(""),
        {
          goal: z.string().describe("目標（何を達成するか。あとで起きた自分が読んで分かるように具体的に）"),
          doneWhen: z.string().describe("終わりの条件（何を確かめたら finish_mission で終えるか）"),
          maxWakes: z.number().int().optional().describe("起きる回数の上限（1〜100、既定 20）"),
          until: z.string().optional().describe("期限（ISO 8601 の時刻。始めてから 14日まで、既定 3日後）"),
          minInterval: z.number().int().optional().describe("最短の間隔（分。15 以上、既定 15）——前に任務で起きた時刻からの間"),
        },
        async (args, extra) => {
          if (!missions) return noMissions;
          return automationReply(await missions.start(threadId, args, signalOf(extra)));
        },
      ),
      tool(
        SCHEDULE_FOLLOWUP_TOOL_NAME,
        [
          "任務を持つ会話で、次に自分を起こす予約をする。at（時刻）・after（何分後）・event（待つ出来事）のどれか1つと、note（次に起きたら何を確かめるか）を渡す。",
          "枠の中なら人に聞かずに通る。枠の外（回数を使い切った・期限より後・前に起きた時刻から最短の間隔より短い）は断られる——枠を延ばせるのは人だけなので、そのときは report_turn の decisions で人に聞く。",
          "予約は1つだけで、新しく予約すると前の予約は置き換わる。予約したらこのターンは終えてよい。任務を続ける間、予約も finish_mission も無いままターンは終えられない。",
          "event は自動化と同じ出来事（<出どころ>.<名前>、この Project の Module の出来事と banto の出来事）。来なければ待つ上限（既定は任務の期限）で「来ませんでした」として起こす。",
        ].join(""),
        {
          at: z.string().optional().describe("起こす時刻（ISO 8601）"),
          after: z.number().optional().describe("今から何分後に起こすか"),
          event: z
            .object({
              name: z.string().describe("待つ出来事の名前（例 service.crashed・banto.turn-decisions）。名乗っていない名前なら、待てる出来事の一覧つきで断られる"),
              where: z
                .record(z.string(), z.union([automationEventValueShape, z.array(automationEventValueShape)]))
                .optional()
                .describe("条件：属性の名前ごとに、等しい値か値の配列（どれか）"),
              until: z.string().optional().describe("待つ上限（ISO 8601。既定と最長は任務の期限）"),
            })
            .optional()
            .describe("待つ出来事"),
          note: z.string().describe("次に起きたら何を確かめるか。起きたときにそのまま渡される"),
        },
        async (args) => (missions ? automationReply(await missions.scheduleFollowup(threadId, args)) : noMissions),
      ),
      tool(
        FINISH_MISSION_TOOL_NAME,
        "この会話の任務を終える。終わりの条件を満たした（done）か、続けても達成できないと分かった（gave-up）とき。人の承認は要らない。受信箱に結末が出る。",
        {
          status: z.enum(["done", "gave-up"]).describe("done＝終わりの条件を満たした／gave-up＝あきらめた"),
          result: z.string().describe("結果（何を確かめ、どうなったか。あきらめたなら理由）。受信箱のカードに出る"),
        },
        async (args) => (missions ? automationReply(await missions.finish(threadId, args)) : noMissions),
      ),
      tool(
        ANSWER_DECISION_TOOL_NAME,
        [
          "判断役として、別の会話の AI がターンのまとめで人に聞いた「決めること」に答える。答えられるのは、このターンに届いた出来事 banto.turn-decisions の会話（属性 thread）とターン（属性 turnId）だけ。",
          "問いごとに1回呼ぶ。答えは、元の AI が出した選択肢の番号（choice、1 から）か、人に任せる（defer: true）のどちらか——自由な文は送れない。",
          "全部の問いに選択肢で答えが揃ったら、まとめて1回で元の会話に届き、元の会話の AI がそれで続ける。1問でも人に任せたら全部人に回り、何も届かない。",
          "元の会話がもう進んでいたら（人が答えた・次のターンが始まった）断られる。迷ったら人に任せる。",
          "任務の枠（起きる回数・期限・間隔）を延ばすかの問いは、いつも人に任せる（defer: true）——枠を延ばせるのは人だけ。",
        ].join(""),
        {
          thread: z.string().describe("出来事の属性 thread（元の会話の id）"),
          turnId: z.string().describe("出来事の属性 turnId"),
          question: z.number().int().describe("問いの番号（出来事の text の decisions[].number、1 から）"),
          choice: z.number().int().optional().describe("選ぶ選択肢の番号（options[].number、1 から）。defer と一緒には使わない"),
          defer: z.boolean().optional().describe("true なら、自分で決めずに人に任せる"),
          reason: z.string().describe("そう答えた理由（1〜2文）。受信箱のカードに出る"),
        },
        async (args) => {
          if (!decisions) return { content: [{ type: "text" as const, text: "この banto では判断役の答えを受けられません。" }], isError: true };
          if (args.defer === true && args.choice !== undefined) {
            return { content: [{ type: "text" as const, text: "choice と defer は一緒に使えません。どちらか一方にしてください。" }], isError: true };
          }
          return automationReply(await decisions.answer(threadId, args));
        },
      ),
      tool(
        FORK_TOOL_NAME,
        [
          "Fork Thread を立て、名前と最初の指示を与えて並行して進める。人とやり取りしながら進める話が複数あるときに使う",
          "（人とのやり取りが要らない仕事ならサブエージェントでよい）。",
          "Fork はこのターンが終わってから立ち、ここまでの会話と Memory を引き継いで、最初の指示で自動で始まる。",
          `Base Thread でも Fork Thread でも使える。1ターンに ${MAX_FORKS_PER_CALL} つまで。`,
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
  ];
  const readOnlyNames = readOnlyCoreToolsOf(FORK_SERVER_NAME, readOnlyShape);
  return createSdkMcpServer({
    name: FORK_SERVER_NAME,
    // 遅延ロードの裏に隠すと自発的に使われない（memory-tool.ts と同じ理由）
    alwaysLoad: true,
    tools: readOnly ? tools.filter((t) => readOnlyNames.includes(t.name)) : tools,
  });
}
