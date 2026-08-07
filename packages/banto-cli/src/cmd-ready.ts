/**
 * kobo ready: いま着手できる仕事を出す（task-0001・spec-daemon-core §6）。
 *
 * 出力（stdout）:
 *   ready (2):
 *     proj-a  task-0042  一覧の描画を速くする
 *     proj-a  task-0043  設定画面の保存を直す
 *
 * **判定はしない。** 依存グラフ・スコープ重複・物理quota を通ったかどうかは Kobo が決めて
 * いて、ここはその結果を見せるだけ（D5）。CLI が自分で数え始めると、画面と実際の着手が
 * ずれる（D3：判定の真実は一箇所）。
 *
 * I2: DaemonConnectionError は bin.ts へ伝わり、exit 1 + stderr になる。
 */

import type { DaemonClient, TaskRecord } from "@banto/core";

export async function cmdReady(client: DaemonClient, projectTag?: string): Promise<void> {
  const tasks: TaskRecord[] = await client.listReady(projectTag);

  if (tasks.length === 0) {
    process.stdout.write(
      projectTag ? `ready (${projectTag}): (none)\n` : "ready: (none)\n"
    );
    return;
  }

  process.stdout.write(`ready (${tasks.length}):\n`);
  for (const task of tasks) {
    const title = String(task["title"] ?? "");
    process.stdout.write(`  ${task.projectTag}  ${task.id}  ${title}\n`);
  }
}
