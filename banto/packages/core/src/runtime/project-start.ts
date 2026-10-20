// **別のサーバでも、新しい Project の始め方をこの機械と揃える**（決定・2026-10-20、ユーザー案B。`docs/specs/v4-frontend.md` §6.49、
// `docs/specs/v4-modules.md` の「core との境目」の例外）。
//
// この機械の「clone」「新しいリポジトリ」は Repositories が host のフォルダを用意する。別のサーバのフォルダは Repositories が
// 扱えないので、core が自分でやる。作る順番（仕様の 2.）：
//   (1) 置く場所の中に名前のフォルダを作る（`createDirectory`。同じ名前があれば断る）
//   (2) そのフォルダを根に Project を作る（今の作り方。断られたら (1) の空のフォルダを消す）
//   (3) 始め方の仕事を始めて、すぐ返す。仕事は HTTP から切り離し、Project の記録の `start` に状態を持つ
//
// **流し方**（仕様の 3.）：その Project の Shell の `runCommand` を人の印で呼ぶ——`containers` ならコンテナの中、`machine` なら
// VM のユーザーで動く（v4-security.md §1 の条件3「見せたフォルダに書くものは中から」）。コマンドはすべてここで組み、値は1語ずつ
// shell-quote する。git には `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null` を付ける（資格情報が違えば入力を待たずに落ち、
// Shell のホームの `.gitconfig` の写しに左右されない）。既定のブランチ名を読むコマンドだけは付けない。
//
// **clone は作業フォルダ `.banto-clone-<Project の id>` に流し、成功したら中身を根へ動かす**。失敗したら作業フォルダだけを消す
// （消すのは自分が作ったものだけ）。起こし直しで中断したものは、次に「もう一度」を押したときの最初に片づける。
// **git が5分何も言わなければ取り消す**——Shell の進み具合の `progress` が出力の文字数なので、それが変わらない間を数える。

import type { CloneSourceGithub } from "@banto/module-contract";
import { parseCloneSource } from "@banto/module-contract";
import type { ProjectStart, ProjectState } from "../project-thread/types.js";
import { RemoteRuntimeError } from "./remote-runtimes.js";
import { shq } from "./ssh.js";

/** 画面に返す失敗（状態番号つき） */
export class ProjectStartError extends RemoteRuntimeError {}

/** 人が選んだ始め方（`POST /api/projects` の `start`） */
export type StartRequest = { kind: "init" } | { kind: "clone"; url: string; account?: string };

/** Shell の `runCommand` の結果（要る分だけ） */
export interface ShellRun {
  exitCode: number | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}

/** 起きた Shell（その Project の）。断られたら（Vault が承認を求める等）理由を添えて投げる */
export interface ProjectShell {
  run(
    args: { command: string; timeoutSec: number; envSecrets?: Record<string, string> },
    opts: { signal: AbortSignal; onProgress: (outputChars: number) => void },
  ): Promise<ShellRun>;
}

export interface ProjectStartDeps {
  projectThread: {
    getProject(id: string): ProjectState | undefined;
    listProjects(): ProjectState[];
    setProjectStart(id: string, start: ProjectStart): Promise<unknown>;
  };
  remote: {
    /** 登録した別のサーバの形（無ければ undefined） */
    modeOf(name: string): "machine" | "containers" | undefined;
    createDirectory(name: string, parent: string | undefined, folder: string): Promise<string>;
    removeEmptyDirectory(name: string, path: string): Promise<void>;
    /** 根を向こうで正規化して Project を作る（`RemoteRuntimes.createProjectOn` と `createProject`） */
    createProject(name: string, projectName: string, root: string): Promise<ProjectState>;
  };
  /** GitHub の行き先（Repositories と同じ。試験だけが替える） */
  github: CloneSourceGithub;
  /** その Project の Shell を起こす（containers の最初の1回は数分） */
  wakeShell(projectId: string): Promise<ProjectShell>;
  /** 記録が変わった（画面への知らせ） */
  onChange?(projectId: string, start: ProjectStart): void;
  /** git が何も出力しないまま待つ上限（既定 5 分。試験だけが縮める） */
  stallMs?: number;
  now?(): Date;
  log?(line: string): void;
}

/** 全体の上限（Shell の `runCommand` の `timeout`、秒） */
export const START_TIMEOUT_SEC = 6 * 60 * 60;
/** 出力が変わらないまま待つ上限 */
export const START_STALL_MS = 5 * 60_000;
/** git のコマンドの頭（v4-frontend.md §6.49 の 3.） */
const GIT = "GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null git";
/** GitHub の login に使える字（Repositories の alias の名前の材料） */
const LOGIN = /^[A-Za-z0-9-]+$/;

/** Repositories のブラウザログインの alias（v4-modules.md「core との境目」の例外——core が名前の形を知る） */
export const githubAccountAlias = (login: string) => `repositories-github-${login.toLowerCase()}`;

/** clone の作業フォルダ（根の下。1 Project に1本なので Project の id で足りる） */
export const cloneWorkDir = (projectId: string) => `.banto-clone-${projectId}`;

/**
 * **git に渡す credential.helper**（`!` の後ろ）。標準入力の問いを読み、`protocol`・`host` が GitHub の行き先のときだけ
 * `x-access-token` と環境変数 `GIT_HTTP_TOKEN` を答える。ほかの host（リダイレクトの先を含む）には何も答えない。トークンは
 * 環境変数の名前で参照し、コマンドの文字列に埋めない
 */
export function credentialHelperScript(github: CloneSourceGithub): string {
  const web = new URL(github.web);
  const protocol = web.protocol.replace(/:$/, "");
  return (
    `f() { test "$1" = get || return 0; p=; h=; ` +
    `while IFS== read -r k v; do case "$k" in protocol) p=$v;; host) h=$v;; esac; done; ` +
    `if [ "$p" = ${shq(protocol)} ] && [ "$h" = ${shq(web.host.toLowerCase())} ]; then ` +
    `printf 'username=x-access-token\\npassword=%s\\n' "$GIT_HTTP_TOKEN"; fi; }; f`
  );
}

/** clone の元を読んで、git に渡す URL にする。断るなら理由つきで投げる（400） */
export function cloneUrlOf(
  request: { url: string; account?: string },
  github: CloneSourceGithub,
  mode: "machine" | "containers",
): { url: string; github: boolean } {
  const parsed = parseCloneSource(request.url, github);
  if (parsed.kind === "invalid") throw new ProjectStartError(400, parsed.reason);
  const text = request.url.trim().replace(/\/+$/, "");
  // `owner/repo` の短い形は GitHub の https の URL にする（ほかは書かれたまま）
  const url =
    parsed.kind === "github" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !text.includes(":")
      ? `${github.web.replace(/\/+$/, "")}/${parsed.owner}/${parsed.name}.git`
      : text;
  const overHttp = /^https?:\/\//i.test(url);
  // containers のコンテナの中の Shell は ssh-agent にも Vault にも届かない（#369 まで）
  if (mode === "containers" && !overHttp) {
    throw new ProjectStartError(400, "この別のサーバ（Project ごとのコンテナ）では、まだ https の URL だけ clone できます");
  }
  if (request.account !== undefined) {
    if (mode === "containers") throw new ProjectStartError(400, "この別のサーバ（Project ごとのコンテナ）では、まだ GitHub のアカウントを使えません");
    if (!LOGIN.test(request.account)) throw new ProjectStartError(400, "GitHub のアカウントの名前として読めません");
    if (parsed.kind !== "github" || !overHttp) {
      throw new ProjectStartError(400, "GitHub のアカウントは GitHub の https の URL でだけ使えます");
    }
  }
  return { url, github: parsed.kind === "github" };
}

/** `POST /api/projects` の `start` を読む（形だけ。URL の決まりは `cloneUrlOf`） */
export function parseStartRequest(raw: unknown): StartRequest {
  if (!raw || typeof raw !== "object") throw new ProjectStartError(400, "start は { kind: \"init\" } か { kind: \"clone\", url } で渡してください");
  const r = raw as { kind?: unknown; url?: unknown; account?: unknown };
  if (r.kind === "init") return { kind: "init" };
  if (r.kind === "clone") {
    if (typeof r.url !== "string") throw new ProjectStartError(400, "clone には url が要ります");
    if (r.account !== undefined && r.account !== null && typeof r.account !== "string") {
      throw new ProjectStartError(400, "account は GitHub の login で渡してください");
    }
    return { kind: "clone", url: r.url, ...(typeof r.account === "string" && r.account !== "" ? { account: r.account } : {}) };
  }
  throw new ProjectStartError(400, "start.kind は init か clone です");
}

/** 「5 分」「30 秒」 */
const spanLabel = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} 分` : `${Math.round(ms / 1000)} 秒`);

/** 失敗した git の出力から、人に見せる数行（進み具合の行は最後の分だけ） */
function tailOf(run: ShellRun): string {
  const lines = `${run.stderr}\n${run.stdout}`
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^(Receiving|Resolving|Counting|Compressing|Enumerating|remote: (Counting|Compressing|Enumerating|Total))/.test(l));
  return lines.slice(-3).join(" / ");
}

export class ProjectStarter {
  /** 走っている仕事（Project の id）。1つの Project に同時に1本 */
  private readonly running = new Set<string>();

  constructor(private readonly deps: ProjectStartDeps) {}

  /**
   * **作る**（仕様の 2.）。置く場所に名前のフォルダを作り、そこを根に Project を作り、始め方の仕事を始めて返す。
   * URL の断りは何も作る前に
   */
  async create(input: { runtime: string; parent: string | undefined; folder: string; name: string; start: StartRequest }): Promise<ProjectState> {
    const mode = this.deps.remote.modeOf(input.runtime);
    if (!mode) throw new ProjectStartError(400, `実行場所「${input.runtime}」はありません`);
    if (input.start.kind === "clone") cloneUrlOf(input.start, this.deps.github, mode);
    const dir = await this.deps.remote.createDirectory(input.runtime, input.parent, input.folder);
    let project: ProjectState;
    try {
      project = await this.deps.remote.createProject(input.runtime, input.name, dir);
    } catch (err) {
      // 作ったのは空のフォルダだけ——消して、断られた理由をそのまま返す（片づけに失敗しても元の理由を隠さない）
      await this.deps.remote.removeEmptyDirectory(input.runtime, dir).catch((cleanupErr: unknown) => {
        this.deps.log?.(`[host] 作った空のフォルダ ${dir} を片づけられませんでした: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      });
      throw err;
    }
    await this.begin(project.id, input.start);
    return this.deps.projectThread.getProject(project.id) ?? project;
  }

  /** **もう一度**（失敗した・途中で止まったものを同じ中身で） */
  async retry(projectId: string): Promise<ProjectState> {
    const project = this.deps.projectThread.getProject(projectId);
    if (!project) throw new ProjectStartError(404, "Project がありません");
    const start = project.start;
    if (!start) throw new ProjectStartError(409, "この Project に始め方の仕事はありません");
    if (start.status !== "failed" && start.status !== "interrupted") {
      throw new ProjectStartError(409, start.status === "done" ? "始め方の仕事はもう終わっています" : "始め方の仕事はいま走っています");
    }
    const request: StartRequest =
      start.kind === "init" ? { kind: "init" } : { kind: "clone", url: start.url ?? "", ...(start.account ? { account: start.account } : {}) };
    await this.begin(projectId, request);
    return this.deps.projectThread.getProject(projectId)!;
  }

  /** **起き直したとき**：走っていた仕事を `interrupted` にする（git は Shell との接続が閉じたときに止まっている。流し直さない） */
  async recoverInterrupted(): Promise<void> {
    for (const p of this.deps.projectThread.listProjects()) {
      const s = p.start;
      if (!s || (s.status !== "waking" && s.status !== "running") || this.running.has(p.id)) continue;
      await this.write(p.id, { ...s, status: "interrupted", error: "banto を起こし直したので、途中で止まりました" });
    }
  }

  /** いま走っているか（眠らせない・移さない） */
  isRunning(projectId: string): boolean {
    return this.running.has(projectId);
  }

  /** 帯に出すもの（終わっていないもの）。画面が繋いだときに渡す */
  pending(): Array<{ projectId: string; start: ProjectStart }> {
    return this.deps.projectThread
      .listProjects()
      .flatMap((p) => (p.start && p.start.status !== "done" ? [{ projectId: p.id, start: p.start }] : []));
  }

  private async begin(projectId: string, request: StartRequest): Promise<void> {
    if (this.running.has(projectId)) throw new ProjectStartError(409, "この Project の始め方の仕事はいま走っています");
    const project = this.deps.projectThread.getProject(projectId);
    const remote = project?.runtime?.startsWith("remote:") ? project.runtime.slice("remote:".length) : undefined;
    const mode = remote ? this.deps.remote.modeOf(remote) : undefined;
    if (!project || !mode) throw new ProjectStartError(400, "始め方の仕事は別のサーバの Project でだけ流せます");
    // 確かめは記録より先に（断るなら何も積まない）
    const clone = request.kind === "clone" ? cloneUrlOf(request, this.deps.github, mode) : undefined;
    this.running.add(projectId);
    const start: ProjectStart = {
      kind: request.kind,
      ...(request.kind === "clone" ? { url: request.url.trim() } : {}),
      ...(request.kind === "clone" && request.account ? { account: request.account } : {}),
      startedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      status: "waking",
    };
    try {
      await this.write(projectId, start);
    } catch (err) {
      this.running.delete(projectId);
      throw err;
    }
    void this.run(projectId, project.root, start, clone?.url).finally(() => this.running.delete(projectId));
  }

  private async write(projectId: string, start: ProjectStart): Promise<void> {
    await this.deps.projectThread.setProjectStart(projectId, start);
    this.deps.onChange?.(projectId, start);
  }

  private async run(projectId: string, root: string, start: ProjectStart, cloneUrl: string | undefined): Promise<void> {
    const { error: _error, ...base } = start;
    try {
      const shell = await this.deps.wakeShell(projectId);
      await this.write(projectId, { ...base, status: "running" });
      if (start.kind === "init") await this.init(shell, root);
      else await this.clone(shell, projectId, root, cloneUrl!, start.account);
      await this.write(projectId, { ...base, status: "done" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`[host] project ${projectId} の始め方（${start.kind}）が失敗しました: ${reason}`);
      await this.write(projectId, { ...base, status: "failed", error: reason }).catch((writeErr: unknown) =>
        this.deps.log?.(`[host] project ${projectId} の始め方の失敗を記録できませんでした: ${String(writeErr)}`),
      );
    }
  }

  /** 新しいリポジトリ：既定のブランチ名（Shell のホームの git の設定、無ければ main）を読み、別に init する */
  private async init(shell: ProjectShell, root: string): Promise<void> {
    const read = await this.exec(shell, { command: "git config --global --get init.defaultBranch || true" }, "既定のブランチ名を読めませんでした");
    const configured = read.stdout.trim();
    const branch = /^[A-Za-z0-9._/-]+$/.test(configured) && !configured.startsWith("-") ? configured : "main";
    await this.exec(shell, { command: `cd -- ${shq(root)} && ${GIT} init -b ${shq(branch)}` }, "git init が失敗しました");
  }

  private async clone(shell: ProjectShell, projectId: string, root: string, url: string, account: string | undefined): Promise<void> {
    const work = cloneWorkDir(projectId);
    const at = `cd -- ${shq(root)} &&`;
    // 前の回の作業フォルダ（起こし直しで中断したもの）を片づけ、根が空かを見る
    await this.exec(
      shell,
      {
        command:
          `${at} rm -rf -- ${shq(work)} && if [ -n "$(ls -A)" ]; then ` +
          `printf '%s\\n' 'Root のフォルダが空ではないので clone しません（中のものを退かしてから、もう一度を押してください）' >&2; exit 3; fi`,
      },
      "clone の用意ができませんでした",
    );
    const helper = account ? ` -c ${shq(`credential.helper=!${credentialHelperScript(this.deps.github)}`)}` : "";
    try {
      await this.exec(
        shell,
        {
          command: `${at} ${GIT} -c credential.helper=${helper} clone --progress -- ${shq(url)} ${shq(work)}`,
          ...(account ? { envSecrets: { GIT_HTTP_TOKEN: githubAccountAlias(account) } } : {}),
        },
        "git clone が失敗しました",
        { watchStall: true },
      );
    } catch (err) {
      // 消すのは自分が作った作業フォルダだけ。片づけに失敗しても元の理由を隠さない
      await this.exec(shell, { command: `${at} rm -rf -- ${shq(work)}` }, "作業フォルダを片づけられませんでした").catch((cleanupErr: unknown) =>
        this.deps.log?.(`[host] project ${projectId} の clone の作業フォルダを片づけられませんでした: ${String(cleanupErr)}`),
      );
      throw err;
    }
    await this.exec(
      shell,
      { command: `${at} find ${shq(work)} -mindepth 1 -maxdepth 1 -exec mv -t . -- {} + && rmdir -- ${shq(work)}` },
      "clone した中身を Root へ動かせませんでした",
    );
  }

  /**
   * Shell で1つ流す。終了コードが 0 でなければ `what` と出力の末尾で投げる。`watchStall` なら出力の文字数が `stallMs` の間
   * 変わらなければ取り消す（MCP の取り消し——Shell が子プロセスを止める）
   */
  private async exec(
    shell: ProjectShell,
    args: { command: string; envSecrets?: Record<string, string> },
    what: string,
    opts: { watchStall?: boolean } = {},
  ): Promise<ShellRun> {
    const controller = new AbortController();
    const stallMs = this.deps.stallMs ?? START_STALL_MS;
    let stalled = false;
    let lastChars = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (!opts.watchStall) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, stallMs);
      timer.unref?.();
    };
    arm();
    try {
      const run = await shell.run(
        { command: args.command, timeoutSec: START_TIMEOUT_SEC, ...(args.envSecrets ? { envSecrets: args.envSecrets } : {}) },
        {
          signal: controller.signal,
          onProgress: (chars) => {
            if (chars !== lastChars) {
              lastChars = chars;
              arm();
            }
          },
        },
      );
      if (stalled) throw new Error(`${what}：git が ${spanLabel(stallMs)}のあいだ何も出力しなかったので取り消しました`);
      if (run.timedOut) throw new Error(`${what}：${START_TIMEOUT_SEC / 3600} 時間を超えたので止めました`);
      if (run.exitCode !== 0) {
        const tail = tailOf(run);
        throw new Error(tail ? `${what}：${tail}` : `${what}（終了コード ${run.exitCode}）`);
      }
      return run;
    } catch (err) {
      if (stalled) throw new Error(`${what}：git が ${spanLabel(stallMs)}のあいだ何も出力しなかったので取り消しました`);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
