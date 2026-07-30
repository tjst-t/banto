/**
 * worker-report: 職人（別プロセス）に「起動元へ報告・質問する口」を渡す pi Extension。
 * ADR-0010 決定29・27b。
 *
 * 職人は Worker Pool とは別プロセスなので、Tool を渡すには拡張か到達可能なエンドポイントが
 * 要る（決定29e）。ここは Kobo の banto-executor と同じ手を使い、拡張から Worker Pool の
 * HTTP 面（決定27b の `{baseUrl}/tools/{Tool名}`）を叩く。
 *
 * 使い方: pi -e ./packages/banto-worker-pool/src/pi-extension/worker-report.ts
 *
 * 環境変数:
 *   BANTO_WORKER_POOL_URL - Worker Pool の到達先（必須）
 *   BANTO_PROJECT         - 自分の projectTag（必須）
 *   BANTO_TASK_ID         - 自分の taskId（必須）
 *
 * 職人は自分の sessionId を知らない——sessionId はランタイムが起動後に決めるため子プロセスへ
 * 環境変数で渡せない。代わりに projectTag + taskId で名乗る（台帳のキーと同じ組で一意）。
 *
 * D5: ここに判断は無い。名乗りを足して転送するだけで、報告の意味は起動元が解釈する。
 * D6: node 標準（fetch）のみ。pi の型は import しない——実行時に pi が渡してくる。
 * I2: 設定不足・HTTPの失敗は握りつぶさず、職人に見える形で返す。
 */

import { MODULE_TOOL_PATH } from "@banto/core";

/** 論理名 → wire名（決定22）。ドットを通さないプロバイダがあるため職人側でも変換する。 */
function toWireName(logical: string): string {
  return logical.replace(/\./g, "__");
}

interface ToolSpec {
  logicalName: string;
  description: string;
  parameters: Record<string, unknown>;
}

const REPORT: ToolSpec = {
  logicalName: "worker.report",
  description:
    "起動元へ報告する。作業が終わったとき・進み具合を伝えたいときに使う。" +
    "これは完了の宣言ではなく、検証へ回す合図。",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "何をしたか・確認した結果・残っている懸念" },
      done: { type: "boolean", description: "自分としては作業を終えたつもりなら true" },
    },
    required: ["summary"],
  },
};

const ASK: ToolSpec = {
  logicalName: "worker.ask",
  description:
    "起動元に質問する。指示に無い前提を推測して進めるより、ここで聞く。" +
    "呼んだあとは答えが来るまで待つ（答えは追加の指示として届く）。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "聞きたいこと。判断に必要な背景も添える" },
      blocking: { type: "boolean", description: "答えが無いと先へ進めないなら true" },
    },
    required: ["question"],
  },
};

/** 職人に渡す作法。報告先があることを知らせないと、職人は報告のしようがない。 */
export const WORKER_REPORT_PROMPT = [
  "## 起動元への報告",
  "",
  `あなたには報告の口があります。${toWireName("worker.report")} で起動元へ報告し、` +
    `${toWireName("worker.ask")} で質問できます。`,
  "",
  "- 判断に必要な前提が指示に無いときは、推測して進めず質問してください。答えは追加の指示として届きます。",
  "- 作業を終えたら報告してください。報告は完了の宣言ではなく、起動元が確かめるための合図です。",
].join("\n");

/** 設定を読む。I2: 足りないまま黙って起動しない。 */
function readConfig(): { baseUrl: string; projectTag: string; taskId: string } {
  const baseUrl = process.env["BANTO_WORKER_POOL_URL"];
  const projectTag = process.env["BANTO_PROJECT"];
  const taskId = process.env["BANTO_TASK_ID"];
  if (!baseUrl || !projectTag || !taskId) {
    throw new Error(
      "[worker-report] BANTO_WORKER_POOL_URL, BANTO_PROJECT, BANTO_TASK_ID must be set"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), projectTag, taskId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される。
// 型を得るために @mariozechner/pi-coding-agent を import すると、この拡張が職人側の
// ランタイムに縛られる（banto-executor と同じ判断）。(I4)
export default function (pi: any): void {
  const { baseUrl, projectTag, taskId } = readConfig();

  for (const spec of [REPORT, ASK]) {
    pi.registerTool({
      name: toWireName(spec.logicalName),
      label: spec.logicalName,
      description: spec.description,
      parameters: spec.parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
        const url = `${baseUrl}${MODULE_TOOL_PATH}${spec.logicalName}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 名乗りはここで足す。職人に自分の識別子を書かせない（間違えられる）
          body: JSON.stringify({ args: { ...params, projectTag, taskId } }),
        });
        if (!res.ok) {
          // I2: 失敗を成功に見せない。職人が「報告した」と誤解すると報告が消える
          const body = await res.text().catch(() => "");
          throw new Error(`[worker-report] ${spec.logicalName} failed (${res.status}): ${body}`);
        }
        const result = (await res.json()) as {
          content?: Array<{ type: string; text: string }>;
          details?: Record<string, unknown>;
        };
        return {
          content: result.content ?? [{ type: "text", text: "ok" }],
          details: result.details ?? {},
        };
      },
    });
  }

  pi.on(
    "before_agent_start",
    (event: { systemPrompt: string }, _ctx: unknown): { systemPrompt: string } => ({
      systemPrompt: `${event.systemPrompt}\n\n${WORKER_REPORT_PROMPT}`,
    })
  );
}
