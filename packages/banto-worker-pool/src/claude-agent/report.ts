/**
 * Claude Code の職人が起動元へ報告・質問するための口（決定29e）。
 *
 * pi 側の `pi-extension/worker-report.ts` と同じ考え・同じ HTTP 面を使う。違うのは
 * Tool の載せ方だけ（pi は拡張、Claude Code は同一プロセス内の MCP サーバ）。
 *
 * ここに置くのは**判定と組み立てだけ**。ホスト（host.ts）から切り離してあるのは、
 * 安全弁の判定を試験から直に呼べるようにするため——ホストを import すると
 * 子プロセスとしての起動処理まで走ってしまう。
 */

import { MODULE_TOOL_PATH } from "@banto/core";
import { CLAUDE_ASK_TOOL, CLAUDE_REPORT_TOOL } from "./naming.js";

export interface ReportChannel {
  post(logicalName: string, params: Record<string, unknown>): Promise<string>;
}

/**
 * 報告先が設定されていれば口を作る。無ければ `undefined`
 * ——**報告先が無いのに報告を促さない**（作法のプロンプトも Tool も載らない）。
 */
export function createReportChannel(env: NodeJS.ProcessEnv = process.env): ReportChannel | undefined {
  const baseUrl = env["BANTO_WORKER_POOL_URL"];
  const projectTag = env["BANTO_PROJECT"];
  const taskId = env["BANTO_TASK_ID"];
  if (!baseUrl || !projectTag || !taskId) return undefined;
  const root = baseUrl.replace(/\/$/, "");
  return {
    async post(logicalName, params) {
      const res = await fetch(`${root}${MODULE_TOOL_PATH}${logicalName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: { ...params, projectTag, taskId } }),
      });
      if (!res.ok) {
        // I2: 失敗を成功に見せない。職人が「報告した」と誤解すると報告が消える
        const body = await res.text().catch(() => "");
        throw new Error(`[claude-agent] ${logicalName} failed (${res.status}): ${body}`);
      }
      const json = (await res.json()) as { content?: Array<{ type: string; text: string }> };
      return json.content?.map((c) => c.text).join("\n") ?? "ok";
    },
  };
}

/**
 * 職人に渡す作法。報告先があることを知らせないと、職人は報告のしようがない。
 *
 * 本文は英語。職人は任意のモデルで動かす前提なので、指示追従が崩れにくいほうを採る
 * （`WORKER_SYSTEM_PROMPT` と同じ判断で、呼び名も "caller" に揃える）。
 */
export const CLAUDE_REPORT_PROMPT = [
  "## Reporting to the caller",
  "",
  `You have a channel back to the caller: report with ${CLAUDE_REPORT_TOOL} ` +
    `and ask questions with ${CLAUDE_ASK_TOOL}.`,
  "",
  "- When the instruction is missing something you need in order to decide, ask instead of guessing and proceeding. The answer arrives as a further instruction.",
  "- Report when you finish. A report is not a declaration that the work is complete — it is the signal for the caller to go and verify it.",
].join("\n");

/**
 * このターンを「黙って終えた」と見なすか（純関数）。
 *
 * **プロンプトで頼むだけでは足りない**（P4：同種の失敗が繰り返されるなら機構化する）。
 * 職人が報告せずに手を止めると、番頭は何も知らされないままアイドル安全弁（決定30b・
 * 既定15分）が働くのを待つことになる。
 *
 * 質問して待っている場合は**黙って終えたのではない**——番頭には既に質問が届いており、
 * 職人は答え待ちで止まっているだけ。ここで報告を重ねると会話が二重に埋まる。
 */
export function endedWithoutReporting(calledTools: ReadonlySet<string>): boolean {
  return !calledTools.has(CLAUDE_REPORT_TOOL) && !calledTools.has(CLAUDE_ASK_TOOL);
}
