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
) {
  const unavailable = { content: [{ type: "text" as const, text: "この banto ではメッセージを送れません。" }], isError: true };
  return createSdkMcpServer({
    name: FORK_SERVER_NAME,
    // 遅延ロードの裏に隠すと自発的に使われない（memory-tool.ts と同じ理由）
    alwaysLoad: true,
    tools: [
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
