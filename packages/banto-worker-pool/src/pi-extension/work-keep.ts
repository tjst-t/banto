/**
 * work-keep の **pi 経路の繋ぎ込み**（判断は `../work-keep.ts` にある）。
 *
 * pi は `extensionPaths` で渡されたこのファイルを職人プロセス内で読み込み、default export を
 * 呼ぶ。ここでやるのは器を起こして pi の口に繋ぐことだけ——いつ・何を・どこへ取り置くかは
 * 中核に1つだけ置いてある（D3）。
 *
 * **`extensionPaths` は pi の言葉**なので、Claude Agent SDK のドライバはこのファイルを読まない。
 * 同じ判断は `claude-agent/work-keep.ts` から `PostToolUse` フックとして載せている——
 * 片方だけ塞いで塞いだつもりになったのが task-0102 だった。
 *
 * 職人へ足す作法（プロンプト）は**無い**。これは職人にやらせる約束ではなく機構なので、
 * 文脈を1文字も使わない——作法にすると「職人が忘れる」余地がそのまま穴になる。
 *
 * I4: pi の型は import しない（tool-offload.ts と同じ判断。実行時に渡される）。
 */

import { createWorktreeKeeper, type WorktreeKeeper } from "../work-keep.js";

/** pi 経路の職人だと分かる名前（取り置き枝に載る）。 */
export const PI_KEEP_RUNTIME = "pi";

/**
 * 取り置きを pi の職人に載せる（default export の実体）。
 *
 * 拡張が読み込まれた時点で時計を回し始める（pi は職人の worktree を cwd にして起こすので、
 * ここが既に作業場所）。加えて `tool_result` にも繋ぐ——**書き換えた直後に撮れる**からで、
 * Claude 経路の `PostToolUse` と同じ位置に当たる。経路で職人の守られ方が変わらないこと自体が
 * この機構の要件である。
 *
 * 名前付きでも出すのは、繋ぎ目そのものを検証できるようにするため——器が正しくても
 * 口に繋いでいなければ、職人の成果は1つも残らない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される。
// 型を得るために @earendil-works/pi-coding-agent を import すると、この拡張が職人側の
// ランタイムに縛られる（tool-offload.ts と同じ判断）。(I4)
export function installWorkKeep(pi: any): WorktreeKeeper | undefined {
  const keeper = createWorktreeKeeper({ runtime: PI_KEEP_RUNTIME });
  if (!keeper) return undefined;

  keeper.start();

  pi.on("tool_result", (): undefined => {
    keeper.maybeSnapshot("tool_result");
    return undefined;
  });

  /**
   * ターンの終わり。**間隔を待たずに必ず撮る**。
   *
   * 「無報告で終わった職人を機構が即座に畳む」のが成果を失っていた場面そのものなので、
   * 手が止まった瞬間の姿は間隔に関係なく残す。Claude 経路の `Stop` フックと同じ位置。
   */
  pi.on("agent_end", (): undefined => {
    keeper.snapshot("turn_end");
    return undefined;
  });

  return keeper;
}

export default installWorkKeep;
