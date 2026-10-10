// **コンテナの中の tmux（専用のソケット `tmux -L banto-terminal`）**（v4-modules.md §4.6）。
//
// シェルは Terminal の Module が抱えず、tmux のセッションとして起こす——Module・banto を起こし直しても残る
// （tmux のサーバは自分で切り離して動く。`incus exec` の client を殺しても残ることを測った・2026-10-08）。
// 同じコンテナの AI も Shell から `tmux -L banto-terminal …` で同じセッションを読める・打てる（決定・2026-10-08）。

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { inWorkScope } from "@banto/module-contract";

const run = promisify(execFile);

/** 専用のソケットの名前（人の tmux と混ざらない。AI が Shell から指すときもこの名前） */
export const TMUX_SOCKET = "banto-terminal";

/** 既定のセッションの名前 */
export const DEFAULT_SESSION = "main";

/**
 * セッションの名前の形：文字・数字・`_`・`-` で 1〜40 字。tmux が特別に扱う `:`・`.`、コマンドの区切りや引用符を
 * 入れさせない（制御モードの1行に名前をそのまま書くため）
 */
const NAME_PATTERN = /^[\p{L}\p{N}_-]{1,40}$/u;

export class TerminalError extends Error {}

/** tmux のサーバが居ない（セッションが1つも無いとサーバは終わる）ときの言い方 */
// 「server exited unexpectedly」は、終わりかけのサーバに繋いだとき（最後のセッションが閉じた直後・kill-server の直後——実測）
const isNoServer = (message: string) =>
  /no server running|error connecting to|No such file or directory|server exited unexpectedly/i.test(message);

export function sessionNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || name === "") return "セッションの名前がありません";
  if (!NAME_PATTERN.test(name)) return `セッションの名前「${name}」は使えません（文字・数字・「_」「-」で 40 字まで）`;
  return undefined;
}

export function assertSessionName(name: unknown): string {
  const problem = sessionNameProblem(name);
  if (problem) throw new TerminalError(problem);
  return name as string;
}

/** 制御モードの1行・コマンドの引数で、セッションを名前どおりに指す（前方一致にしない `=`） */
export const sessionTarget = (name: string) => `=${name}`;
export const paneTarget = (name: string) => `=${name}:`;

export interface LiveSession {
  name: string;
  /** いまの作業ディレクトリ（作業中のペインの） */
  cwd: string;
  /** 繋いでいる client の数（画面・人の tmux） */
  clients: number;
  createdAt: string;
}

export interface TmuxOptions {
  /** tmux とシェルに渡す環境（host が Module に渡した `BANTO_*` は落としたもの） */
  env: NodeJS.ProcessEnv;
  /** ソケットの名前（試験だけが替える） */
  socket?: string;
}

/** 新しいペインに効かせたいので、セッションを作るのと同じ1回の呼び出しの先頭で設定する */
const SERVER_OPTIONS: string[][] = [
  // 大きさは最後に打った方に合わせる（パソコンと携帯で同じセッションを開くとき）
  ["set-option", "-g", "window-size", "latest"],
  // 画面にはセッションの切り替えがあるので、tmux の状態の行は要らない
  ["set-option", "-g", "status", "off"],
  ["set-option", "-g", "history-limit", "10000"],
  ["set-option", "-g", "default-terminal", "tmux-256color"],
];

export class Tmux {
  readonly socket: string;

  constructor(private readonly options: TmuxOptions) {
    this.socket = options.socket ?? TMUX_SOCKET;
  }

  private base(): string[] {
    // `-u`：UTF-8 で話す（環境の locale に頼らない）
    return ["-u", "-L", this.socket];
  }

  async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run("tmux", [...this.base(), ...args], { env: this.options.env, timeout: 10_000 });
      return stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") throw new TerminalError("tmux が入っていません（コンテナに tmux が要ります）");
      throw new TerminalError((e.stderr ?? "").trim() || e.message);
    }
  }

  /**
   * **tmux が無ければ入れる**。tmux はベースのイメージに入っている（`BASE_PACKAGES`）が、足す前のイメージから作った
   * Project のコンテナには無い——中では誰でもパスワード無しで sudo できる（ベースのイメージの決めごと）ので、
   * そのコンテナに入れる。入れたことは記録に書き、入れられなければ理由ごと投げる（黙って使えないままにしない）
   */
  async ensureInstalled(log: (line: string) => void): Promise<void> {
    try {
      await run("tmux", ["-V"], { env: this.options.env, timeout: 10_000 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new TerminalError(`tmux を確かめられません: ${(err as Error).message}`);
    }
    log("このコンテナに tmux が無いので入れます（tmux をベースのイメージに足す前に作ったコンテナ）");
    try {
      await run(
        "sudo",
        ["-n", "sh", "-c", "apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends tmux"],
        { env: this.options.env, timeout: 300_000 },
      );
    } catch (err) {
      // 別のサーバ（実行場所）では sudo が無い・パスワードが要ることがある。そのままの sudo のエラーだけを出さず、人が向こうで
      // 打つ入れ方を添える（v4-security.md §1「前提の確かめ」——特定の Module だけが使う道具は、使うときに理由と入れ方を添えて断る）
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      const detail = e.code === "ENOENT" ? "sudo がありません" : (e.stderr ?? "").trim().split("\n").slice(-3).join(" ") || e.message;
      throw new TerminalError(
        `この実行場所には tmux がありません。自動では入れられませんでした（${detail}）。向こうで \`sudo apt install tmux\` を打ってから開き直してください`,
      );
    }
  }

  /** 生きているセッション。サーバが居なければ空（セッションが1つも無いとサーバは終わる） */
  async list(): Promise<LiveSession[]> {
    let out: string;
    try {
      out = await this.exec([
        "list-sessions",
        "-F",
        "#{session_name}\t#{pane_current_path}\t#{session_attached}\t#{session_created}",
      ]);
    } catch (err) {
      // サーバが居ない＝セッションが無い（ここだけは失敗ではない）
      if (isNoServer((err as Error).message)) return [];
      throw err;
    }
    return out
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [name = "", cwd = "", attached = "0", created = "0"] = line.split("\t");
        return { name, cwd, clients: Number(attached) || 0, createdAt: new Date(Number(created) * 1000).toISOString() };
      });
  }

  async has(name: string): Promise<boolean> {
    return (await this.list()).some((s) => s.name === name);
  }

  /** tmux の id（`$3` など）のセッションがまだあるか——名前を変えられても同じものを指せる */
  async hasId(id: string): Promise<boolean> {
    try {
      return (await this.exec(["list-sessions", "-F", "#{session_id}"])).split("\n").includes(id);
    } catch (err) {
      if (isNoServer((err as Error).message)) return false;
      throw err;
    }
  }

  /** セッションを作る。`env` はシェルに渡す（tmux のサーバが前から居ても効くように、セッションごとに渡す） */
  async create(name: string, cwd: string, env: Record<string, string>, size: { cols: number; rows: number }): Promise<void> {
    const args: string[] = [];
    for (const option of SERVER_OPTIONS) args.push(...option, ";");
    args.push("new-session", "-d", "-s", name, "-c", cwd, "-x", String(size.cols), "-y", String(size.rows));
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    // **仕事の組に入れて起こす**（段2a、`docs/specs/v4-security.md` §1。決めた経緯は docs/notes/2026-10-08-terminal-module.md）。
    // tmux のサーバはこの呼び出しで生まれて自分で切り離すので、サーバとその下の人のシェルが組に入り、人が打ったビルドが
    // メモリを食い尽くしても組の中だけで止まる。oom.group は付けない——サーバごと止めると人のセッションが全部消える。
    // サーバが前から居れば、組に入るのはすぐ終わる client だけ（害は無い）
    const launch = inWorkScope("tmux", [...this.base(), ...args], { kind: "terminal", env: this.options.env, oomGroup: false });
    try {
      await run(launch.command, launch.args, { env: launch.env, timeout: 10_000 });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.code === "ENOENT") throw new TerminalError(`${launch.command} が入っていません`);
      throw new TerminalError((e.stderr ?? "").trim() || e.message);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await this.exec(["rename-session", "-t", sessionTarget(from), to]);
  }

  async kill(name: string): Promise<void> {
    await this.exec(["kill-session", "-t", sessionTarget(name)]);
  }

  /** 制御モードの client を起こす（そのセッションに繋ぐ） */
  attachControl(name: string): ChildProcessWithoutNullStreams {
    return spawn("tmux", [...this.base(), "-C", "attach-session", "-t", sessionTarget(name)], {
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
