import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { projectThreadFold } from "./fold.js";
import { splitMemory, type MemorySplit } from "./memory-split.js";
import type {
  MemoryEntry,
  ProjectId,
  ProjectState,
  ThreadId,
  ThreadPermissionMode,
  ThreadState,
  UiToolCallEntry,
} from "./types.js";

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
    // v3：ThreadにownsSession（親から借りたresume-pointか、自分のセッションか）
    // を足した（決定・2026-09-05）。v2以前には無いので読まずに作り直す。
    // v2でMemoryをProject持ちにした変更もここに含まれる。
    // v8：「どの面に出したか」を、会話より先に届いても取りこぼさないように
    //     read model に預かり場所を足した（実測・2026-09-07）
    // v7：UiToolCallEntry に displayMode、ThreadState に createdSeq を足した
    //     （決定・2026-09-07。古いスナップショットには無いので畳み直す）
    // v6：MessageEntry に uiToolCalls を足した（決定・2026-09-07）
    this.projection = new SnapshotProjection(dataDir, "project-thread", log, projectThreadFold, 8);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }

  async save(): Promise<void> {
    await this.projection.save();
  }

  listProjects(): ProjectState[] {
    // 一覧も1件取りと同じ姿で返す（下の getProject のコメント、規則3）
    return Array.from(this.projection.current.projects.keys())
      .map((id) => this.getProject(id))
      .filter((p): p is ProjectState => p !== undefined);
  }

  /**
   * **root は読むときに正規化する**（改訂・2026-09-07、ユーザー報告）。
   *
   * 作成時にも正規化しているが、**それを入れる前に作られた Project**には
   * 生の文字列（例：`"~/"`）が残っている。以前は会話側（turn-runner の cwd）だけが
   * 防御的に直しており、**Module の起動には生のまま渡っていた**——
   * `<どこか>/~` を読もうとして ENOENT で落ちた。
   *
   * **使う側それぞれが直すのをやめ、読むところで1回だけ直す**（規則3）。
   * 直せない（存在しない等）なら、そのまま返す——ここで例外にすると
   * Project の一覧ごと開けなくなる。おかしさは使う側で表に出る。
   */
  getProject(id: ProjectId): ProjectState | undefined {
    const project = this.projection.current.projects.get(id);
    if (!project) return undefined;
    try {
      const root = normalizeProjectRoot(project.root);
      return root === project.root ? project : { ...project, root };
    } catch {
      return project;
    }
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

  /** 人がこのThreadで選んだpermissionModeを残す（決定・2026-09-06）。
   *  UI側だけに置くとリロードで消えるので、hostが持つ。 */
  async setPermissionMode(id: ThreadId, mode: ThreadPermissionMode): Promise<void> {
    if (!this.getThread(id)) throw new NotFoundError(`thread ${id} not found`);
    const event = await this.log.append("thread.permission_mode_set", { id, mode });
    this.projection.applyOne(event);
  }

  async updateResumePoint(id: ThreadId, resumePoint: string): Promise<void> {
    const event = await this.log.append("thread.resume_point_updated", { id, resumePoint });
    this.projection.applyOne(event);
  }

  /**
   * Memoryへの追記。持ち主はProject（決定・2026-09-05）。訂正は無効化イベントの
   * 追記で行う——物理削除・書き換えはしない（item3決定）。上限を超えたら拒否する。
   * `originThreadId`は「どのThreadで決まったか」の出所——走行中のThreadへ差分を
   * 届けるときに使う（§2.3）。人が設定画面から足したときは無し。
   */
  async appendMemory(projectId: ProjectId, text: string, originThreadId?: ThreadId): Promise<void> {
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    if (text.length > MEMORY_ENTRY_MAX_CHARS) {
      throw new MemoryLimitExceededError(
        `Memory entry exceeds ${MEMORY_ENTRY_MAX_CHARS} chars (${text.length})`,
      );
    }
    const event = await this.log.append("memory.appended", { projectId, text, threadId: originThreadId });
    this.projection.applyOne(event);
  }

  async invalidateMemory(projectId: ProjectId, targetSeq: number): Promise<void> {
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    const event = await this.log.append("memory.invalidated", { projectId, targetSeq });
    this.projection.applyOne(event);
  }

  /**
   * 確定後の差分をどこまでターンに添えて届けたかを記録する（決定・2026-09-05）。
   * 届けたことは事実であって他から導出できない——イベントとして残す（規則3）。
   */
  async markMemoryDelivered(threadId: ThreadId, upToSeq: number): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("memory.delivered", { threadId, upToSeq });
    this.projection.applyOne(event);
  }

  /**
   * このThreadのresume-pointを、**他のThreadも指しているか**（決定・2026-09-05）。
   * 2つのThreadが同じSDKセッションを指している状態は不変条件の破れ——会話が
   * 1本に混ざる。2026-09-05より前のデータには実際に存在する（forkSessionを
   * 渡していなかったため）。使う側で検知して枝を分け、**黙って壊れたまま
   * 続けない**（規則2）。
   */
  resumePointSharedWithOtherThread(threadId: ThreadId): boolean {
    const thread = this.getThread(threadId);
    if (!thread?.resumePoint) return false;
    for (const other of this.projection.current.threads.values()) {
      if (other.id !== threadId && other.resumePoint === thread.resumePoint) return true;
    }
    return false;
  }

  /** Projectに積まれているMemory全部（無効化されたものも、印つきで残る）。 */
  getProjectMemory(projectId: ProjectId): MemoryEntry[] {
    return this.getProject(projectId)?.memory ?? [];
  }

  /**
   * このThreadから見たMemoryの2つの束（決定・2026-09-05）。
   * - `established`：**system promptに入れる**分。Thread作成時（畳んだときは
   *   その時点）に確定していて、走行中は動かない（§3「走行中の枝の先頭は変えない」）
   *   ——**確定より後の無効化はここに反映しない**。反映させると先頭が変わる
   * - `pending`：確定より後にProjectへ増えた／無効化された分。**ターンに添えて
   *   届ける**（§2.3）。system promptには入れない
   * どちらも導出——Threadは写しを持たない（規則3）。
   */
  memoryForThread(threadId: ThreadId): MemorySplit {
    const thread = this.getThread(threadId);
    if (!thread) throw new NotFoundError(`thread ${threadId} not found`);
    return splitMemory(
      this.getProjectMemory(thread.projectId),
      thread.memoryBaselineSeq,
      // 既に届けた分は繰り返さない——メッセージ列は追記なので会話に残っている。
      thread.memoryDeliveredSeq,
    );
  }

  /** リロード時の会話表示復元用（決定・2026-09-04）。実行再開はresumePointが担うので、
   *  ここは表示に足るテキストだけを追記する——SDKMessageの生データは持たない。 */
  /**
   * **どの面に出したか**を、その tool 呼び出しの記録に書き足す（決定・2026-09-07）。
   *
   * 決めるのは画面（`ui/request-display-mode`）なので、決まってから届く。
   * 同じ値で二度届いても害は無い（追記のみ、最後の1つが効く）。
   */
  async recordUiToolCallDisplayMode(
    threadId: ThreadId,
    toolCallId: string,
    displayMode: "inline" | "fullscreen",
  ): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("ui-tool-call.display-mode.recorded", {
      threadId,
      toolCallId,
      displayMode,
    });
    this.projection.applyOne(event);
  }

  async appendMessage(
    threadId: ThreadId,
    role: "user" | "assistant",
    text: string,
    /** 画面つき tool の呼び出し（決定・2026-09-07）。リロード後に Module の
     *  画面を出し直すのに要る——ここに残さないと画面だけが消える。 */
    uiToolCalls?: UiToolCallEntry[],
  ): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("message.appended", {
      threadId,
      role,
      text,
      ...(uiToolCalls && uiToolCalls.length > 0 ? { uiToolCalls } : {}),
    });
    this.projection.applyOne(event);
  }

  /** F2/F3——ターンごとの文脈使用量を記録する（turn-runner.tsのappendMessage直後）。
   *  contextUsageはRunnerが返す形をそのまま保存する（規則12）。 */
  async recordUsage(
    threadId: ThreadId,
    contextUsage: unknown,
    compactionCount: number,
    /** Runnerが返した入出力・キャッシュの内訳（決定・2026-09-06）。加工せずそのまま残す。 */
    apiUsage?: unknown,
  ): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("usage.recorded", {
      threadId,
      contextUsage,
      compactionCount,
      apiUsage,
    });
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
