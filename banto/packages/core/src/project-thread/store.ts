import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { projectThreadFold } from "./fold.js";
import type { ProjectId, ProjectState, ThreadId, ThreadState } from "./types.js";

/** Memory 1件あたりの文字数上限。超えたら追記を拒否する（item3決定）。 */
export const MEMORY_ENTRY_MAX_CHARS = 20_000;

export class MemoryLimitExceededError extends Error {}
export class NotFoundError extends Error {}
export class InvalidProjectRootError extends Error {}

/**
 * Project rootは絶対パス・実在ディレクトリのrealpathとしてイベントログに残す
 * （真実は一箇所——`~`のような非展開文字列を許すと、FileSystem Moduleの
 * `path.resolve()`やLandlockの`realpathSync()`がhostプロセスのcwd基準で
 * 誤解決する。実際に`~/`をrootにしたProjectで発生を確認した、2026-09-04）。
 * ここで一度だけ展開・検証し、以降は全経路がこの解決済み文字列だけを見る。
 */
export function normalizeProjectRoot(root: string): string {
  const expanded = root === "~" ? homedir() : root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
  if (!isAbsolute(expanded)) {
    throw new InvalidProjectRootError(`root must be an absolute path (got ${JSON.stringify(root)})`);
  }
  try {
    return realpathSync(expanded);
  } catch {
    throw new InvalidProjectRootError(`root does not exist: ${JSON.stringify(expanded)}`);
  }
}

export class ProjectThreadStore {
  private readonly projection: SnapshotProjection<ReturnType<typeof projectThreadFold.initial>>;

  constructor(
    private readonly dataDir: string,
    private readonly log: EventLog,
  ) {
    this.projection = new SnapshotProjection(dataDir, "project-thread", log, projectThreadFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }

  async save(): Promise<void> {
    await this.projection.save();
  }

  listProjects(): ProjectState[] {
    return Array.from(this.projection.current.projects.values());
  }

  getProject(id: ProjectId): ProjectState | undefined {
    return this.projection.current.projects.get(id);
  }

  listThreadsForProject(projectId: ProjectId): ThreadState[] {
    return Array.from(this.projection.current.threads.values()).filter(
      (t) => t.projectId === projectId,
    );
  }

  getThread(id: ThreadId): ThreadState | undefined {
    return this.projection.current.threads.get(id);
  }

  async createProject(name: string, root: string): Promise<ProjectState> {
    const resolvedRoot = normalizeProjectRoot(root);
    const id = randomUUID();
    const event = await this.log.append("project.created", { id, name, root: resolvedRoot });
    this.projection.applyOne(event);
    const project = this.getProject(id);
    if (!project) throw new Error("invariant: project.created did not produce a project");
    return project;
  }

  async closeProject(id: ProjectId): Promise<void> {
    if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    const event = await this.log.append("project.closed", { id });
    this.projection.applyOne(event);
  }

  async reopenProject(id: ProjectId): Promise<void> {
    if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    const event = await this.log.append("project.reopened", { id });
    this.projection.applyOne(event);
  }

  async createBaseThread(projectId: ProjectId): Promise<ThreadState> {
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    const id = randomUUID();
    const event = await this.log.append("thread.created", { id, projectId, kind: "base" as const });
    this.projection.applyOne(event);
    return this.mustGetThread(id);
  }

  /**
   * 既定では親の現在のresume-pointを引き継ぐ（v4-architecture.md §2.2
   * 「Fork Threadを立てる｜新しい枝として引き継いだresume-point——SDKの
   * 枝分かれでキャッシュを引き継げる」）。「やり直す」用に過去のresume-point
   * を明示したい場合だけ、呼び出し側が上書きする。
   */
  async forkThread(parentThreadId: ThreadId, resumePoint?: string): Promise<ThreadState> {
    const parent = this.getThread(parentThreadId);
    if (!parent) throw new NotFoundError(`thread ${parentThreadId} not found`);
    const id = randomUUID();
    const event = await this.log.append("thread.created", {
      id,
      projectId: parent.projectId,
      kind: "fork" as const,
      parentThreadId,
      resumePoint: resumePoint ?? parent.resumePoint,
    });
    this.projection.applyOne(event);
    return this.mustGetThread(id);
  }

  async closeThread(id: ThreadId): Promise<void> {
    if (!this.getThread(id)) throw new NotFoundError(`thread ${id} not found`);
    const event = await this.log.append("thread.closed", { id });
    this.projection.applyOne(event);
  }

  async reopenThread(id: ThreadId): Promise<void> {
    if (!this.getThread(id)) throw new NotFoundError(`thread ${id} not found`);
    const event = await this.log.append("thread.reopened", { id });
    this.projection.applyOne(event);
  }

  async updateResumePoint(id: ThreadId, resumePoint: string): Promise<void> {
    const event = await this.log.append("thread.resume_point_updated", { id, resumePoint });
    this.projection.applyOne(event);
  }

  /**
   * Memoryへの追記。訂正は無効化イベントの追記で行う——物理削除・書き換えは
   * しない（item3決定）。上限を超えたら追記を拒否する。
   */
  async appendMemory(threadId: ThreadId, text: string): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    if (text.length > MEMORY_ENTRY_MAX_CHARS) {
      throw new MemoryLimitExceededError(
        `Memory entry exceeds ${MEMORY_ENTRY_MAX_CHARS} chars (${text.length})`,
      );
    }
    const event = await this.log.append("memory.appended", { threadId, text });
    this.projection.applyOne(event);
  }

  async invalidateMemory(threadId: ThreadId, targetSeq: number): Promise<void> {
    const event = await this.log.append("memory.invalidated", { threadId, targetSeq });
    this.projection.applyOne(event);
  }

  /** リロード時の会話表示復元用（決定・2026-09-04）。実行再開はresumePointが担うので、
   *  ここは表示に足るテキストだけを追記する——SDKMessageの生データは持たない。 */
  async appendMessage(threadId: ThreadId, role: "user" | "assistant", text: string): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("message.appended", { threadId, role, text });
    this.projection.applyOne(event);
  }

  /** F2/F3——ターンごとの文脈使用量を記録する（turn-runner.tsのappendMessage直後）。
   *  contextUsageはRunnerが返す形をそのまま保存する（規則12）。 */
  async recordUsage(threadId: ThreadId, contextUsage: unknown, compactionCount: number): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("usage.recorded", { threadId, contextUsage, compactionCount });
    this.projection.applyOne(event);
  }

  /** UIの「Clear」——会話を畳む（v4-architecture.md §2.2）。resume-pointを捨てて、
   *  次のRunner呼び出しを新規query()にする。過去のmessages/memoryは物理削除しない
   *  （規則3）——横線マーカーとして記録するだけ。 */
  async clearThread(threadId: ThreadId): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("thread.cleared", { threadId });
    this.projection.applyOne(event);
  }

  private mustGetThread(id: ThreadId): ThreadState {
    const t = this.getThread(id);
    if (!t) throw new Error("invariant: thread.created did not produce a thread");
    return t;
  }
}
