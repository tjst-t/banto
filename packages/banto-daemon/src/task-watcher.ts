/**
 * TaskWatcher: polling watcher for work/tasks/*.md files.
 *
 * Algorithm:
 *   1. For each registered project, scan <repoPath>/work/tasks/*.md
 *   2. Compare file mtime against the last known mtime (in-memory map)
 *   3. On new or modified file: parse + validate frontmatter
 *      - Success: emit task_created → state_transitioned(draft→queued)
 *      - Failure: emit task_ingest_rejected(reason) (I2: not swallowed)
 *   4. Never write back to the file (D3: file is intent, event log is state)
 *
 * D3: watcher is file→enqueue one-way only. No frontmatter write-back, ever.
 * D5: all logic lives here (daemon layer), not in the HTTP/WS surface.
 * D6: uses node:fs, no third-party watcher library.
 * I2: parse/validate errors are recorded as task_ingest_rejected events.
 * P1: only touches work/tasks/*.md inside registered project repoPath.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Daemon } from "./daemon.js";
import { validateTaskFrontmatter } from "@banto/core";

interface FileState {
  /** mtime from last successful ingest attempt */
  mtimeMs: number;
  /** Whether this file was already ingested (task_created emitted) */
  ingested: boolean;
}

export class TaskWatcher {
  /** per-project, per-file ingest state */
  private readonly fileStates: Map<string, Map<string, FileState>> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly daemon: Daemon,
    private readonly intervalMs: number
  ) {}

  /** Start polling. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.poll().catch((err: unknown) => {
        // I2: poll errors are logged; the watcher continues (not fatal)
        process.stderr.write(
          `[task-watcher] poll error: ${String(err)}\n`
        );
      });
    }, this.intervalMs);
    // Run once immediately so tests don't need to wait a full interval
    this.poll().catch((err: unknown) => {
      process.stderr.write(`[task-watcher] initial poll error: ${String(err)}\n`);
    });
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const projects = this.daemon.listProjects();
    for (const project of projects) {
      await this.pollProject(project.id, project.repoPath);
    }
  }

  private async pollProject(projectId: string, repoPath: string): Promise<void> {
    const tasksDir = path.join(repoPath, "work", "tasks");
    if (!fs.existsSync(tasksDir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(tasksDir, { withFileTypes: true });
    } catch {
      // Directory may be unreadable; skip silently (not a task-watcher error)
      return;
    }

    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => path.join(tasksDir, e.name));

    if (!this.fileStates.has(projectId)) {
      this.fileStates.set(projectId, new Map());
    }
    const projectStates = this.fileStates.get(projectId)!;

    for (const filePath of mdFiles) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        // File may have been removed between readdir and stat; skip
        continue;
      }

      const mtimeMs = stat.mtimeMs;
      const prev = projectStates.get(filePath);

      // Skip if this file has been seen at this mtime already.
      // Reject or ingest: once we've processed this mtime, don't reprocess it.
      // If the file is updated (mtime changes), it will be re-processed.
      if (prev && prev.mtimeMs === mtimeMs) {
        continue;
      }

      // New or updated file: attempt ingest
      await this.ingestFile(projectId, filePath, mtimeMs, projectStates);
    }
  }

  private async ingestFile(
    projectId: string,
    filePath: string,
    mtimeMs: number,
    projectStates: Map<string, FileState>
  ): Promise<void> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      // Cannot read file; record as rejected (I2)
      this.emitRejected(projectId, filePath, `cannot read file: ${String(err)}`);
      projectStates.set(filePath, { mtimeMs, ingested: false });
      return;
    }

    const validation = validateTaskFrontmatter(content);
    if (!validation.ok) {
      // I2: validation failure → task_ingest_rejected with reason
      this.emitRejected(projectId, filePath, validation.reason);
      projectStates.set(filePath, { mtimeMs, ingested: false });
      return;
    }

    const fm = validation.frontmatter;

    // Check if task already exists in this project (idempotency on mtime change)
    const existing = this.daemon.getTask(projectId, fm.id);
    if (existing) {
      // Already ingested; mark as ingested at this mtime to suppress re-processing
      projectStates.set(filePath, { mtimeMs, ingested: true });
      return;
    }

    // Create the task (task_created → draft)
    try {
      this.daemon.createTask(projectId, fm.id, fm.title, {
        kind: fm.kind,
        scope: fm.scope,
        acceptance: fm.acceptance,
        ...(fm.parent !== undefined ? { parent: fm.parent } : {}),
        ...(fm.depends !== undefined ? { depends: fm.depends } : {}),
        ...(fm.refs !== undefined ? { refs: fm.refs } : {}),
        ...(fm.environment !== undefined ? { environment: fm.environment } : {}),
        ...(fm.governance !== undefined ? { governance: fm.governance } : {}),
        ...(fm.model_tier !== undefined ? { model_tier: fm.model_tier } : {}),
      });
    } catch (err) {
      // createTask may throw if there's a duplicate (race); treat as already done
      const alreadyExists = this.daemon.getTask(projectId, fm.id);
      if (alreadyExists) {
        projectStates.set(filePath, { mtimeMs, ingested: true });
        return;
      }
      this.emitRejected(projectId, filePath, `task_created failed: ${String(err)}`);
      projectStates.set(filePath, { mtimeMs, ingested: false });
      return;
    }

    // Transition draft → queued
    const result = this.daemon.transition(projectId, fm.id, "queued", "watcher-ingest");
    if (!result.ok) {
      // This shouldn't happen (draft→queued is always valid), but I2: log it
      process.stderr.write(
        `[task-watcher] unexpected transition failure for ${fm.id}: ${result.reason}\n`
      );
    }

    projectStates.set(filePath, { mtimeMs, ingested: true });
  }

  private emitRejected(projectId: string, filePath: string, reason: string): void {
    // D5: delegate to daemon for event emission (daemon owns the log)
    this.daemon.emitIngestRejected(projectId, filePath, reason);
  }
}
