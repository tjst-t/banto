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

/**
 * この拡張が職人に足す Tool の wire名。
 *
 * pi の `--tools`（許可リスト）は組み込みだけでなく**拡張の Tool にも効く**ので、
 * 委譲時に道具を絞るときは、この2つを必ず残さないと報告経路が黙って消える（imp-0004）。
 */
export const WORKER_REPORT_TOOL_NAMES: readonly string[] = [REPORT, ASK].map((spec) =>
  toWireName(spec.logicalName)
);

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

// ── 黙って終わる職人への安全弁 ──────────────────────────────────────────────

/**
 * 1回のやりとりの中で呼ばれた Tool 名を集める（純関数）。
 *
 * 見るのは `toolResult` メッセージの `toolName`。実行まで至ったものだけを数える
 * ——呼ぼうとして失敗したものを「報告した」に数えない（I2）。
 */
export function calledToolNames(messages: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    const m = message as { role?: string; toolName?: string } | null;
    if (m && m.role === "toolResult" && typeof m.toolName === "string") names.add(m.toolName);
  }
  return names;
}

/** 最後の発話（assistant のテキスト）を取り出す（純関数）。無ければ空文字。 */
export function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | null;
    if (!m || m.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const text = content
      .map((c) => (c as { type?: string; text?: string }))
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

/**
 * このやりとりを「黙って終えた」と見なすか（純関数）。
 *
 * **プロンプトで頼むだけでは足りなかった**（P4：同種の失敗が繰り返されるならプロンプト層
 * ではなく機構化する）。職人が報告せずに手を止めると、番頭は何も知らされないまま
 * アイドル安全弁（決定30b・既定15分）が働くのを待つことになる。
 *
 * 質問して待っている場合（`worker.ask`）は**黙って終えたのではない**——番頭には既に
 * 質問が届いており、職人は答え待ちで止まっているだけ。ここで報告を重ねると、
 * 待ちの職人の分だけ番頭の会話が二重に埋まる。
 */
export function endedWithoutReporting(messages: readonly unknown[]): boolean {
  const called = calledToolNames(messages);
  return !called.has(toWireName(REPORT.logicalName)) && !called.has(toWireName(ASK.logicalName));
}

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

  /** Worker Pool の HTTP 面へ1件送る。名乗りはここで足す（職人に書かせない）。 */
  async function post(
    logicalName: string,
    params: Record<string, unknown>
  ): Promise<{ content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${MODULE_TOOL_PATH}${logicalName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { ...params, projectTag, taskId } }),
    });
    if (!res.ok) {
      // I2: 失敗を成功に見せない。職人が「報告した」と誤解すると報告が消える
      const body = await res.text().catch(() => "");
      throw new Error(`[worker-report] ${logicalName} failed (${res.status}): ${body}`);
    }
    return (await res.json()) as {
      content?: Array<{ type: string; text: string }>;
      details?: Record<string, unknown>;
    };
  }

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
        const result = await post(spec.logicalName, params);
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

  /**
   * 報告せずに手を止めた職人の代わりに報告する（安全弁）。
   *
   * 頼むだけでは職人は報告し忘れる。**プロンプトには既に「終わったら報告してください」と
   * 二重に書いてある**ので、これ以上文面を足しても解決しない——機構で拾う（P4）。
   *
   * `auto: true` を付けて送る。**職人が自分で書いた報告ではない**ので、番頭には
   * そう見えなければならない（I1：主張の出所を偽らない）。番頭にとっては
   * 「この職人は黙って終える」こと自体が判断材料になる。
   *
   * 送信の失敗はここで握りつぶす（I2 の例外）。安全弁の失敗で職人のターンを壊すと、
   * 本来の作業結果まで失う——代わりに標準エラーへ残し、職人は生かす。
   */
  pi.on("agent_end", async (event: { messages?: readonly unknown[] }): Promise<void> => {
    const messages = event.messages ?? [];
    if (!endedWithoutReporting(messages)) return;

    const summary = lastAssistantText(messages);
    try {
      await post(REPORT.logicalName, {
        summary: summary.length > 0 ? summary : "(発話なしで手を止めました)",
        done: true,
        auto: true,
      });
    } catch (err) {
      process.stderr.write(`[worker-report] auto report failed: ${String(err)}\n`);
    }
  });
}
