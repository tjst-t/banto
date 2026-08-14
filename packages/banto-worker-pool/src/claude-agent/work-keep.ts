/**
 * work-keep の **Claude Agent SDK 経路の繋ぎ込み**（判断は `../work-keep.ts` にある）。
 *
 * ## なぜ両方に要るか（task-0102 の轍）
 *
 * pi 経路の繋ぎ込みは `extensionPaths`（pi の言葉）なので、claude-agent ドライバは
 * それを読まない。**実運用の職人はほぼ全部 Claude Agent SDK 経路**なので、ここが空いていれば
 * 「機構が成果を守る」は実質どこにも効いていないことになる。task-0102 の tool-offload が
 * まさにそれだった。
 *
 * ## どこに差し込むか
 *
 * - `PostToolUse` フック … 職人が道具を使うたびに通る口。pi の `tool_result` と同じ位置で、
 *   間隔が過ぎていれば**書き換えた直後に**取り置ける
 * - タイマー（`keeper.start()`）… 道具を使わずに考え込んでいる間も撮る。定期であることは
 *   フックの有無に依存させない
 *
 * フックは `buildHostOptions` を通って `query()` の options に載る。**繋ぎ目を試験から
 * 叩けるようにする**ためで、tool-offload と同じ形に揃えてある。
 *
 * D5: ここに判断は無い。フックに繋ぎ、中核へ渡すだけ。
 * D6: 依存は node 標準のみ。SDK からは**型だけ**を取る（実行時に読み込ませない）。
 * I2: 取り置きの失敗でターンを壊さない（中核が受け止めて標準エラーへ残す）。
 */

import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { createWorktreeKeeper, type WorktreeKeeper } from "../work-keep.js";
import type { ClaudeHookMatcher } from "./tool-offload.js";

/** Claude Agent SDK 経路の職人だと分かる名前（取り置き枝に載る）。 */
export const CLAUDE_KEEP_RUNTIME = "claude-agent";

export interface ClaudeWorkKeep {
  /** `query()` の `options.hooks` へ混ぜる形。 */
  hooks: { PostToolUse: ClaudeHookMatcher[]; Stop: ClaudeHookMatcher[] };
  /** 取り置きの器（畳むとき・診断・試験用）。 */
  keeper: WorktreeKeeper;
  /** 成果が載る枝（診断・試験用）。 */
  branch: string;
}

/**
 * 取り置きを Claude Agent SDK の職人に載せる。
 *
 * 切ってあるとき（`BANTO_WORKER_KEEP=0`）は `undefined` を返す——フックも枝も作らない。
 * pi 経路（`installWorkKeep`）と同じ逃げ道である。
 */
export function createClaudeWorkKeep(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
  sessionId?: string
): ClaudeWorkKeep | undefined {
  const keeper = createWorktreeKeeper({
    runtime: CLAUDE_KEEP_RUNTIME,
    cwd,
    env,
    ...(sessionId ? { sessionId } : {}),
  });
  if (!keeper) return undefined;

  keeper.start();

  // 道具を使うたび。間隔が過ぎていれば撮る（何も返さない＝ツール出力には触らない）
  const onTool = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUse") return {};
    // 中核が失敗を受け止めるので、ここで握りつぶす必要は無い
    keeper.maybeSnapshot("tool_result");
    return {};
  };

  /**
   * ターンの終わり。**間隔を待たずに必ず撮る**。
   *
   * 「無報告で終わった職人を機構が即座に畳む」のが成果を失っていた場面そのものなので、
   * 手が止まった瞬間の姿は間隔に関係なく残す。pi 経路の `agent_end` と同じ位置。
   */
  const onStop = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "Stop") return {};
    keeper.snapshot("turn_end");
    return {};
  };

  return {
    hooks: { PostToolUse: [{ hooks: [onTool] }], Stop: [{ hooks: [onStop] }] },
    keeper,
    branch: keeper.branch,
  };
}
