// **Project のスリープ**（決定・2026-10-16、アーキ仕様 §2.2「Project のグループとスリープ」）。
//
// 眠らせる手順は「印を立てる→忙しいか確かめる→（別のサーバなら Service を止める）→`project.slept`→Module とコンテナを止める
// →印を消す」。印（メモリ、Project ごと）が立っている間、ターンを開く口と `modules/prepare` は**断らずに印が消えるまで待って
// から**起こす口（`wake`）を通る——確かめてから記録するまでの間にターンが始まり、それを片づけが途中で落とす、を作らない。
//
// 起こす口は `wake` の1か所（呼ぶのは `modules/prepare` と `openTurn` だけ）。やることは `sleep` を外すだけで、コンテナと
// Module は今の遅延起動で起きる。眠っている Project の Module を起こさない門は `connectDeclaredModule`（cli.ts）。
import {
  isRemoteProject,
  NotFoundError,
  ProjectSleepConflictError,
  RuntimeMoveConflictError,
  type ProjectSleptBy,
  type ProjectThreadStore,
  type ProjectWokeCause,
} from "../project-thread/index.js";
import type { RunningItem } from "./project-move.js";

export interface ProjectSleepDeps {
  projectThread: ProjectThreadStore;
  /** host が知っている動いているもの（別の実行場所へ移すときと同じ一覧——ターン・返事待ちの札・Module の呼び出し） */
  hostActivity(projectId: string): RunningItem[];
  /** 別のサーバの Service を止めて自動起動から外す（向こうの起こし直しで勝手に起きないように） */
  suspendServices(projectId: string): Promise<string[]>;
  /** その Project の Module を台帳から外して止め、コンテナを止める。外した接続の名前 */
  releaseModules(projectId: string): Promise<string[]>;
  /** 実行場所で動いているもの（Service・待たないコマンド・Terminal のセッション）。コンテナが止まっていれば空 */
  runningInPlace(projectId: string): Promise<RunningItem[]>;
}

/** 眠らせられない・眠らせている途中（状態番号つき。`code` は画面が見分ける） */
export class ProjectSleepError extends Error {
  constructor(
    readonly status: 404 | 409 | 502,
    message: string,
    readonly code?: "busy" | "sleeping" | "closed" | "asleep",
    readonly reasons?: string[],
  ) {
    super(message);
  }
}

export class ProjectSleep {
  /** 眠らせている途中の Project（消えたら待っていた側が進む） */
  private readonly marks = new Map<string, Promise<void>>();
  /** 起こしている途中（同時に2か所から呼ばれても `project.woke` は1回） */
  private readonly waking = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: ProjectSleepDeps) {}

  /** いま眠らせている途中か */
  inProgress(projectId: string): boolean {
    return this.marks.has(projectId);
  }

  /** 眠らせている途中なら、終わる（眠った・断った）まで待つ */
  async settled(projectId: string): Promise<void> {
    await this.marks.get(projectId);
  }

  /**
   * **眠らせる**。断るときは `ProjectSleepError`。もう眠っていれば何もしない（`released` は空）。返すのは外した Module の接続
   */
  async sleep(projectId: string, by: ProjectSleptBy): Promise<{ released: string[] }> {
    const project = this.deps.projectThread.getProject(projectId);
    if (!project) throw new ProjectSleepError(404, "Project がありません");
    if (this.marks.has(projectId)) throw new ProjectSleepError(409, "いま眠らせています", "sleeping");
    if (project.status === "closed") throw new ProjectSleepError(409, "閉じた Project は眠らせられません", "closed");
    if (project.sleep) return { released: [] };
    // **印は確かめるより先に、同じ刻みで立てる**——確かめた後に来たターンは印で待つ
    let done!: () => void;
    this.marks.set(projectId, new Promise<void>((resolve) => (done = resolve)));
    try {
      const reasons = [
        ...(project.move ? ["いま別の実行場所へ移しています"] : []),
        ...this.deps.hostActivity(projectId).map((r) => r.label),
      ];
      if (reasons.length > 0) {
        throw new ProjectSleepError(409, `動いているものがあるので眠らせられません：${reasons.join("／")}`, "busy", reasons);
      }
      // 別のサーバは先に Service を止めて自動起動から外す。止められなければ眠らせない（止まったことにしない）。
      // この機械のコンテナはコンテナごと止めるので、中の Service も一緒に止まる
      if (isRemoteProject(project)) {
        try {
          await this.deps.suspendServices(projectId);
        } catch (err) {
          throw new ProjectSleepError(
            502,
            `別のサーバの Service を止められなかったので、眠らせていません：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      try {
        await this.deps.projectThread.sleepProject(projectId, by);
      } catch (err) {
        if (err instanceof NotFoundError) throw new ProjectSleepError(404, "Project がありません");
        if (err instanceof ProjectSleepConflictError || err instanceof RuntimeMoveConflictError) throw new ProjectSleepError(409, err.message);
        throw err;
      }
      return { released: await this.deps.releaseModules(projectId) };
    } finally {
      this.marks.delete(projectId);
      done();
    }
  }

  /**
   * **起こす**（host の1か所）。眠らせている途中なら終わるまで待ってから。眠っていなければ何も積まない。起こしたら true
   */
  async wake(projectId: string, cause: ProjectWokeCause): Promise<boolean> {
    await this.settled(projectId);
    const running = this.waking.get(projectId);
    if (running) return running.then(() => false);
    if (!this.deps.projectThread.getProject(projectId)?.sleep) return false;
    const woke = this.deps.projectThread.wakeProject(projectId, cause).finally(() => this.waking.delete(projectId));
    this.waking.set(projectId, woke);
    const did = await woke;
    if (did) console.log(`[host] project ${projectId} が起きました（${cause}）`);
    return did;
  }

  /**
   * **眠らせると止まるもの**（`GET /api/projects/:id/sleep-preview`）。人が眠らせるとき、あれば画面が並べて確かめる。
   * `blockers` があれば眠らせられない（断る理由と同じ）
   */
  async preview(projectId: string): Promise<{ stops: RunningItem[]; blockers: string[] }> {
    const project = this.deps.projectThread.getProject(projectId);
    if (!project) throw new ProjectSleepError(404, "Project がありません");
    const blockers = [
      ...(project.status === "closed" ? ["閉じた Project は眠らせられません"] : []),
      ...(this.marks.has(projectId) ? ["いま眠らせています"] : []),
      ...(project.move ? ["いま別の実行場所へ移しています"] : []),
      ...this.deps.hostActivity(projectId).map((r) => r.label),
    ];
    // 眠っている（止まっている）・閉じたものは数えない
    const stops = project.sleep || project.status === "closed" ? [] : await this.deps.runningInPlace(projectId);
    return { stops, blockers };
  }
}
