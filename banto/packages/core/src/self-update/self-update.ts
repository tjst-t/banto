// **画面から banto を更新する——host の側**（決定・2026-10-04、アーキ仕様 §2.5「画面から banto を更新する」・
// `docs/specs/v4-security.md` §2「画面からの更新」）。
//
// host がするのは3つだけ：今の版と release の最新の差を見せる・頼まれたら `request.json` を書いて
// `banto-update.service` を起こす・待ちをやめる／すぐ起こし直すの印を置く。組み立ても起こし直しも
// `scripts/update.mjs`（別の unit）が行う——host の子にすると、起こし直したときに一緒に止まる。
//
// - **host が git を打つのは自分の置き場の `repo.git` だけ**。開発用のリポジトリ（コンテナの中から書き換えられる）
//   では打たない。今の版も、動いているコードのフォルダではなく `repo.git` の worktree の一覧から引く
// - **「最後に確かめた最新」は `repo.git` の `refs/remotes/origin/release` そのもの**（規則3——写しを持たない）。
//   確かめた時刻は fetch が書く `FETCH_HEAD` の時刻
// - 進み具合（`state.json`）は `update.mjs` が書いたものを読むだけ

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const UPDATE_UNIT = "banto-update.service";
export const RELEASE_REF = "refs/remotes/origin/release";
/** 取ってくるのは GitHub の `release` だけ（`update.mjs` と同じ refspec） */
export const FETCH_REFSPEC = `+refs/heads/release:${RELEASE_REF}`;
export const UPDATE_RUNBOOK = "docs/runbooks/release.md D";
/** `systemctl start --no-block` から、`update.mjs` が頼みを受け取るまでの猶予 */
const REQUEST_PICKUP_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 試験で git・systemctl を差し替える口。終了コードが 0 でなくても投げない（呼ぶ側が見る） */
export type CommandRunner = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<CommandResult>;

export const runCommand: CommandRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: opts?.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        // https の取得で資格情報を聞かれて止まらない
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          // 起こせなかった（ENOENT 等）・時間切れ——終了コードの話ではないので投げる
          reject(new Error(`${file} ${args.join(" ")} を実行できませんでした：${err.message}`));
          return;
        }
        resolve({ code: err ? ((err as { code: number }).code) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export type UpdatePhase = "fetch" | "build" | "wait" | "restart" | "verify" | "done" | "failed" | "rolled-back" | "cancelled";

/** `update.mjs` が書く進み具合（形は `scripts/update.mjs` の冒頭） */
export interface UpdateState {
  id: string;
  phase: UpdatePhase;
  mode?: "wait" | "now";
  from: string | null;
  to: string | null;
  startedAt: string;
  updatedAt: string;
  waiting?: unknown;
  result?: string;
  error?: string;
  failedPhase?: UpdatePhase;
  logFile?: string;
  requestedBy?: unknown;
}

export interface CommitInfo {
  commit: string;
  subject: string;
  date: string;
  author: string;
}

export interface UpdateStatus {
  /** 画面から更新できる形で動いているか。できなければ `reasons` に理由（直し方は `runbook`） */
  ready: boolean;
  reasons: string[];
  runbook: string;
  releaseDir: string;
  current: CommitInfo | null;
  latest:
    | (CommitInfo & {
        /** 最後に確かめた（fetch した）時刻 */
        checkedAt: string | null;
        /** 今の版がその祖先か（早送りで済むか）。違えば更新できない */
        fastForward: boolean;
        /** 今の版から最新までのコミット（新しいものが先） */
        commits: CommitInfo[];
      })
    | null;
  /** 最後の更新の進み具合（`state.json`）。無ければ null */
  state: UpdateState | null;
  /** 更新が走っている（または起こしたばかりでまだ受け取られていない） */
  running: boolean;
}

export class SelfUpdateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface SelfUpdateOptions {
  releaseDir: string;
  dataDir: string;
  /** 動いている banto のコード（`monorepoRoot`。node が symlink を解いた本当のパス） */
  codeDir: string;
  run?: CommandRunner;
  now?: () => number;
  /** systemctl の名前（試験で差し替える） */
  systemctl?: string;
  git?: string;
}

export class SelfUpdate {
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly systemctl: string;
  private readonly git: string;
  /** 同じ host への同時の頼み（確かめてから書くまでの間）を1本にする */
  private requesting = false;

  constructor(private readonly opts: SelfUpdateOptions) {
    this.run = opts.run ?? runCommand;
    this.now = opts.now ?? Date.now;
    this.systemctl = opts.systemctl ?? "systemctl";
    this.git = opts.git ?? "git";
  }

  get updateDir(): string {
    return join(this.opts.dataDir, "update");
  }

  private get repoDir(): string {
    return join(this.opts.releaseDir, "repo.git");
  }

  private async gitRepo(args: string[], timeoutMs?: number): Promise<CommandResult> {
    return this.run(this.git, ["--git-dir", this.repoDir, ...args], timeoutMs ? { timeoutMs } : undefined);
  }

  private async gitOk(args: string[]): Promise<string> {
    const r = await this.gitRepo(args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} が失敗しました：${r.stderr.trim() || `終了コード ${r.code}`}`);
    return r.stdout;
  }

  async status(): Promise<UpdateStatus> {
    const reasons: string[] = [];
    const { releaseDir } = this.opts;
    const repoExists = existsSync(this.repoDir);
    if (!repoExists) reasons.push(`${this.repoDir} がありません（置き場がまだ版ごとのフォルダの形になっていません）`);

    const versionDir = await this.runningVersionDir();
    if (!versionDir) {
      reasons.push(
        `banto が ${releaseDir}/versions/ の外（${await realpath(this.opts.codeDir).catch(() => this.opts.codeDir)}）から動いています。` +
          "版ごとのフォルダから動かしてください",
      );
    }

    const load = await this.unitProperty("LoadState");
    if (load !== "loaded") reasons.push(`${UPDATE_UNIT} がありません（LoadState=${load || "不明"}）`);

    let current: CommitInfo | null = null;
    if (repoExists && versionDir) {
      const head = await this.worktreeHead(versionDir);
      if (head) current = await this.commitInfo(head);
      else reasons.push(`今の版のフォルダ（${versionDir}）が ${this.repoDir} の worktree ではありません`);
    }

    const latest = repoExists ? await this.latest(current?.commit ?? null) : null;
    return {
      ready: reasons.length === 0,
      reasons,
      runbook: UPDATE_RUNBOOK,
      releaseDir,
      current,
      latest,
      state: await this.readState(),
      running: await this.isRunning(),
    };
  }

  /** `repo.git` に release を取ってきて、差を出し直す */
  async check(): Promise<UpdateStatus> {
    if (!existsSync(this.repoDir)) {
      throw new SelfUpdateError(409, `${this.repoDir} がありません。手順書（${UPDATE_RUNBOOK}）で置き場を整えてください`, "not-ready");
    }
    const r = await this.gitRepo(["fetch", "--no-tags", "origin", FETCH_REFSPEC], FETCH_TIMEOUT_MS);
    if (r.code !== 0) throw new SelfUpdateError(502, `release を取ってこられませんでした：${r.stderr.trim() || `終了コード ${r.code}`}`);
    return this.status();
  }

  /**
   * **更新を頼む**。呼ぶ側（http の口）が「ログイン中の人・step-up 済み」を確かめてから呼ぶ。
   * `commit` は画面に見せた最新——人が読んだ一覧と違うものを組み立てない
   */
  async request(input: { commit: unknown; mode: unknown }, requestedBy: unknown): Promise<{ id: string }> {
    if (typeof input.commit !== "string" || !/^[0-9a-f]{40}$/.test(input.commit)) {
      throw new SelfUpdateError(400, "commit（40文字の id）が要ります");
    }
    if (input.mode !== "wait" && input.mode !== "now") throw new SelfUpdateError(400, 'mode は "wait" か "now" です');
    if (this.requesting) throw new SelfUpdateError(409, "ほかの頼みを受け付けているところです", "running");
    this.requesting = true;
    try {
      const status = await this.status();
      if (!status.ready) {
        throw new SelfUpdateError(409, `画面から更新できる形になっていません：${status.reasons.join("／")}`, "not-ready");
      }
      if (status.running) throw new SelfUpdateError(409, "更新が走っています。終わってから頼んでください", "running");
      if (!status.latest) throw new SelfUpdateError(409, "まだ release の最新を確かめていません", "not-checked");
      if (input.commit !== status.latest.commit) {
        throw new SelfUpdateError(
          409,
          "見せた一覧の commit が、最後に確かめた release の最新と違います。確かめ直してから押してください",
          "stale-commit",
        );
      }
      if (status.current?.commit === input.commit) throw new SelfUpdateError(409, "もうこの版で動いています", "up-to-date");
      if (!status.latest.fastForward) {
        throw new SelfUpdateError(409, "release が今の版から早送りで辿れません（書き換えられています）。更新しません", "not-fast-forward");
      }

      const id = `${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}-${input.commit.slice(0, 7)}`;
      await mkdir(this.updateDir, { recursive: true, mode: 0o700 });
      // 前の回の印が残っていると、受け取った途端に止まる・待たずに起こし直す
      await rm(join(this.updateDir, "cancel"), { force: true });
      await rm(join(this.updateDir, "force-now"), { force: true });
      const request = {
        id,
        commit: input.commit,
        mode: input.mode,
        requestedBy,
        requestedAt: new Date(this.now()).toISOString(),
      };
      await writeAtomic(join(this.updateDir, "request.json"), JSON.stringify(request, null, 2));
      const started = await this.run(this.systemctl, ["start", "--no-block", UPDATE_UNIT]);
      if (started.code !== 0) {
        await rm(join(this.updateDir, "request.json"), { force: true });
        throw new SelfUpdateError(502, `${UPDATE_UNIT} を起こせませんでした：${started.stderr.trim() || `終了コード ${started.code}`}`);
      }
      return { id };
    } finally {
      this.requesting = false;
    }
  }

  /** 走っている更新の待ちをやめる（`cancel`）・待たずにすぐ起こし直す（`force-now`） */
  async signal(kind: "cancel" | "force-now"): Promise<void> {
    if (!(await this.isRunning())) throw new SelfUpdateError(409, "走っている更新はありません", "not-running");
    const state = await this.readState();
    if (state && (state.phase === "restart" || state.phase === "verify")) {
      throw new SelfUpdateError(409, "もう起こし直しに入っています", "too-late");
    }
    await mkdir(this.updateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.updateDir, kind), new Date(this.now()).toISOString());
  }

  // ───────────── 中身 ─────────────

  /** 動いているコードが `versions/<名前>/…` の下なら、その `versions/<名前>` */
  private async runningVersionDir(): Promise<string | undefined> {
    const versions = await realpath(join(this.opts.releaseDir, "versions")).catch(() => undefined);
    const code = await realpath(this.opts.codeDir).catch(() => undefined);
    if (!versions || !code) return undefined;
    const rel = relative(versions, code);
    if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
    return join(versions, rel.split(sep)[0]!);
  }

  private async worktreeHead(dir: string): Promise<string | undefined> {
    const out = await this.gitOk(["worktree", "list", "--porcelain"]);
    for (const block of out.split("\n\n")) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      const head = block.match(/^HEAD ([0-9a-f]{40})$/m)?.[1];
      if (!path || !head) continue;
      if ((await realpath(path).catch(() => path)) === dir) return head;
    }
    return undefined;
  }

  private async commitInfo(rev: string): Promise<CommitInfo> {
    const [commit, subject, date, author] = (await this.gitOk(["log", "-1", "--format=%H%x1f%s%x1f%cI%x1f%an", rev, "--"]))
      .trim()
      .split("\x1f");
    return { commit: commit!, subject: subject ?? "", date: date ?? "", author: author ?? "" };
  }

  private async latest(current: string | null): Promise<UpdateStatus["latest"]> {
    const r = await this.gitRepo(["rev-parse", "--verify", "-q", `${RELEASE_REF}^{commit}`]);
    if (r.code !== 0) return null;
    const info = await this.commitInfo(r.stdout.trim());
    const fetchedAt = await stat(join(this.repoDir, "FETCH_HEAD")).catch(() => undefined);
    let fastForward = false;
    let commits: CommitInfo[] = [];
    if (current) {
      fastForward = (await this.gitRepo(["merge-base", "--is-ancestor", current, info.commit])).code === 0;
      const log = await this.gitOk(["log", "--format=%H%x1f%s%x1f%cI%x1f%an", `${current}..${info.commit}`, "--"]);
      commits = log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [commit, subject, date, author] = line.split("\x1f");
          return { commit: commit!, subject: subject ?? "", date: date ?? "", author: author ?? "" };
        });
    }
    return { ...info, checkedAt: fetchedAt ? fetchedAt.mtime.toISOString() : null, fastForward, commits };
  }

  private async unitProperty(name: string): Promise<string> {
    const r = await this.run(this.systemctl, ["show", "-p", name, "--value", UPDATE_UNIT]).catch(() => undefined);
    return r && r.code === 0 ? r.stdout.trim() : "";
  }

  private async isRunning(): Promise<boolean> {
    const active = await this.unitProperty("ActiveState");
    if (["active", "activating", "deactivating", "reloading"].includes(active)) return true;
    // 起こしたばかりで、まだ unit が動き出していない（`--no-block`）。受け取られないまま残った古い頼みは数えない
    const pending = await stat(join(this.updateDir, "request.json")).catch(() => undefined);
    return pending !== undefined && this.now() - pending.mtimeMs < REQUEST_PICKUP_MS;
  }

  private async readState(): Promise<UpdateState | null> {
    let text: string;
    try {
      text = await readFile(join(this.updateDir, "state.json"), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(text) as UpdateState;
  }
}

/** 一時ファイルに書いてから rename（読む側が書きかけを見ない） */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}
