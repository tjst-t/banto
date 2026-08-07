/**
 * TaskWatcher: polling watcher for work/tasks/*.md files.
 *
 * Algorithm:
 *   1. For each registered project, scan <repoPath>/work/tasks/*.md
 *   2. Compare file mtime against the last known mtime (in-memory map)
 *   3. On new or modified file: parse + validate frontmatter
 *      - Validation failure (any status): emit task_ingest_rejected(reason) (I2: not swallowed)
 *      - Validation success, status === "queued": emit task_created → state_transitioned(draft→queued)
 *      - Validation success, status === "draft":  schema-validate only; do NOT enqueue, no events.
 *        (imp-0001 PO decision option-2: draft is PO-intent-only, not executable)
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
import type { TaskFrontmatter } from "@banto/core";

/**
 * frontmatter の後ろの本文＝**依頼そのもの**（task-0060・ADR-0013 決定60）。
 *
 * frontmatter が契約（スコープ・受け入れ基準）なら、本文は「何をしてほしいか」であり、
 * **職人へ渡さなければ工場は動かない**——Kobo は職人を起こすとき、これを指示に書き切る
 * （職人は記憶を持たない・D11）。以前は Kobo が指示を渡していなかったため、E2E が
 * 外から本文を注入して辻褄を合わせていた。
 *
 * D3: 取り込み時点の写しで固まる（決定62c：積んだ後にファイルを直しても変わらない）。
 */
function extractTaskBody(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return "";
  const afterFirst = trimmed.slice(3);
  const closeIdx = afterFirst.search(/^---\s*$/m);
  if (closeIdx === -1) return "";
  return afterFirst.slice(closeIdx).replace(/^---\s*/, "").trim();
}

/**
 * タスク定義から、Kobo が持つ**契約**を組み立てる（決定62c：取り込み時点で固まる）。
 *
 * 明示の `kobo.enqueue`（決定58）と watcher の取り込みで**同じものを使う**——2箇所で
 * 組み立てると、入口によって契約が変わる（片方だけ本文が落ちる、等）。
 */
export function taskPayload(fm: TaskFrontmatter, content: string): Record<string, unknown> {
  const body = extractTaskBody(content);
  return {
    kind: fm.kind,
    // 本文＝依頼。職人への指示に書き切るために持つ（task-0060）
    ...(body.length > 0 ? { body } : {}),
    scope: fm.scope,
    acceptance: fm.acceptance,
    ...(fm.parent !== undefined ? { parent: fm.parent } : {}),
    ...(fm.depends !== undefined ? { depends: fm.depends } : {}),
    ...(fm.refs !== undefined ? { refs: fm.refs } : {}),
    ...(fm.environment !== undefined ? { environment: fm.environment } : {}),
    ...(fm.governance !== undefined ? { governance: fm.governance } : {}),
    ...(fm.model_tier !== undefined ? { model_tier: fm.model_tier } : {}),
    // review.policy controls auto-merge vs manual-review path (spec-daemon-core §1).
    // Without this, handleAuditVerdict() defaults to "manual" and never auto-merges.
    ...(fm.review !== undefined ? { review: fm.review } : {}),
  };
}

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
    // 直前に観測した mtime（初回は undefined）。「初めて見た」と「書き換えられた」を分ける
    const prevState = projectStates.get(filePath);
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
      // I2: validation failure → task_ingest_rejected with reason (applies to any status, including draft)
      this.emitRejected(projectId, filePath, validation.reason);
      projectStates.set(filePath, { mtimeMs, ingested: false });
      return;
    }

    const fm = validation.frontmatter;

    // imp-0001 PO decision option-2: only status:queued triggers enqueue.
    // Any other valid status (draft, done, failed, superseded, cancelled) =
    // schema-validate only; record mtime so the file is not re-processed on
    // each poll, but emit no events and create no task.
    // When the PO later edits the status to "queued", the mtime changes and the
    // poll will re-enter this function with the new mtime and ingest it.
    if (fm.status !== "queued") {
      // Valid file but status is not queued — record mtime and wait for a status change.
      projectStates.set(filePath, { mtimeMs, ingested: false });
      return;
    }

    // Check if task already exists in this project (idempotency on mtime change)
    const existing = this.daemon.getTask(projectId, fm.id);
    if (existing) {
      const known = prevState?.mtimeMs;
      // **書き換えても反映されないことを、黙って通さない**（決定64・inc-0028）。
      // 取り込み済みの契約は凍結されている（決定62c）ので、ここで読み飛ばすのは正しい
      // ——正しくないのは、直した本人が「直したのに何も起きない」に気づけないことだった。
      // 初回の観測（`known === undefined`）は「書き換え」ではないので黙って通す
      if (known !== undefined && known !== mtimeMs) {
        this.daemon.emitIngestRejected(
          projectId,
          filePath,
          `already_ingested: ${fm.id} は取り込み済み（いまの状態: ${existing.status}）なので、` +
            "ファイルの変更は反映されません。契約は取り込み時点で固まります（決定62c）——" +
            "訂正するなら新しいタスクを積み、元を superseded にしてください（決定64）"
        );
      }
      // Already ingested; mark as ingested at this mtime to suppress re-processing
      projectStates.set(filePath, { mtimeMs, ingested: true });
      return;
    }

    // Create the task (task_created → draft)
    try {
      this.daemon.createTask(projectId, fm.id, fm.title, taskPayload(fm, content));
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
