/**
 * work-keep の中核——**職人の成果を機構の側で取り置く**。
 *
 * ## なぜ要るか
 *
 * 職人はブランチのワークツリーで働くが、落ちたり無報告で終わったりすると、そこまでの
 * 変更は**未コミットのままワークツリーに取り残される**。実測で「無報告終了」を即座に
 * 失敗とみなして畳んだ例が8件あり、その都度そこまでの作業が失われている。
 * ワークツリーを畳めば消えるし、残っていても「誰の・どのタスクの・いつの差分か」が
 * 後から辿れない。
 *
 * **職人の作法まかせにしない**（第2便の方針）。職人が偉いから成果が守られるのではなく、
 * 機構が定期的に取り置く。だからこれは職人へ渡す作法（プロンプト）ではなく、
 * 職人プロセスに載る**機構**である。
 *
 * ## どうやるか（作業の邪魔をしない取り置き）
 *
 * `git commit` は使わない。職人自身が git を使っている最中に `.git/index` を触ると、
 * 職人の `git add` / `git commit` を壊す——**守るための機構が作業を壊す**のでは本末転倒。
 * 代わりに配管（plumbing）だけで撮る:
 *
 *   1. `GIT_INDEX_FILE` を自分専用の一時ファイルに向けて `git add -A`（職人の index は無傷）
 *   2. `git write-tree` で今の作業ツリーの姿を木にする
 *   3. `git commit-tree` で親（前回の取り置き＋いまの HEAD）を繋いだコミットを作る
 *   4. `git update-ref refs/heads/banto/keep/...` で**名前つきの枝**に載せる
 *
 * HEAD も作業ツリーも index も動かない。職人から見て、この機構は存在しないのと同じに振る舞う。
 * 枝は共有のリポジトリ（`.git`）側に出来るので、**ワークツリーを畳んだ後も残る**。
 *
 * ## ランタイム中立（task-0102 の轍を踏まない）
 *
 * 職人には2つのランタイム経路がある（pi と Claude Agent SDK）。task-0102 では退避が
 * pi 経路にしか載っておらず、**実運用の職人（ほぼ全部 Claude Agent SDK）には1行も
 * 効いていなかった**。判断（いつ・何を・どこへ取り置くか）はこのファイルに1つだけ置き、
 * 経路ごとの繋ぎ込みは薄い層（`pi-extension/work-keep.ts` /
 * `claude-agent/work-keep.ts`）に閉じる。**同じ判断を2箇所に書かない**（D3）。
 *
 * 環境変数:
 *   BANTO_WORKER_KEEP          - "0" / "off" で取り置きを止める（切り分け用）
 *   BANTO_WORKER_KEEP_INTERVAL - 取り置きの間隔（ミリ秒）。既定 120000
 *   BANTO_PROJECT / BANTO_TASK_ID - 枝の名前と由緒書きに載せる名乗り（両ドライバが渡す）
 *
 * D5: 判断は無い。作業ツリーの姿をそのまま撮るだけで、中身は解釈しない。
 * D6: 依存は node 標準（child_process/fs/os/path）と git 本体だけ。
 * I2: 取り置きに失敗しても職人のターンは壊さない。ただし黙らない——標準エラーに残す。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ── 設定 ────────────────────────────────────────────────────────────────────

/**
 * 取り置きの間隔の既定（ミリ秒）。
 *
 * **2分**。根拠は失うものと払うものの釣り合い:
 *   - 失う上限がこの間隔そのものになる。職人のツール1〜2回分＝書きかけの1ファイル程度で、
 *     「思い出しながら書き直せる」範囲に収まる
 *   - 払う側はほぼ無料。変わっていなければ木のハッシュが前回と一致するのでコミットを作らず、
 *     `git add -A` も自分専用 index の stat キャッシュが効いて2回目以降は差分だけを見る
 *
 * これより短くしても、職人は数分単位で考えて書くので取り置きが空振りするだけ。長くすると
 * 「30分考えて書いた実装が丸ごと消える」に近づく。迷ったら短い側へ倒す性質の値ではある。
 */
export const DEFAULT_KEEP_INTERVAL_MS = 120_000;

/** 取り置きそのものを止める環境変数（切り分け用）。 */
export const KEEP_ENABLED_ENV = "BANTO_WORKER_KEEP";
/** 取り置きの間隔を変える環境変数。 */
export const KEEP_INTERVAL_ENV = "BANTO_WORKER_KEEP_INTERVAL";

/** 取り置き枝の頭。`git branch --list 'banto/keep/*'` で一覧できる。 */
export const KEEP_BRANCH_PREFIX = "banto/keep";

/**
 * 取り置きコミットの打ち手。
 *
 * **人が書いたコミットと混ざらないこと**が要件なので、名前・メールともに人が使わない形に
 * する（`.invalid` は RFC 2606 で「絶対に解決されない」と決まっているTLD）。
 * `git log --author=banto-keeper` で機構の分だけを抜ける。
 */
export const KEEPER_NAME = "banto-keeper";
/** 同上（メール）。 */
export const KEEPER_EMAIL = "banto-keeper@banto.invalid";

/** コミット本文の1行目に付ける印。人の目でも grep でも見分けが付く。 */
export const KEEP_SUBJECT_PREFIX = "keep(worker):";

type EnvLike = Readonly<Record<string, string | undefined>>;

/** 取り置きを動かすか。既定は動かす（載せ忘れた職人だけが穴に落ちるのを避ける）。 */
export function isKeepEnabled(env: EnvLike): boolean {
  const raw = env[KEEP_ENABLED_ENV];
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "off" || normalized === "false" || normalized === "no");
}

/** 間隔を決める。読めない値・小さすぎる値は既定に落とす（I2: 0で回し続けない）。 */
export function resolveKeepIntervalMs(env: EnvLike): number {
  const raw = env[KEEP_INTERVAL_ENV];
  if (raw === undefined) return DEFAULT_KEEP_INTERVAL_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_KEEP_INTERVAL_MS;
  return parsed;
}

// ── 枝の名前 ────────────────────────────────────────────────────────────────

/**
 * ref に使えない字を潰す。
 *
 * git の決まり（git-check-ref-format）は禁止だけを並べているので、こちらは
 * **許すものだけを通す**（英数と `.` `_` `-`）。判定を git の版に依存させない。
 */
export function sanitizeRefPart(text: string, fallback = "unknown"): string {
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[.\-]+/u, "")
    .replace(/[.\-]+$/u, "")
    .replace(/\.lock$/iu, "-lock");
  return cleaned.length > 0 ? cleaned : fallback;
}

/** 枝の名前に載せる時刻（`20260814T101530Z`）。 */
export function keepStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

export interface KeepIdentity {
  /** どのプロジェクトの職人か。 */
  projectTag: string;
  /** どのタスクの職人か。 */
  taskId: string;
  /** どのランタイムで動いているか（`pi` / `claude-agent`）。 */
  runtime: string;
  /** ランタイムが名乗るセッションID（分かるときだけ）。 */
  sessionId?: string | undefined;
  /** 働いている場所。 */
  worktree?: string | undefined;
}

/**
 * 取り置き枝の名前。
 *
 * `banto/keep/<project>/<task>/<起動時刻>-<runtime>`。
 * **「どのタスクの・いつの・どのランタイムの作業か」が名前だけで辿れる**こと自体が要件
 * ——取り残されたワークツリーが「誰の何だったのか分からない」のが直したい穴である。
 * 時刻を入れるのは、同じタスクを起こし直した職人と混ざらないようにするため。
 */
export function keepBranchName(identity: KeepIdentity, startedAt: Date): string {
  return [
    KEEP_BRANCH_PREFIX,
    sanitizeRefPart(identity.projectTag, "unknown-project"),
    sanitizeRefPart(identity.taskId, "unknown-task"),
    `${keepStamp(startedAt)}-${sanitizeRefPart(identity.runtime, "unknown-runtime")}`,
  ].join("/");
}

/** 取り置きを打つきっかけ。由緒書きに載せる（後から「なぜここで撮ったか」を読めるように）。 */
export type KeepReason = "start" | "interval" | "tool_result" | "turn_end" | "exit" | "manual";

/**
 * コミットの本文。
 *
 * **機構が打ったことを隠さない**（I1）。1行目に印、本文に名乗りときっかけを並べる。
 */
export function renderKeepMessage(
  identity: KeepIdentity,
  reason: KeepReason,
  sequence: number
): string {
  const lines = [
    `${KEEP_SUBJECT_PREFIX} ${identity.taskId} の途中経過 #${sequence}（${reason}）`,
    "",
    "banto の機構が自動で打った取り置きです（職人が書いたコミットではありません）。",
    "職人が落ちても・無報告で終わっても、ここまでの作業は残ります。",
    "",
    `project: ${identity.projectTag}`,
    `task: ${identity.taskId}`,
    `runtime: ${identity.runtime}`,
  ];
  if (identity.sessionId) lines.push(`session: ${identity.sessionId}`);
  if (identity.worktree) lines.push(`worktree: ${identity.worktree}`);
  lines.push(`reason: ${reason}`);
  return lines.join("\n") + "\n";
}

// ── git の呼び出し ──────────────────────────────────────────────────────────

/** git を1回叩く口（試験から差し替えるための seam）。失敗したら投げる。 */
export type GitRunner = (args: readonly string[], env?: Record<string, string>) => string;

/** 既定の git（`cwd` で動かし、標準出力を返す）。 */
export function createGitRunner(cwd: string): GitRunner {
  return (args, env) =>
    childProcess
      .execFileSync("git", [...args], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, ...env },
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      })
      .toString();
}

/** 1回の取り置きの結果。 */
export interface KeepOutcome {
  /**
   * - `kept`      取り置いた
   * - `unchanged` 前回から変わっていないので何もしなかった
   * - `skipped`   git リポジトリでない等、そもそも取り置けない
   * - `failed`    git が失敗した（職人のターンは壊さない）
   */
  status: "kept" | "unchanged" | "skipped" | "failed";
  branch: string;
  reason: KeepReason;
  commit?: string;
  error?: string;
}

export interface WorktreeKeeperOptions {
  /** 職人の作業場所。 */
  cwd: string;
  /** 名乗り（枝の名前と由緒書きに載る）。 */
  identity: KeepIdentity;
  /** 取り置きの間隔（ミリ秒）。 */
  intervalMs?: number;
  /** 枝の名前（既定は `keepBranchName`）。 */
  branch?: string;
  /** 自分専用の index（既定は一時ファイル）。職人の `.git/index` は絶対に使わない。 */
  indexFile?: string;
  /** 時計（試験から差し替える）。 */
  now?: () => number;
  /** git の口（試験から差し替える）。 */
  git?: GitRunner;
  /** 失敗の伝え先（既定は標準エラー）。 */
  onError?: (message: string) => void;
}

/**
 * 作業ツリーを定期的に取り置く機構。
 *
 * 1人の職人プロセスにつき1つ。`start()` で時計を回し、`stop()` で最後の1枚を撮って畳む。
 * **どの経路（pi / Claude Agent SDK）でもこの器を使う**——経路ごとに違うのは
 * 「いつ `maybeSnapshot` を呼ぶ口があるか」だけである。
 */
export class WorktreeKeeper {
  readonly branch: string;
  private readonly cwd: string;
  private readonly identity: KeepIdentity;
  private readonly intervalMs: number;
  private readonly indexFile: string;
  private readonly now: () => number;
  private readonly git: GitRunner;
  private readonly onError: (message: string) => void;

  private timer: NodeJS.Timeout | undefined;
  private exitHandler: (() => void) | undefined;
  private signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  private lastAt = 0;
  private sequence = 0;
  private tip: string | undefined;
  private lastTree: string | undefined;
  private lastHead: string | undefined;
  private disabled = false;

  constructor(options: WorktreeKeeperOptions) {
    this.cwd = options.cwd;
    this.identity = options.identity;
    this.intervalMs = options.intervalMs ?? DEFAULT_KEEP_INTERVAL_MS;
    this.branch = options.branch ?? keepBranchName(options.identity, new Date());
    /**
     * 自分専用の index。**使い回さない**（毎回新しい名前にする）。
     *
     * index には「どのパスがどのハッシュか」が入っている。別のワークツリーで撮った
     * ものを引き継ぐと、そこに居ないファイルを混ぜた木を書いてしまう——取り置きが
     * 別人の作業を含んだ嘘の枝になる。作り直しの費用は1回分の `git add -A` だけ。
     */
    this.indexFile =
      options.indexFile ??
      path.join(
        os.tmpdir(),
        "banto-work-keep",
        `${sanitizeRefPart(options.identity.taskId)}-${process.pid}-${randomUUID().slice(0, 8)}.index`
      );
    this.now = options.now ?? (() => Date.now());
    this.git = options.git ?? createGitRunner(options.cwd);
    this.onError =
      options.onError ?? ((message) => process.stderr.write(`[work-keep] ${message}\n`));
  }

  /** 前回の取り置きから間隔が過ぎていたら撮る。過ぎていなければ何もしない。 */
  maybeSnapshot(reason: KeepReason = "interval"): KeepOutcome | undefined {
    if (this.disabled) return undefined;
    if (this.now() - this.lastAt < this.intervalMs) return undefined;
    return this.snapshot(reason);
  }

  /** いま撮る。 */
  snapshot(reason: KeepReason = "manual"): KeepOutcome {
    this.lastAt = this.now();
    if (this.disabled) return { status: "skipped", branch: this.branch, reason };
    try {
      return this.capture(reason);
    } catch (err) {
      // I2: 取り置きの失敗で職人のターンを壊さない。ただし黙らせない
      const message = err instanceof Error ? err.message : String(err);
      this.onError(`${this.branch} の取り置きに失敗（${reason}）: ${message}`);
      return { status: "failed", branch: this.branch, reason, error: message };
    }
  }

  /**
   * 時計を回し始める。
   *
   * タイマーは `unref` する——取り置きのために職人プロセスを生かし続けてはならない
   * （終わったのに終われない職人が出る）。`unref` しても、動いている間は普通に発火する。
   */
  start(): void {
    if (this.timer) return;
    this.lastAt = this.now();
    this.timer = setInterval(() => {
      this.maybeSnapshot("interval");
    }, this.intervalMs);
    this.timer.unref?.();
    this.installExitHooks();
  }

  /** 最後の1枚を撮って畳む。 */
  stop(reason: KeepReason = "exit"): KeepOutcome | undefined {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.removeExitHooks();
    if (this.disabled) return this.dropIndex();
    const outcome = this.snapshot(reason);
    this.dropIndex();
    return outcome;
  }

  /** 一時 index を片付ける（残しても害は無いが、tmp に溜め続ける理由も無い）。 */
  private dropIndex(): undefined {
    try {
      fs.rmSync(this.indexFile, { force: true });
    } catch {
      // 片付けの失敗は職人に関係ない
    }
    return undefined;
  }

  /** いまの取り置き枝の先端（撮っていなければ `undefined`）。 */
  tipCommit(): string | undefined {
    return this.tip;
  }

  /** 撮った枚数。 */
  keptCount(): number {
    return this.sequence;
  }

  // ── 中身 ──────────────────────────────────────────────────────────────────

  private capture(reason: KeepReason): KeepOutcome {
    if (!this.isRepository()) {
      // git の外で働く職人も居る（調査だけの職人など）。守るものが無いので黙って降りる
      this.disabled = true;
      return { status: "skipped", branch: this.branch, reason };
    }

    const head = this.headCommit();
    const tree = this.writeTree();

    // 前回から作業ツリーも HEAD も動いていないなら、空のコミットを積まない
    if (tree === this.lastTree && head === this.lastHead) {
      return { status: "unchanged", branch: this.branch, reason };
    }
    // 1枚目で、まだ HEAD と同じ姿なら「取り置くものが無い」
    if (this.tip === undefined && head !== undefined && this.treeOf(head) === tree) {
      this.lastTree = tree;
      this.lastHead = head;
      return { status: "unchanged", branch: this.branch, reason };
    }

    /**
     * 親は「前回の取り置き」と「いまの HEAD」の両方。
     *
     * HEAD も繋ぐのは、**職人が自分で打ったコミットも取り置き枝から辿れるようにする**ため。
     * 繋がないと `git log <取り置き枝>` が機構の分だけになり、「職人が何をしたか」を
     * 追うのに2本を突き合わせる羽目になる。
     */
    const parents: string[] = [];
    if (this.tip) parents.push(this.tip);
    if (head && !parents.includes(head)) parents.push(head);

    this.sequence += 1;
    const message = renderKeepMessage(this.identity, reason, this.sequence);
    const commit = this.commitTree(tree, parents, message);
    this.updateRef(commit, reason);

    this.tip = commit;
    this.lastTree = tree;
    this.lastHead = head;
    return { status: "kept", branch: this.branch, reason, commit };
  }

  private isRepository(): boolean {
    try {
      this.git(["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  /** いまの HEAD。まだ1つもコミットが無いリポジトリ（unborn）では `undefined`。 */
  private headCommit(): string | undefined {
    try {
      return this.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    } catch {
      return undefined;
    }
  }

  private treeOf(commit: string): string {
    return this.git(["rev-parse", "--verify", `${commit}^{tree}`]).trim();
  }

  /**
   * いまの作業ツリーを木にする。
   *
   * **職人の index を触らない**のがここの肝（`GIT_INDEX_FILE` を自分の一時ファイルへ向ける）。
   * 一時 index は職人の生きている間ずっと使い回す——2回目以降は stat キャッシュが効くので、
   * `git add -A` が毎回リポジトリ全体をハッシュし直すことにならない。
   */
  private writeTree(): string {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    const env = { GIT_INDEX_FILE: this.indexFile };
    this.git(["add", "-A", "--", "."], env);
    return this.git(["write-tree"], env).trim();
  }

  private commitTree(tree: string, parents: readonly string[], message: string): string {
    const args = ["commit-tree", tree];
    for (const parent of parents) args.push("-p", parent);
    args.push("-m", message);
    return this.git(args, {
      // 人が書いたコミットと混同させない（決めた名前は KEEPER_NAME / KEEPER_EMAIL）
      GIT_AUTHOR_NAME: KEEPER_NAME,
      GIT_AUTHOR_EMAIL: KEEPER_EMAIL,
      GIT_COMMITTER_NAME: KEEPER_NAME,
      GIT_COMMITTER_EMAIL: KEEPER_EMAIL,
    }).trim();
  }

  private updateRef(commit: string, reason: KeepReason): void {
    const args = ["update-ref", "-m", `banto work-keep (${reason})`, `refs/heads/${this.branch}`, commit];
    // 2枚目以降は「前回の先端であること」を条件に付ける。取り違えて他人の枝を
    // 上書きするくらいなら失敗した方がよい（I2）
    if (this.tip) args.push(this.tip);
    this.git(args);
  }

  // ── 落ちるときの1枚 ────────────────────────────────────────────────────────

  /**
   * 終わり際にもう1枚撮る。
   *
   * `exit` は同期でしか働けないが、この機構の git 呼び出しは全部同期なので使える。
   * SIGTERM / SIGINT は**受け手が居ないと `exit` すら通らずに落ちる**ので、自分で受ける。
   * ただし**他に受け手が居るときは終わらせ方に手を出さない**——先客が畳み方を持っている
   * （pi・番頭ホスト）ところへ `process.exit` を割り込ませると、その畳み方を途中で切る。
   */
  private installExitHooks(): void {
    if (this.exitHandler) return;
    this.exitHandler = () => {
      this.snapshot("exit");
    };
    process.on("exit", this.exitHandler);

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const ownsExit = process.listenerCount(signal) === 0;
      const handler = (): void => {
        this.snapshot("exit");
        // 先客が居ないなら、既定の「シグナルで死ぬ」に相当する形へ自分で落とす
        if (ownsExit) process.exit(signal === "SIGINT" ? 130 : 143);
      };
      process.on(signal, handler);
      this.signalHandlers.push([signal, handler]);
    }
  }

  private removeExitHooks(): void {
    if (this.exitHandler) {
      process.off("exit", this.exitHandler);
      this.exitHandler = undefined;
    }
    for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
    this.signalHandlers = [];
  }
}

// ── 両経路の入口 ────────────────────────────────────────────────────────────

export interface CreateWorktreeKeeperParams {
  /** どのランタイムから載せたか（`pi` / `claude-agent`）。枝の名前に載る。 */
  runtime: string;
  /** 職人の作業場所（既定は `process.cwd()`——両ドライバとも worktree で起こす）。 */
  cwd?: string;
  /** ランタイムが名乗るセッションID（分かるときだけ）。 */
  sessionId?: string | undefined;
  /** 環境（既定は `process.env`）。 */
  env?: EnvLike;
  /** 時計（試験から差し替える）。 */
  now?: () => number;
  /** git の口（試験から差し替える）。 */
  git?: GitRunner;
  /** 自分専用の index（試験から差し替える）。 */
  indexFile?: string;
  /** 起動時刻（枝の名前に載る。試験から差し替える）。 */
  startedAt?: Date;
}

/**
 * 環境から取り置きを組み立てる。**両経路の共通の入口**。
 *
 * 切ってあるとき（`BANTO_WORKER_KEEP=0`）は `undefined` を返す——タイマーも枝も作らない。
 * tool-offload の `createClaudeToolOffload` / `installToolOffload` と同じ逃げ道である。
 */
export function createWorktreeKeeper(
  params: CreateWorktreeKeeperParams
): WorktreeKeeper | undefined {
  const env = params.env ?? process.env;
  if (!isKeepEnabled(env)) return undefined;

  const cwd = params.cwd ?? process.cwd();
  const identity: KeepIdentity = {
    projectTag: env["BANTO_PROJECT"] ?? "unknown-project",
    taskId: env["BANTO_TASK_ID"] ?? "unknown-task",
    runtime: params.runtime,
    sessionId: params.sessionId,
    worktree: cwd,
  };
  const startedAt = params.startedAt ?? new Date();

  return new WorktreeKeeper({
    cwd,
    identity,
    intervalMs: resolveKeepIntervalMs(env),
    branch: keepBranchName(identity, startedAt),
    ...(params.indexFile ? { indexFile: params.indexFile } : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.git ? { git: params.git } : {}),
  });
}

// ══ 見つける ════════════════════════════════════════════════════════════════

/**
 * **取り置きは「在るのに誰も気づけない」ものになってはいけない。**
 *
 * 番頭が `git branch --list` を打つことを期待する設計は、事実上「無い」のと同じ。
 * ここから下は、取り置きを**道具で読める形にする**ための読み取り側である
 * （繋ぎ込みは `worker-tools.ts` の `worker.keeps`）。
 */

/** 枝の名前から読み取れること。 */
export interface KeepBranchName {
  branch: string;
  projectTag: string;
  taskId: string;
  /** 職人が起きた時刻（枝の名前に刻んである）。 */
  startedAt: string;
  runtime: string;
}

/**
 * 取り置き枝の名前をほどく。**形が違うものは `undefined`**。
 *
 * ほどけないものを「たぶんこれだろう」で扱わない——掃除（`pruneKeepBranches`）が
 * この判定を使うので、曖昧に通すと関係の無い枝を消しかねない。
 */
export function parseKeepBranch(branch: string): KeepBranchName | undefined {
  const prefix = `${KEEP_BRANCH_PREFIX}/`;
  if (!branch.startsWith(prefix)) return undefined;
  const parts = branch.slice(prefix.length).split("/");
  if (parts.length !== 3) return undefined;
  const [projectTag, taskId, leaf] = parts as [string, string, string];
  const matched = /^(\d{8})T(\d{6})Z-(.+)$/u.exec(leaf);
  if (!matched) return undefined;
  const [, date, time, runtime] = matched as unknown as [string, string, string, string];
  const startedAt =
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
    `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  return { branch, projectTag, taskId, startedAt, runtime };
}

/** 1本の取り置き枝の姿。 */
export interface KeepBranchInfo extends KeepBranchName {
  /** 先端のコミット。 */
  commit: string;
  /** 最後に撮った時刻（先端のコミット日時）。 */
  lastKeptAt: string;
  /** 何枚撮ったか（先端の見出しに書いてある番号。読めなければ `undefined`）。 */
  keptCount?: number;
}

/** 先端の見出しから枚数を読む（`... の途中経過 #3（interval）`）。 */
function keptCountOf(subject: string): number | undefined {
  const matched = /#(\d+)/u.exec(subject);
  if (!matched) return undefined;
  const parsed = Number.parseInt(matched[1] as string, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * リポジトリの ref 置き場を一意に指す名前。
 *
 * ワークツリーは同じ `.git` を共有するので、**別のワークツリーから見ても同じ取り置きが見える**。
 * 逆に言えば、走査する場所を素直に数えると同じリポジトリを何度も見てしまう——ここで畳む。
 */
export function resolveGitCommonDir(repo: string, git?: GitRunner): string | undefined {
  const run = git ?? createGitRunner(repo);
  try {
    return run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  } catch {
    return undefined;
  }
}

/**
 * 取り置き枝を数え上げる。
 *
 * ワークツリーが畳まれていても残る——枝は共有の `.git` 側にあるので、**同じリポジトリの
 * どこか1つのワークツリーから見えれば全部見える**。逆に、そのリポジトリのワークツリーが
 * 1つも残っていないと辿り着けない（そこは限界として報告してある）。
 */
export function listKeepBranches(
  repo: string,
  filter: { projectTag?: string | undefined; taskId?: string | undefined } = {},
  git?: GitRunner
): KeepBranchInfo[] {
  const run = git ?? createGitRunner(repo);
  let out: string;
  try {
    out = run([
      "for-each-ref",
      "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(contents:subject)",
      `refs/heads/${KEEP_BRANCH_PREFIX}/`,
    ]);
  } catch {
    // git の外・壊れたリポジトリ。**空と「読めない」を混同しないため**に呼び出し側は
    // resolveGitCommonDir で先に確かめる
    return [];
  }

  const found: KeepBranchInfo[] = [];
  for (const line of out.split("\n")) {
    if (line.trim().length === 0) continue;
    const [branch, commit, date, subject] = line.split("\t");
    if (!branch || !commit || !date) continue;
    const parsed = parseKeepBranch(branch);
    if (!parsed) continue; // ほどけないものは数えない（消しもしない）
    if (filter.projectTag && parsed.projectTag !== sanitizeRefPart(filter.projectTag)) continue;
    if (filter.taskId && parsed.taskId !== sanitizeRefPart(filter.taskId)) continue;
    const count = keptCountOf(subject ?? "");
    found.push({
      ...parsed,
      commit,
      lastKeptAt: date,
      ...(count !== undefined ? { keptCount: count } : {}),
    });
  }
  // 新しい順（番頭が最初に見たいのは直近の取り残し）
  found.sort((a, b) => b.lastKeptAt.localeCompare(a.lastKeptAt));
  return found;
}

// ══ 始末する ════════════════════════════════════════════════════════════════

/**
 * 取り置きを残す期限（日）。既定30日。
 *
 * 救出のための保険なので、それより古いものが要る場面は考えにくい。**掃除の仕方が無いものは、
 * いずれ誰かが一括削除して成果ごと消える**——期限で消すのは、その終わり方を避けるため。
 */
export const DEFAULT_KEEP_MAX_AGE_DAYS = 30;

/** 期限を変える環境変数。`0` 以下で掃除そのものを止める。 */
export const KEEP_MAX_AGE_ENV = "BANTO_WORKER_KEEP_MAX_AGE_DAYS";

/** 掃除の記録を置く名前（工房の dataDir の下）。 */
export const KEEP_PRUNE_LOG = "keep-prune.jsonl";

/** 期限を決める。読めない値は既定へ。`0` 以下は「掃除しない」。 */
export function resolveKeepMaxAgeMs(env: EnvLike): number {
  const raw = env[KEEP_MAX_AGE_ENV];
  if (raw === undefined) return DEFAULT_KEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_KEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  if (parsed <= 0) return 0; // 切ってある
  return parsed * 24 * 60 * 60 * 1000;
}

/** 消さなかったものと、その理由。 */
export interface KeepPruneSkip {
  branch: string;
  why: string;
}

export interface KeepPruneResult {
  /** 見た枝の数（ほどけなかったものを含む）。 */
  scanned: number;
  /** 消した枝。 */
  removed: KeepBranchInfo[];
  /** まだ期限内なので残した枝の数。 */
  kept: number;
  /** 消すべきか判断できず**消さない側に倒した**もの。 */
  skipped: KeepPruneSkip[];
  /** 下見だけで実際には消していない。 */
  dryRun: boolean;
}

export interface PruneKeepBranchesOptions {
  /** どのリポジトリを掃除するか（そのリポジトリのワークツリーならどこでもよい）。 */
  repo: string;
  /** これより古いものを消す（ミリ秒）。`0` 以下なら何もしない。 */
  maxAgeMs: number;
  /** いまの時刻。 */
  now?: number;
  /** 下見だけ（既定 false）。 */
  dryRun?: boolean;
  /**
   * 消してはいけない枝を守る口。`true` を返した枝は残す。
   *
   * 工房は「まだ生きている職人の枝」をここで守る——期限（既定30日）と定期取り置き（2分）の
   * 差から、生きている職人の枝が期限に達することは普通は無いが、**時計が狂った・職人が
   * 長く止まっていた**ときに備えて機構としても塞いでおく。
   */
  protect?: (info: KeepBranchInfo) => boolean;
  /** 消す前後の記録先。 */
  record?: (entry: Record<string, unknown>) => void;
  /** git の口（試験から差し替える）。 */
  git?: GitRunner;
}

/**
 * 期限を過ぎた取り置きを消す。
 *
 * **消してよいと確かめられたものだけ消す**（迷ったら消さない側へ倒す）:
 *
 *   - `refs/heads/banto/keep/` の下だけを見る。他の枝には触れない
 *   - 名前がこの機構の形にほどけないものは数えるだけで消さない
 *   - 日時が読めないものは消さない
 *   - `protect` が守ると言ったものは消さない
 *   - 消すときは `update-ref -d <ref> <見たときのコミット>` ——**見たあとに動いた枝は
 *     git 側で弾かれる**（生きている職人が撮った直後の取り違えを機構で防ぐ）
 *
 * **消す前に記録する**。何を消すつもりかを先に残してから消すので、途中で落ちても
 * 「何が消えたか」ではなく「何を消そうとしたか」が残る——コミットの名前が残っていれば、
 * git が実際にオブジェクトを捨てるまでの間は `update-ref` で戻せる。
 */
export function pruneKeepBranches(options: PruneKeepBranchesOptions): KeepPruneResult {
  const now = options.now ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const result: KeepPruneResult = { scanned: 0, removed: [], kept: 0, skipped: [], dryRun };
  if (options.maxAgeMs <= 0) return result;

  const run = options.git ?? createGitRunner(options.repo);
  const branches = listKeepBranches(options.repo, {}, run);
  result.scanned = branches.length;

  const doomed: KeepBranchInfo[] = [];
  for (const info of branches) {
    const at = Date.parse(info.lastKeptAt);
    if (!Number.isFinite(at)) {
      // 迷ったら消さない
      result.skipped.push({ branch: info.branch, why: `最後に撮った時刻を読めない（${info.lastKeptAt}）` });
      continue;
    }
    if (now - at < options.maxAgeMs) {
      result.kept += 1;
      continue;
    }
    if (options.protect?.(info)) {
      result.skipped.push({ branch: info.branch, why: "まだ動いている職人の取り置き" });
      continue;
    }
    doomed.push(info);
  }

  if (doomed.length === 0) return result;

  // **消す前に記録する。** 落ちても「何を消そうとしたか」がコミット名つきで残る
  options.record?.({
    at: new Date(now).toISOString(),
    event: dryRun ? "keep_prune_planned_dry_run" : "keep_prune_planned",
    repo: options.repo,
    maxAgeMs: options.maxAgeMs,
    count: doomed.length,
    branches: doomed.map((info) => ({ branch: info.branch, commit: info.commit, lastKeptAt: info.lastKeptAt })),
  });

  if (dryRun) {
    result.removed.push(...doomed);
    return result;
  }

  for (const info of doomed) {
    try {
      // 見たときのコミットを条件に付ける。取り違えて別のものを消すくらいなら失敗した方がよい
      run(["update-ref", "-d", `refs/heads/${info.branch}`, info.commit]);
      result.removed.push(info);
    } catch (err) {
      result.skipped.push({
        branch: info.branch,
        why: `消せなかった: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  options.record?.({
    at: new Date(now).toISOString(),
    event: "keep_prune_done",
    repo: options.repo,
    removed: result.removed.map((info) => info.branch),
    skipped: result.skipped,
  });

  return result;
}
