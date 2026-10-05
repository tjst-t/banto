// **エージェントのプロセスグループ**（追加・2026-10-05、アーキ仕様 §2.5「2. Module の仕事を続ける」）。
//
// banto を起こし直すと Module は止まるが、Module が起こしたエージェントとその子（claude-agent-acp が起こす CLI など）は
// コンテナの中に残って走り続ける（実測・2026-10-05、経緯ノート「残ったエージェント」）。続きから開く前に止めないと、
// 同じ会話を2本が書く。エージェントは自分のプロセスグループで起こし（`acp-run.ts`）、グループごと止める。
//
// **pid の使い回しに気をつける**：記録した pid（＝グループの id）が別のプロセスに使われていたら止めない。グループの頭の
// 開始時刻（`/proc/<pid>/stat` の starttime）を記録と照らす。頭がもう居ない（子だけが残った）なら、そのグループの id は
// まだ使われている途中なので、別のプロセスに渡っていない——止める。

import { readFileSync } from "node:fs";

/** プロセスの開始時刻（起動からの clock tick）。読めなければ undefined（もう居ない・/proc が無い） */
export function startTicksOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 2つめの欄（comm）は括弧の中に空白を含みうる——最後の ')' の後ろから数える
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/** そのグループに誰か居るか（EPERM は居るが他人のもの——居る扱い） */
export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 記録したグループがまだ自分のものとして残っているか（上の注記） */
export function ownedGroupAlive(agent: { pid: number; startTicks?: number }): boolean {
  if (!groupAlive(agent.pid)) return false;
  const leader = startTicksOf(agent.pid);
  return leader === undefined || agent.startTicks === undefined || leader === agent.startTicks;
}

/**
 * グループを止める：SIGTERM → `graceMs` 待って残っていれば SIGKILL → 居なくなるまで待つ。止まったら true。
 * 自分のものでない（pid が使い回された）なら何もせず true
 */
export async function stopOwnedGroup(agent: { pid: number; startTicks?: number }, graceMs = 5000): Promise<boolean> {
  if (!ownedGroupAlive(agent)) return true;
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-agent.pid, signal);
    } catch {
      // もう居ない
    }
  };
  const waitGone = async (ms: number) => {
    for (let waited = 0; waited < ms && groupAlive(agent.pid); waited += 100) await new Promise((r) => setTimeout(r, 100));
    return !groupAlive(agent.pid);
  };
  send("SIGTERM");
  if (await waitGone(graceMs)) return true;
  send("SIGKILL");
  return waitGone(5000);
}
