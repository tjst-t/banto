/**
 * tool-offload の **pi 経路の繋ぎ込み**（判断は `../tool-offload.ts` にある）。
 *
 * pi は `extensionPaths` で渡されたこのファイルを職人プロセス内で読み込み、default export を
 * 呼ぶ。ここでやるのは `tool_result` と `before_agent_start` に器を繋ぐことだけ——
 * 何を退避するか・どこへ置くか・栞に何を書くかは中核に1つだけ置いてある（D3）。
 *
 * **この経路にしか載っていなかったのが task-0102 の穴**。`extensionPaths` は pi の言葉なので、
 * Claude Agent SDK のドライバはこのファイルを読まない。同じ判断は
 * `claude-agent/tool-offload.ts` から `PostToolUse` フックとして載せている。
 *
 * I4: pi の型は import しない（worker-report.ts と同じ判断。実行時に渡される）。
 */

import {
  isOffloadEnabled,
  resolveOffloadDir,
  resolveThresholdChars,
  ToolResultOffloader,
  WORKER_OFFLOAD_PROMPT,
  type OffloadPatch,
  type ToolResultLike,
} from "../tool-offload.js";

/**
 * 拡張を pi に繋ぐ（default export の実体）。
 *
 * 名前付きでも出すのは、繋ぎ目そのものを検証できるようにするため——器が正しくても
 * `tool_result` に繋がっていなければ職人の文脈は何も変わらない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される。
// 型を得るために @earendil-works/pi-coding-agent を import すると、この拡張が職人側の
// ランタイムに縛られる（worker-report.ts と同じ判断）。(I4)
export function installToolOffload(pi: any): void {
  if (!isOffloadEnabled(process.env)) return;

  const offloader = new ToolResultOffloader({
    dir: resolveOffloadDir(process.env, process.pid),
    thresholdChars: resolveThresholdChars(process.env),
  });

  pi.on(
    "before_agent_start",
    (event: { systemPrompt: string }, _ctx: unknown): { systemPrompt: string } => ({
      systemPrompt: `${event.systemPrompt}\n\n${WORKER_OFFLOAD_PROMPT}`,
    })
  );

  pi.on("tool_result", (event: ToolResultLike): OffloadPatch | undefined => {
    try {
      return offloader.apply(event);
    } catch (err) {
      // 退避の失敗でターンを壊すと、本来の作業結果まで失う。標準エラーに残して素通しする
      process.stderr.write(`[tool-offload] failed: ${String(err)}\n`);
      return undefined;
    }
  });
}

export default installToolOffload;
