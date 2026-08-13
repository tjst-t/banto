/**
 * tool-offload の **Claude Agent SDK 経路の繋ぎ込み**（判断は `../tool-offload.ts` にある）。
 *
 * ## なぜ要るか（task-0102）
 *
 * task-0090 で職人にも退避＋栞を入れたが、載せ方が pi の言葉だった——工房は
 * `extensionPaths` に拡張のパスを積むだけで、**claude-agent ドライバはそれを読まない**。
 * 実運用の職人はほぼ全部 Claude Agent SDK 経路なので、対策は実質効いていなかった。
 * task-0089 の事故（長いツール結果の直後に応答が返らず `agent_exited_without_report`）は
 * そのまま残っていたことになる。
 *
 * ## どこに差し込むか
 *
 * Agent SDK の `PostToolUse` フック。返り値の `updatedToolOutput` が
 * 「モデルへ渡る前のツール出力を差し替える」口で、pi の `tool_result` と同じ位置に当たる。
 *
 * ## 形を保つこと（実機で確かめた）
 *
 * **平文の文字列を返してはいけない。** Claude Code は差し替えた出力を元の Tool の
 * 出力スキーマ（`outputSchema` / `mapToolResultToToolResultBlockParam`）で検証し、
 * 合わなければ**黙って元の全文に戻す**。実機で確かめた（2026-08-13・haiku・7,623字の Read）:
 *   - 文字列を返した   → モデルには元の全文が渡っていた（退避したつもりで効いていない）
 *   - 形を保って返した → モデルに渡ったのは栞だけ
 * だから中核の `applyToOutput` は、器（`{type,file:{content,…}}` 等）はそのままに
 * **長い文字列の葉だけ**を栞へ差し替える。
 *
 * D5: ここに判断は無い。フックに繋ぎ、中核へ渡すだけ。
 * D6: 依存は node 標準のみ。SDK からは**型だけ**を取る（実行時に読み込ませない）。
 * I2: 退避の失敗でターンを壊さない。標準エラーに残して素通しする。
 */

import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_OFFLOAD_DIALECT,
  isOffloadEnabled,
  renderWorkerOffloadPrompt,
  resolveOffloadDir,
  resolveThresholdChars,
  ToolResultOffloader,
} from "../tool-offload.js";

/** Claude Code の職人に渡す作法（読み返しは `Read` / `Grep`）。 */
export const CLAUDE_WORKER_OFFLOAD_PROMPT = renderWorkerOffloadPrompt(CLAUDE_OFFLOAD_DIALECT);

/** フック1本の形（`Options["hooks"]` の要素。SDK の `HookCallbackMatcher` と同じ）。 */
export interface ClaudeHookMatcher {
  hooks: Array<(input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>>;
}

export interface ClaudeToolOffload {
  /** 職人のシステムプロンプトへ足す作法。 */
  prompt: string;
  /** `query()` の `options.hooks` へそのまま渡せる形。 */
  hooks: { PostToolUse: ClaudeHookMatcher[] };
  /** 退避先（診断・試験用）。 */
  directory: string;
}

/**
 * 退避を Claude Agent SDK の職人に載せる。
 *
 * 切ってあるとき（`BANTO_WORKER_OFFLOAD=0`）は `undefined` を返す——フックも作法も
 * 載せない。pi 経路（`installToolOffload`）と同じ逃げ道である。
 */
export function createClaudeToolOffload(
  env: Readonly<Record<string, string | undefined>> = process.env,
  pid: number = process.pid
): ClaudeToolOffload | undefined {
  if (!isOffloadEnabled(env)) return undefined;

  const offloader = new ToolResultOffloader({
    dir: resolveOffloadDir(env, pid),
    thresholdChars: resolveThresholdChars(env),
    dialect: CLAUDE_OFFLOAD_DIALECT,
  });

  const hook = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUse") return {};
    try {
      const patch = offloader.applyToOutput({
        toolName: input.tool_name,
        input: input.tool_input,
        output: input.tool_response,
      });
      if (!patch) return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          updatedToolOutput: patch.output,
        },
      };
    } catch (err) {
      // 退避の失敗でターンを壊すと、本来の作業結果まで失う。標準エラーに残して素通しする
      process.stderr.write(`[tool-offload] failed: ${String(err)}\n`);
      return {};
    }
  };

  return {
    prompt: CLAUDE_WORKER_OFFLOAD_PROMPT,
    hooks: { PostToolUse: [{ hooks: [hook] }] },
    directory: offloader.directory,
  };
}
