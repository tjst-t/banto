import type { BackgroundWork } from "../delivery/reply-handles.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { projectThreadFold } from "./fold.js";
import { splitMemory, type MemorySplit } from "./memory-split.js";
import type {
  ProjectLocation,
  RuntimeMoveCreated,
  ProjectStart,
  MemoryEntry,
  ProjectId,
  ProjectState,
  ProjectGroupColor,
  ProjectGroupId,
  ProjectGroupState,
  ThreadId,
  ThreadPermissionMode,
  ThreadClosedBy,
  ThreadEffort,
  ThreadState,
  ClaudeAccountSwitchReasonRecord,
  UiToolCallEntry,
  MessageImage,
  MessageQuote,
  TurnSummaryRecord,
  MessageOrigin,
  MessageSender,
  TurnCause,
  CompactionReason,
  TurnContinuation,
  DeliveryAuthor,
  ExternalContent,
  TurnOutcome,
  TurnEndReason,
  ContinuationCancelledBy,
  ProjectKind,
  ProjectSleptBy,
  ProjectWokeCause,
  MissionFrame,
  MissionFollowup,
  MissionStatus,
  MissionWakeCause,
  MissionWakeResult,
  MissionWakeOrigin,
} from "./types.js";
import { PROJECT_GROUP_COLORS } from "./types.js";
import { findInterruptedTurns, type InterruptedTurn } from "./interrupted-turns.js";
import type { SessionSkillSet } from "../skills/types.js";
import { sameSkillSet } from "../skills/activation.js";
import { rootIsOnThisMachine } from "../runtime/runtime-kind.js";

/** Memory 1件あたりの文字数上限。超えたら追記を拒否する（item3決定）。 */
export const MEMORY_ENTRY_MAX_CHARS = 20_000;

export class MemoryLimitExceededError extends Error {}
/** 別のサーバの Project には、まだできないこと（根を変える等） */
export class RemoteProjectError extends Error {}
/** 別の実行場所へ移している途中・移している途中ではない */
export class RuntimeMoveConflictError extends Error {}
/** 眠らせられない（閉じた・もう眠っている）（409） */
export class ProjectSleepConflictError extends Error {}
/** チャットにしかできないこと（Project にする）を、普通の Project に頼んだ（409） */
export class NotChatProjectError extends Error {}

export class NotFoundError extends Error {}
export class InvalidProjectRootError extends Error {}
/** グループの名前・色が決まりに合わない（400） */
export class InvalidProjectGroupError extends Error {}
/** 同じ名前のグループがもうある（409）——大文字小文字は区別しない */
export class ProjectGroupConflictError extends Error {}

/** グループの名前の長さ（前後の空白を落としたあと） */
export const PROJECT_GROUP_NAME_MAX_CHARS = 40;

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
  private readonly projectsChangedListeners = new Set<() => void>();
  private readonly missionChangedListeners = new Set<(threadId: ThreadId) => void>();

  constructor(
    private readonly dataDir: string,
    private readonly log: EventLog,
  ) {
    // v3：ThreadにownsSession（親から借りたresume-pointか、自分のセッションか）
    // を足した（決定・2026-09-05）。v2以前には無いので読まずに作り直す。
    // v2でMemoryをProject持ちにした変更もここに含まれる。
    // v9：ThreadState に lastTurn（ターンの進み具合）を足した（2026-10-05）。read model の形を変えたので上げる
    //     （前の snapshot に turn.started は無いので、畳み直しても中身は同じ。起動1回ぶんログを読み直す）
    // v8：「どの面に出したか」を、会話より先に届いても取りこぼさないように
    //     read model に預かり場所を足した（実測・2026-09-07）
    // v7：UiToolCallEntry に displayMode、ThreadState に createdSeq を足した
    //     （決定・2026-09-07。古いスナップショットには無いので畳み直す）
    // v6：MessageEntry に uiToolCalls を足した（決定・2026-09-07）
    // v10：ProjectState に kind（チャット）を足した（2026-10-21、アーキ仕様 §2.2「チャット」）。read model の形を変えたので上げる
    // （上げていない：2026-09-25 に足した deliveries・awaitingReplies・MessageEntry.origin は、新しいイベントからしか
    //  生まれない——前の snapshot に畳み直すべきものが無い）
    this.projection = new SnapshotProjection(dataDir, "project-thread", log, projectThreadFold, 10);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }

  /**
   * **Project の一覧が変わった**（決定・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。作る・名前・並び・閉じる・
   * 開き直す・グループ。中身は渡さない——聞き手（`GET /api/events` の `projects.changed`）は画面に取り直させる
   */
  onProjectsChanged(listener: () => void): () => void {
    this.projectsChangedListeners.add(listener);
    return () => this.projectsChangedListeners.delete(listener);
  }

  private notifyProjectsChanged(): void {
    for (const listener of this.projectsChangedListeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[host] Project の一覧の変更の聞き手が例外を投げました:", err);
      }
    }
  }

  /**
   * **会話の任務が変わった**（追加・2026-10-20、v4-frontend.md §6.47）。始めた・枠・予約・起きた・終わった、と会話・Project を
   * 閉じて止まったとき。中身は渡さない——聞き手（`GET /api/events` の `mission.changed`）が今の任務を読む
   */
  onMissionChanged(listener: (threadId: ThreadId) => void): () => void {
    this.missionChangedListeners.add(listener);
    return () => this.missionChangedListeners.delete(listener);
  }

  private notifyMissionChanged(threadId: ThreadId): void {
    for (const listener of this.missionChangedListeners) {
      try {
        listener(threadId);
      } catch (err) {
        console.warn("[host] 任務の変更の聞き手が例外を投げました:", err);
      }
    }
  }

  async save(): Promise<void> {
    await this.projection.save();
  }

  listProjects(): ProjectState[] {
    // 一覧も1件取りと同じ姿で返す（下の getProject のコメント、規則3）
    const projects = Array.from(this.projection.current.projects.keys())
      .map((id) => this.getProject(id))
      .filter((p): p is ProjectState => p !== undefined);
    // **並べるのは読むとき**（決定・2026-09-11）——並び順は1つのイベントで
    // 持っているので、各 Project に番号を写さない（規則3）
    // 前からある snapshot には並び順の欄が無い（後から足した）——空として扱う
    return sortByExplicitOrder(projects, this.projection.current.projectOrder ?? []);
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
    // 別のサーバの根は、作るときに向こうで正規化した文字列をそのまま使う（この機械の realpath に通さない）
    if (!rootIsOnThisMachine(project.runtime)) return project;
    try {
      const root = normalizeProjectRoot(project.root);
      return root === project.root ? project : { ...project, root };
    } catch {
      return project;
    }
  }

  /**
   * **会話の本体（Runner）の作業ディレクトリ**（v4-security.md §1「Project の記録に実行場所を持つ」）。CLI の記録の置き場の
   * 鍵でもあるので、ターンの始まり（`http/app.ts`）と起こし直しをまたぐ続き（`delivery/turn-continuation.ts`）はこれだけで引く。
   * この機械の Project は根（正規化したもの。直せなければ `InvalidProjectRootError`）。別のサーバの Project の根は
   * この機械に無い——データの置き場の中に Project の id で決まる空のフォルダを作って使う（同じ id なら起こし直しても同じ）
   */
  runnerCwd(project: Pick<ProjectState, "id" | "root" | "runtime">): string {
    if (rootIsOnThisMachine(project.runtime)) return normalizeProjectRoot(project.root);
    const dir = join(this.dataDir, "runner-cwd", project.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  listThreadsForProject(projectId: ProjectId): ThreadState[] {
    const threads = Array.from(this.projection.current.threads.values()).filter(
      (t) => t.projectId === projectId,
    );
    // Base は常に先頭（会話の幹）。人が並べ替えられるのは Fork だけ
    const base = threads.filter((t) => t.kind !== "fork");
    const forks = sortByExplicitOrder(
      threads.filter((t) => t.kind === "fork"),
      this.projection.current.threadOrder?.get(projectId) ?? [],
    );
    return [...base, ...forks];
  }

  getThread(id: ThreadId): ThreadState | undefined {
    return this.projection.current.threads.get(id);
  }

  /**
   * **承認なしでメッセージを受け取ってよい Project の一覧を置き換える**（決定・2026-10-01、アーキ仕様 §4.2）。
   * 重なりと自分自身は落とす
   */
  async setMessageSenders(id: ProjectId, senders: readonly ProjectId[]): Promise<ProjectState> {
    if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    const unique = [...new Set(senders)].filter((s) => s !== id);
    const event = await this.log.append("project.message_senders_set", { id, senders: unique });
    this.projection.applyOne(event);
    return this.getProject(id)!;
  }

  async renameProject(id: ProjectId, name: string): Promise<ProjectState> {
    if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    const event = await this.log.append("project.renamed", { id, name });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return this.getProject(id)!;
  }

  /**
   * **チャットを Project にする**（決定・2026-10-21、アーキ仕様 §2.2「チャット」）。`kind` を外し、名前を替える。会話・Memory・
   * Fork はそのまま。フォルダを移す・グループに入れるのは呼び手（`setProjectRoot`・`assignProjectGroup`）
   */
  async promoteProject(id: ProjectId, name: string): Promise<ProjectState> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (project.kind !== "chat") throw new NotChatProjectError("この Project はチャットではありません");
    const event = await this.log.append("project.promoted", { id, name });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return this.getProject(id)!;
  }

  /**
   * **Project の根を変える**（決定・2026-09-11、ユーザー要望）。
   * 根は閉じ込めの範囲そのもの——変えたら、その Project の Module は
   * **立て直す**必要がある（呼び出し側が `releaseProjectModules`）。
   */
  async setProjectRoot(id: ProjectId, root: string): Promise<ProjectState> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    // 向こうで正規化し直す口はまだ無い——この機械の realpath で確かめると、向こうのパスを「無い」と断るか、この機械の
    // 同じ文字列のフォルダに化ける。黙ってどちらかにしない
    if (!rootIsOnThisMachine(project.runtime)) {
      throw new RemoteProjectError("別のサーバで動く Project の根は、まだ変えられません");
    }
    if (project.move) throw new RuntimeMoveConflictError("この Project はいま別の実行場所へ移しています");
    // 作るときと同じ検め方を通す（規則3——2通りの正規化を持たない）
    const resolved = normalizeProjectRoot(root);
    const event = await this.log.append("project.root_changed", { id, root: resolved });
    this.projection.applyOne(event);
    return this.getProject(id)!;
  }

  /**
   * **別の実行場所へ移し始めた**（v4-security.md §1「Project を別の実行場所へ移す」の 4）。これが積まれている間、その
   * Project のターンは断り、届いたものは留める。中身の確かめ（動いているもの・移す先）は呼び手（`runtime/project-move.ts`）
   */
  async startRuntimeMove(
    id: ProjectId,
    move: { from: ProjectLocation; to: ProjectLocation; created: RuntimeMoveCreated },
  ): Promise<ProjectState> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (project.move) throw new RuntimeMoveConflictError("この Project はいま別の実行場所へ移しています");
    // 確かめてから記録するまでの間に眠らせた（移す側が先に断るが、記録の手前でもう一度）
    if (project.sleep) throw new RuntimeMoveConflictError("この Project は眠っています。先に起こしてから移してください");
    const event = await this.log.append("project.runtime_move_started", { id, ...move });
    this.projection.applyOne(event);
    return this.getProject(id)!;
  }

  /** **切り替える**（同じ 5）。この機械へ戻るときも `to.runtime` は `host-container` を明示する */
  async finishRuntimeMove(id: ProjectId, move: { from: ProjectLocation; to: ProjectLocation }): Promise<ProjectState> {
    const project = this.getProject(id);
    if (!project?.move) throw new RuntimeMoveConflictError(`project ${id} は移している途中ではありません`);
    const event = await this.log.append("project.runtime_moved", { id, from: move.from, to: move.to });
    this.projection.applyOne(event);
    return this.getProject(id)!;
  }

  /** **切り替えずに終える**（同じ 6） */
  async failRuntimeMove(id: ProjectId, reason: string): Promise<void> {
    const project = this.getProject(id);
    if (!project?.move) throw new RuntimeMoveConflictError(`project ${id} は移している途中ではありません`);
    const event = await this.log.append("project.runtime_move_failed", { id, reason });
    this.projection.applyOne(event);
  }

  /**
   * **始め方の仕事の記録を置き換える**（追加・2026-10-20、v4-frontend.md §6.49）。中身の確かめ（1本ずつ・流す順）は呼び手
   * （`runtime/project-start.ts`）
   */
  async setProjectStart(id: ProjectId, start: ProjectStart): Promise<ProjectState> {
    if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    const event = await this.log.append("project.start_changed", { id, start });
    this.projection.applyOne(event);
    return this.getProject(id)!;
  }

  async renameThread(id: ThreadId, title: string): Promise<ThreadState> {
    if (!this.getThread(id)) throw new NotFoundError(`thread ${id} not found`);
    const event = await this.log.append("thread.renamed", { id, title });
    this.projection.applyOne(event);
    return this.getThread(id)!;
  }

  /** Project の並び。**知らない id は受け取らない**——順番の中に幽霊を作らない（規則2）。 */
  async setProjectOrder(ids: ProjectId[]): Promise<void> {
    for (const id of ids) {
      if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    }
    const event = await this.log.append("project.order.set", { ids });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
  }

  /** **グループ**（決定・2026-10-16、アーキ仕様 §2.2）。人が決めた並びの順。並びに無いものは後ろに作った順（fail open） */
  listProjectGroups(): ProjectGroupState[] {
    return sortByExplicitOrder(
      Array.from(this.projection.current.projectGroups.values()),
      this.projection.current.projectGroupOrder,
    );
  }

  getProjectGroup(id: ProjectGroupId): ProjectGroupState | undefined {
    return this.projection.current.projectGroups.get(id);
  }

  /** `color` を省けば、まだ使っていない色を決めた順に（全部使っていれば数で回す） */
  async createProjectGroup(input: { name: unknown; color?: unknown }): Promise<ProjectGroupState> {
    const name = this.checkGroupName(input.name);
    let color: ProjectGroupColor;
    if (input.color === undefined) {
      const used = new Set(Array.from(this.projection.current.projectGroups.values(), (g) => g.color));
      color =
        PROJECT_GROUP_COLORS.find((c) => !used.has(c)) ??
        PROJECT_GROUP_COLORS[this.projection.current.projectGroups.size % PROJECT_GROUP_COLORS.length]!;
    } else {
      color = checkGroupColor(input.color);
    }
    const id = randomUUID();
    const event = await this.log.append("project.group.created", { id, name, color });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return this.getProjectGroup(id)!;
  }

  async updateProjectGroup(id: ProjectGroupId, input: { name?: unknown; color?: unknown }): Promise<ProjectGroupState> {
    if (!this.getProjectGroup(id)) throw new NotFoundError(`project group ${id} not found`);
    const name = input.name === undefined ? undefined : this.checkGroupName(input.name, id);
    const color = input.color === undefined ? undefined : checkGroupColor(input.color);
    const event = await this.log.append("project.group.updated", {
      id,
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color } : {}),
    });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return this.getProjectGroup(id)!;
  }

  /** なくしても中の Project は消えない——「グループなし」へ出る（fold） */
  async removeProjectGroup(id: ProjectGroupId): Promise<void> {
    if (!this.getProjectGroup(id)) throw new NotFoundError(`project group ${id} not found`);
    const event = await this.log.append("project.group.removed", { id });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
  }

  /** グループの並び。知らない id は受け取らない（`setProjectOrder` と同じ） */
  async setProjectGroupOrder(ids: ProjectGroupId[]): Promise<void> {
    for (const id of ids) {
      if (!this.getProjectGroup(id)) throw new NotFoundError(`project group ${id} not found`);
    }
    const event = await this.log.append("project.group.order.set", { ids });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
  }

  /**
   * **Project をグループに入れる・出す**（`groupId: null` で「グループなし」）。`order` を添えると、そこでの位置（Project 全部の
   * 新しい並び）も同じ出来事で書く。無いグループ・知らない Project は断る
   */
  async assignProjectGroup(projectId: ProjectId, groupId: ProjectGroupId | null, order?: ProjectId[]): Promise<ProjectState> {
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    if (groupId !== null && !this.getProjectGroup(groupId)) throw new NotFoundError(`project group ${groupId} not found`);
    for (const id of order ?? []) {
      if (!this.getProject(id)) throw new NotFoundError(`project ${id} not found`);
    }
    const event = await this.log.append("project.group.assigned", { projectId, groupId, ...(order ? { order } : {}) });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return this.getProject(projectId)!;
  }

  /** 前後の空白を落として 1〜40 字、同じ名前（大文字小文字は区別しない）は断る。`self` は直すときの自分 */
  private checkGroupName(raw: unknown, self?: ProjectGroupId): string {
    if (typeof raw !== "string") throw new InvalidProjectGroupError("グループの名前は文字列で渡してください");
    const name = raw.trim();
    if (name.length === 0) throw new InvalidProjectGroupError("グループの名前が空です");
    if ([...name].length > PROJECT_GROUP_NAME_MAX_CHARS) {
      throw new InvalidProjectGroupError(`グループの名前は ${PROJECT_GROUP_NAME_MAX_CHARS} 字までです`);
    }
    const key = name.toLocaleLowerCase();
    for (const g of this.projection.current.projectGroups.values()) {
      if (g.id !== self && g.name.toLocaleLowerCase() === key) {
        throw new ProjectGroupConflictError(`「${g.name}」という名前のグループがもうあります`);
      }
    }
    return name;
  }

  /** その Project の Fork の並び。 */
  async setForkOrder(projectId: ProjectId, ids: ThreadId[]): Promise<void> {
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    for (const id of ids) {
      const thread = this.getThread(id);
      if (!thread) throw new NotFoundError(`thread ${id} not found`);
      if (thread.projectId !== projectId) {
        throw new NotFoundError(`thread ${id} is not in project ${projectId}`);
      }
    }
    const event = await this.log.append("thread.order.set", { projectId, ids });
    this.projection.applyOne(event);
  }

  /**
   * `remote`：別のサーバで動かすとき（決定・2026-10-08）。`root` は呼び手が**向こうで**正規化したものをそのまま記録する
   * ——この機械には無いので、ここでは確かめない
   *
   * `kind`：チャット（決定・2026-10-21、アーキ仕様 §2.2「チャット」）。無ければ普通の Project
   */
  async createProject(name: string, root: string, opts?: { runtime?: string; kind?: ProjectKind }): Promise<ProjectState> {
    const resolvedRoot = opts?.runtime ? root : normalizeProjectRoot(root);
    const id = randomUUID();
    const event = await this.log.append("project.created", {
      id,
      name,
      root: resolvedRoot,
      ...(opts?.runtime ? { runtime: opts.runtime } : {}),
      ...(opts?.kind ? { kind: opts.kind } : {}),
    });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    const project = this.getProject(id);
    if (!project) throw new Error("invariant: project.created did not produce a project");
    return project;
  }

  async closeProject(id: ProjectId): Promise<void> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (project.move) throw new RuntimeMoveConflictError("この Project はいま別の実行場所へ移しています");
    const withMission = this.listThreadsForProject(id).filter((t) => t.mission?.status === "active").map((t) => t.id);
    const event = await this.log.append("project.closed", { id });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    // 閉じると動いている任務は止まる（fold）
    for (const threadId of withMission) this.notifyMissionChanged(threadId);
  }

  /**
   * **眠らせた**と記録する（決定・2026-10-16、アーキ仕様 §2.2「スリープ」）。確かめる（忙しいか・印）のと片づけるのは
   * 呼ぶ側（`runtime/project-sleep.ts`）。閉じた・移している途中・もう眠っているものは断る
   */
  async sleepProject(id: ProjectId, by: ProjectSleptBy): Promise<ProjectState> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (project.status === "closed") throw new ProjectSleepConflictError("閉じた Project は眠らせられません");
    if (project.move) throw new RuntimeMoveConflictError("この Project はいま別の実行場所へ移しています");
    if (project.sleep) throw new ProjectSleepConflictError("この Project はもう眠っています");
    const event = await this.log.append("project.slept", { id, by });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return this.getProject(id)!;
  }

  /** **起きた**と記録する。眠っていなければ何も積まず false（冪等——同時に呼ぶ側の束ねは `runtime/project-sleep.ts`） */
  async wakeProject(id: ProjectId, cause: ProjectWokeCause): Promise<boolean> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (!project.sleep) return false;
    const event = await this.log.append("project.woke", { id, cause });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
    return true;
  }

  async reopenProject(id: ProjectId): Promise<void> {
    const project = this.getProject(id);
    if (!project) throw new NotFoundError(`project ${id} not found`);
    if (project.move) throw new RuntimeMoveConflictError("この Project はいま別の実行場所へ移しています");
    const event = await this.log.append("project.reopened", { id });
    this.projection.applyOne(event);
    this.notifyProjectsChanged();
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
  /**
   * 枝を分ける。**過去のメッセージの時点からも分けられる**（決定・2026-09-11、
   * ユーザー要望）——`fromSeq` を渡すと、その時点のセッションへ戻して始める。
   * **Clear の前のやり取りからも分けられる**：Clear は「次のターンで
   * resume-point を渡さない」だけで、手放したセッションの id は履歴に残っている。
   */
  async forkThread(
    parentThreadId: ThreadId,
    /** `fresh`：会話を引き継がず、まっさらな会話で始める（追加・2026-10-01、§4.2——Project だけを宛先にしたメッセージ） */
    /**
     * `restriction`：読むだけの回として立てる（追加・2026-10-20、アーキ仕様 §4.4）。**読むだけの会話から分けた Fork は、
     * 渡さなくても読むだけ**——外の文を読んだ文脈を、分けるだけでふつうの会話に戻さない
     */
    options: { resumePoint?: string; fromSeq?: number; title?: string; fresh?: boolean; restriction?: "read-only" } = {},
  ): Promise<ThreadState> {
    const parent = this.getThread(parentThreadId);
    if (!parent) throw new NotFoundError(`thread ${parentThreadId} not found`);
    const restriction = options.restriction ?? parent.restriction;
    const resumePoint = options.fresh
      ? undefined
      : (options.resumePoint ??
        (options.fromSeq === undefined
          ? parent.resumePoint
          : this.resumePointAsOf(parent, options.fromSeq)));
    const id = randomUUID();
    const event = await this.log.append("thread.created", {
      id,
      projectId: parent.projectId,
      kind: "fork" as const,
      parentThreadId,
      resumePoint,
      forkedFromSeq: options.fromSeq,
      ...(options.title ? { title: options.title } : {}),
      ...(options.fresh ? { fresh: true } : {}),
      ...(restriction ? { restriction } : {}),
    });
    this.projection.applyOne(event);
    return this.mustGetThread(id);
  }

  /**
   * その seq の時点で、この Thread がどのセッションだったか。
   * **無ければ undefined**——その時点ではまだ1度も走っていない（新しい会話として始まる）。
   */
  private resumePointAsOf(thread: ThreadState, seq: number): string | undefined {
    let found: string | undefined;
    for (const entry of thread.resumePoints ?? []) {
      if (entry.seq <= seq) found = entry.sessionId;
      else break;
    }
    return found;
  }

  /**
   * 閉じる。`by`・`reason` は記録に残す（追加・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）
   */
  async closeThread(id: ThreadId, opts?: { by: ThreadClosedBy; reason?: string }): Promise<void> {
    const thread = this.getThread(id);
    if (!thread) throw new NotFoundError(`thread ${id} not found`);
    const event = await this.log.append("thread.closed", {
      id,
      ...(opts ? { by: opts.by } : {}),
      ...(opts?.reason ? { reason: opts.reason } : {}),
    });
    this.projection.applyOne(event);
    // 閉じると動いている任務は止まる（fold）
    if (thread.mission?.status === "active") this.notifyMissionChanged(id);
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

  /** 人がこの Thread で選んだモデルと effort を残す（決定・2026-09-23）。null は既定へ戻す。 */
  async setModel(id: ThreadId, model: string | null, effort: ThreadEffort | null): Promise<void> {
    if (!this.getThread(id)) throw new NotFoundError(`thread ${id} not found`);
    const event = await this.log.append("thread.model_set", { id, model, effort });
    this.projection.applyOne(event);
  }

  /** `anchor`：そのターンの最後のやり取り（最後まで走ったターンだけ渡す——§6.31） */
  async updateResumePoint(id: ThreadId, resumePoint: string, anchor?: string): Promise<void> {
    const event = await this.log.append("thread.resume_point_updated", {
      id,
      resumePoint,
      ...(anchor ? { anchor } : {}),
    });
    this.projection.applyOne(event);
  }

  /**
   * **ターンを始めた**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。ターンの id を返す
   * ——同じ id で `recordTurnSessionKnown`・`endTurn` を書く
   */
  async startTurn(
    threadId: ThreadId,
    input: {
      cause: TurnCause;
      attempt: number;
      resumePoint?: string;
      rewindTo?: string;
      sessionId?: string;
      /** 起こし直しで切れたターンの続きなら、続けたターンとその会話の始まり（追加・2026-10-05）。上限で止まったターンの続きは `reason` */
      continues?: { turnId: string; fromSeq: number; reason?: "rate_limit" };
    },
  ): Promise<string> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const turnId = randomUUID();
    const event = await this.log.append("turn.started", {
      threadId,
      turnId,
      cause: input.cause,
      attempt: input.attempt,
      ...(input.resumePoint !== undefined ? { resumePoint: input.resumePoint } : {}),
      ...(input.rewindTo !== undefined ? { rewindTo: input.rewindTo } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.continues ? { continues: input.continues } : {}),
    });
    this.projection.applyOne(event);
    return turnId;
  }

  /** Runner の `system/init` で会話の id が分かった。**resume-point は変えない**（`updateResumePoint` は今どおり最後に） */
  async recordTurnSessionKnown(threadId: ThreadId, turnId: string, sessionId: string): Promise<void> {
    const event = await this.log.append("turn.session_known", { threadId, turnId, sessionId });
    this.projection.applyOne(event);
  }

  async endTurn(
    threadId: ThreadId,
    turnId: string,
    outcome: TurnOutcome,
    /** Claude の使用量の上限で終わったなら、その印と自動で続ける時刻（追加・2026-10-18、v4-security.md §2 の 9.） */
    end?: { reason: TurnEndReason; continueAt?: string },
  ): Promise<void> {
    const event = await this.log.append("turn.ended", {
      threadId,
      turnId,
      outcome,
      ...(end ? { reason: end.reason } : {}),
      ...(end?.continueAt !== undefined ? { continueAt: end.continueAt } : {}),
    });
    this.projection.applyOne(event);
  }

  /**
   * **上限の待ちを消す**（`turn.continuation_cancelled`、追加・2026-10-18、v4-security.md §2 の 9.）——人が「待つのをやめる」・
   * 止めるボタン。そのターンがまだ Thread の最後のターンのときだけ意味を持つ（fold が見る）
   */
  async cancelContinuation(threadId: ThreadId, turnId: string, by: ContinuationCancelledBy): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("turn.continuation_cancelled", { threadId, turnId, by });
    this.projection.applyOne(event);
  }

  /** **起こし直しで切れたターン**（`findInterruptedTurns`）。起き直した直後、何かを走らせる前に読む */
  listInterruptedTurns(): InterruptedTurn[] {
    return findInterruptedTurns(this.projection.current.threads.values());
  }

  /**
   * **人が止めて取り消した発言を、会話から外す**（決定・2026-10-01、v4-frontend.md §6.31）。記録は追記のまま
   * （消したことを積む）。`rewindTo` を渡すと、次のターンは CLI のセッションをそこまでで切って続ける
   */
  async withdrawMessage(threadId: ThreadId, seq: number, rewindTo?: string): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("message.withdrawn", { threadId, seq, ...(rewindTo ? { rewindTo } : {}) });
    this.projection.applyOne(event);
  }

  /**
   * Memoryへの追記。持ち主はProject（決定・2026-09-05）。訂正は無効化イベントの
   * 追記で行う——物理削除・書き換えはしない（item3決定）。上限を超えたら拒否する。
   * `originThreadId`は「どのThreadで決まったか」の出所——走行中のThreadへ差分を
   * 届けるときに使う（§2.3）。人が設定画面から足したときは無し。
   */
  async appendMemory(projectId: ProjectId, text: string, originThreadId?: ThreadId): Promise<number> {
    if (!this.getProject(projectId)) throw new NotFoundError(`project ${projectId} not found`);
    if (text.length > MEMORY_ENTRY_MAX_CHARS) {
      throw new MemoryLimitExceededError(
        `Memory entry exceeds ${MEMORY_ENTRY_MAX_CHARS} chars (${text.length})`,
      );
    }
    const event = await this.log.append("memory.appended", { projectId, text, threadId: originThreadId });
    this.projection.applyOne(event);
    return event.seq;
  }

  /**
   * 取り消す。`reason`・`replacedBy` は AI が `revise_memory` で頼み人が許したとき（追加・2026-10-15、§2.2）。
   * もう取り消してある行には何もしない（`false` を返す。fold も2回目を無視するが、記録を積まない）
   */
  async invalidateMemory(
    projectId: ProjectId,
    targetSeq: number,
    opts: { reason?: string; replacedBy?: number } = {},
  ): Promise<boolean> {
    const project = this.getProject(projectId);
    if (!project) throw new NotFoundError(`project ${projectId} not found`);
    if (project.memory.find((m) => m.seq === targetSeq)?.invalidatedAtSeq !== undefined) return false;
    const event = await this.log.append("memory.invalidated", {
      projectId,
      targetSeq,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.replacedBy !== undefined ? { replacedBy: opts.replacedBy } : {}),
    });
    this.projection.applyOne(event);
    return true;
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
    /** 機械から届いたものの印（追加・2026-09-25）。**人の発言には付けない** */
    origin?: MessageOrigin,
    /** 人が添えた画像（追加・2026-09-26）。**中身は先に画像の置き場へ置いておく**——ここは名前だけを残す */
    images?: MessageImage[],
    /** Module の画面から人が添えたもの（追加・2026-10-15）。人の文とは分けて残す */
    quotes?: MessageQuote[],
  ): Promise<number> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("message.appended", {
      threadId,
      role,
      text,
      ...(uiToolCalls && uiToolCalls.length > 0 ? { uiToolCalls } : {}),
      ...(origin ? { origin } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      ...(quotes && quotes.length > 0 ? { quotes } : {}),
    });
    this.projection.applyOne(event);
    return event.seq;
  }

  /**
   * **中継の承認のカードを会話に残す**（追加・2026-10-05、`docs/notes/2026-10-05-relay-card-stop-keep.md`）。そのターンの AI の
   * 発言に、判断待ちの id だけを足す（fold が同じターンの発言にまとめる）。中身は受信箱にあり、ここに写さない（規則3）
   */
  async recordJudgmentCard(threadId: ThreadId, judgmentId: string): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("message.appended", { threadId, role: "assistant", text: "", judgmentIds: [judgmentId] });
    this.projection.applyOne(event);
  }

  /**
   * **ターンの終わりのまとめを会話に残す**（追加・2026-10-06、アーキ仕様 §2.2）。そのターンの AI の発言に足す（fold が同じ
   * ターンの発言にまとめ、後から来たもので置き換える）
   */
  async recordTurnSummary(threadId: ThreadId, entry: TurnSummaryRecord): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("message.appended", { threadId, role: "assistant", text: "", turnSummary: entry });
    this.projection.applyOne(event);
  }

  /** **任務を始める**（追加・2026-10-20、アーキ仕様 §4.4）。確かめる（枠・動いている任務が無いか）のは `mission/missions.ts` */
  async startMission(
    threadId: ThreadId,
    input: { missionId: string; goal: string; doneWhen: string; frame: MissionFrame; by: "ai" | "human" },
  ): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    this.projection.applyOne(await this.log.append("mission.started", { threadId, ...input }));
    this.notifyMissionChanged(threadId);
  }

  async updateMissionFrame(threadId: ThreadId, missionId: string, frame: MissionFrame, reactivate = false): Promise<void> {
    this.projection.applyOne(
      await this.log.append("mission.updated", { threadId, missionId, frame, ...(reactivate ? { reactivate: true } : {}) }),
    );
    this.notifyMissionChanged(threadId);
  }

  async setMissionFollowup(threadId: ThreadId, missionId: string, followup: MissionFollowup | null): Promise<void> {
    this.projection.applyOne(await this.log.append("mission.followup_set", { threadId, missionId, followup }));
    this.notifyMissionChanged(threadId);
  }

  async recordMissionWake(
    threadId: ThreadId,
    input: { missionId: string; wake: number; cause: MissionWakeCause; scheduledFor?: string },
  ): Promise<void> {
    this.projection.applyOne(await this.log.append("mission.woke", { threadId, ...input }));
    this.notifyMissionChanged(threadId);
  }

  async settleMissionWake(threadId: ThreadId, missionId: string, wake: number, result: MissionWakeResult): Promise<void> {
    this.projection.applyOne(await this.log.append("mission.wake_settled", { threadId, missionId, wake, result }));
    this.notifyMissionChanged(threadId);
  }

  async finishMission(threadId: ThreadId, missionId: string, status: Exclude<MissionStatus, "active">, result?: string): Promise<void> {
    this.projection.applyOne(
      await this.log.append("mission.finished", { threadId, missionId, status, ...(result ? { result } : {}) }),
    );
    this.notifyMissionChanged(threadId);
  }

  /**
   * **Thread に届いたものを残す**（決定・2026-09-25、アーキ仕様 §4.2）。会話にはまだ積まない——積むのは
   * ターンを始めるとき（`appendMessage` の origin）。先に残すので、起こす前に host が落ちても消えない
   */
  async recordDelivery(input: {
    threadId: ThreadId;
    deliveryId: string;
    from: string;
    title: string;
    text: string;
    hop: number;
    sender?: MessageSender;
    /** 起こし直しで切れたターンの続き（追加・2026-10-05）。ほかの届いたものより先に積まれる */
    continues?: TurnContinuation;
    /** 中の指示に従ってよい書き手（追加・2026-10-15）。無ければ外から来たもの */
    kind?: DeliveryAuthor;
    /** 自動化の1回分（追加・2026-10-15、アーキ仕様 §4.3） */
    automation?: { id: string; runId: string };
    /** 任務の予約で起こした回（追加・2026-10-20、アーキ仕様 §4.4） */
    mission?: MissionWakeOrigin;
    /** 外から来たもの（Webhook で受けた本文、アーキ仕様 §4.3） */
    external?: ExternalContent[];
  }): Promise<void> {
    if (!this.getThread(input.threadId)) throw new NotFoundError(`thread ${input.threadId} not found`);
    const event = await this.log.append("delivery.received", input);
    this.projection.applyOne(event);
  }

  /** 返事待ちの札を残す（Module が「あとで届ける」と言った）。 */
  async recordAwaitingReply(input: {
    threadId: ThreadId;
    replyTo: string;
    connName: string;
    moduleName: string;
    hop: number;
    work?: BackgroundWork;
  }): Promise<void> {
    if (!this.getThread(input.threadId)) throw new NotFoundError(`thread ${input.threadId} not found`);
    const event = await this.log.append("reply.awaiting", input);
    this.projection.applyOne(event);
  }

  /**
   * **起こし直しのあと Module が続けると答えた**（追加・2026-10-05、アーキ仕様 §2.5「2.」）。札は返事待ちのまま、
   * 続けると答えた時刻を残す（画面の「起こし直しのあと続けています」）
   */
  async markReplyKept(threadId: ThreadId, replyTo: string, opts: { after?: "disconnect" } = {}): Promise<void> {
    const t = this.getThread(threadId);
    if (!t?.awaitingReplies?.some((r) => r.replyTo === replyTo)) return;
    // `after`：banto は動いたまま Module との接続が切れたあと（Backlog #362）。無ければ起こし直しのあと
    const event = await this.log.append("reply.kept", { threadId, replyTo, ...(opts.after ? { after: opts.after } : {}) });
    this.projection.applyOne(event);
  }

  /**
   * **届け直せる印を残す**（追加・2026-10-16、Backlog #324）。起こし直しで Module に繋がらないまま打ち切った札。繋がったら
   * 打ち切った札として問い直す（問い直すとき `recordAwaitingReply` で返事待ちに戻すと、印は消える）
   */
  async markReplyRedeliverable(input: {
    threadId: ThreadId;
    replyTo: string;
    connName: string;
    moduleName: string;
    hop: number;
    work?: BackgroundWork;
    /** banto は動いたまま、接続が切れて打ち切った（Backlog #362） */
    after?: "disconnect";
  }): Promise<void> {
    if (!this.getThread(input.threadId)) throw new NotFoundError(`thread ${input.threadId} not found`);
    const event = await this.log.append("reply.redeliverable", input);
    this.projection.applyOne(event);
  }

  /** 返事が済んだ（届いた・代わりに「途中で終わりました」を届けた）。 */
  async settleReply(threadId: ThreadId, replyTo: string): Promise<void> {
    const t = this.getThread(threadId);
    if (!t?.awaitingReplies?.some((r) => r.replyTo === replyTo)) return;
    const event = await this.log.append("reply.settled", { threadId, replyTo });
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

  /**
   * **新しいセッションで効かせる Skill の集合を、その会話に刻む**（決定・2026-09-23、§5.7）。
   * 直前に刻んだものと同じなら刻まない——同じ記録で埋めない。
   */
  async fixSessionSkills(threadId: ThreadId, set: SessionSkillSet): Promise<void> {
    const thread = this.getThread(threadId);
    if (!thread) throw new NotFoundError(`thread ${threadId} not found`);
    if (sameSkillSet(currentSkillSet(thread), set)) return;
    const event = await this.log.append("thread.skills_fixed", { threadId, set });
    this.projection.applyOne(event);
  }

  /**
   * **Claude のアカウントを切り替えたことを記録する**（追加・2026-10-18、v4-security.md §2「Claude のアカウントを複数持つ」の 6.）。
   * Thread はその Project のものだけ載せる（違えば外して Project の記録だけにする——中継が受けた印をそのまま信じない）
   */
  async recordClaudeAccountSwitch(input: {
    projectId: ProjectId;
    threadId?: ThreadId;
    from: string;
    to: string;
    reason: ClaudeAccountSwitchReasonRecord;
    allOver?: true;
  }): Promise<void> {
    if (!this.getProject(input.projectId)) throw new NotFoundError(`project ${input.projectId} not found`);
    const thread = input.threadId ? this.getThread(input.threadId) : undefined;
    const { threadId: _threadId, ...rest } = input;
    const event = await this.log.append("claude_account.switched", {
      ...rest,
      ...(thread && thread.projectId === input.projectId ? { threadId: thread.id } : {}),
    });
    this.projection.applyOne(event);
  }

  /** 自動の要約（SDK の compact_boundary）が起きたターンを記録する（改訂・2026-10-09、v4-architecture.md §2.2）。
   *  foldがこれを見て、system promptに入れるMemoryを確定し直す。`reason: "idle"` は空いた会話の冷める前の要約（§3.1）
   *  ——会話に印が出る */
  async recordCompaction(threadId: ThreadId, compactionCount: number, reason?: CompactionReason): Promise<void> {
    if (!this.getThread(threadId)) throw new NotFoundError(`thread ${threadId} not found`);
    const event = await this.log.append("thread.compacted", { threadId, compactionCount, ...(reason ? { reason } : {}) });
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

/**
 * 人が決めた並びに合わせる（決定・2026-09-11）。
 *
 * **並びに無いものは後ろへ、元の順のまま**——並べ替えたことのないもの・
 * 並べ替えた後に作られたものが、一覧から消えない（fail open）。
 */
function checkGroupColor(raw: unknown): ProjectGroupColor {
  if (typeof raw === "string" && (PROJECT_GROUP_COLORS as readonly string[]).includes(raw)) return raw as ProjectGroupColor;
  throw new InvalidProjectGroupError(`グループの色は ${PROJECT_GROUP_COLORS.join("・")} のどれかで渡してください`);
}

function sortByExplicitOrder<T extends { id: string }>(items: T[], order: readonly string[]): T[] {
  if (order.length === 0) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ra = rank.get(a.item.id) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.item.id) ?? Number.MAX_SAFE_INTEGER;
      return ra === rb ? a.i - b.i : ra - rb;
    })
    .map(({ item }) => item);
}

/**
 * **いまのセッションで効いている Skill の集合**（決定・2026-09-23）。
 * 刻まれていなければ `undefined`——この仕組みより前に始まった会話は、何も効かせていない。
 */
export function currentSkillSet(thread: ThreadState): SessionSkillSet | undefined {
  const sets = thread.skillSets ?? [];
  return sets[sets.length - 1]?.set;
}
