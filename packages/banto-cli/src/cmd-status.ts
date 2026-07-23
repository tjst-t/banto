/**
 * banto status: show daemon health, registered projects, and task summary.
 *
 * Output format (stdout, human-readable):
 *   daemon : running (http://localhost:3000)
 *   projects:
 *     proj-a  /repos/proj-a
 *   tasks (proj-a):
 *     implementing: 1  [task-0001]
 *     draft       : 1  [task-0002]
 *
 * D5: presentation only; all data comes from DaemonClient.
 * I2: DaemonConnectionError propagates to bin.ts → exit 1 + stderr.
 */

import type { DaemonClient } from "@banto/core";
import type { TaskRecord } from "@banto/core";

export async function cmdStatus(client: DaemonClient): Promise<void> {
  // Health check (throws DaemonConnectionError if daemon is not reachable)
  await client.health();

  process.stdout.write(`daemon  : running (${client.baseUrl})\n`);

  const projects = await client.listProjects();

  if (projects.length === 0) {
    process.stdout.write("projects: (none)\n");
    return;
  }

  process.stdout.write("projects:\n");
  for (const p of projects) {
    process.stdout.write(`  ${p.id}  ${p.repoPath}\n`);
  }

  // Per-project task summary grouped by status
  for (const project of projects) {
    const tasks = await client.listTasks(project.id);
    if (tasks.length === 0) {
      process.stdout.write(`tasks (${project.id}): (none)\n`);
      continue;
    }

    // Group tasks by status (D3: status is derived by daemon, we just display it)
    const byStatus = new Map<string, TaskRecord[]>();
    for (const task of tasks) {
      const status = task.status;
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status)!.push(task); // non-null asserted: just set above
    }

    process.stdout.write(`tasks (${project.id}):\n`);
    for (const [status, group] of byStatus) {
      const ids = group.map((t) => t.id).join(", ");
      process.stdout.write(`  ${status.padEnd(14)}: ${group.length}  [${ids}]\n`);
    }
  }
}
