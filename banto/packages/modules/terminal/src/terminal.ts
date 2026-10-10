// **セッションの操作**（v4-modules.md §4.6「画面」）——画面のセッションの切り替え（足す・名前を変える・閉じる）が使う。
//
// 生きているかどうかは tmux に聞く。コンテナを起こし直して消えたものは、控え（`SessionStore`）にだけ残り、
// 一覧の `lost` に出る——作り直す（同じ名前で `createSession`）か、閉じて控えから消すかだけができる。

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SessionStore, KnownSession } from "./store.js";
import { assertSessionName, TerminalError, type LiveSession, type Tmux } from "./tmux.js";
import { parseSize, type TerminalSize } from "./stream.js";

export interface TerminalDeps {
  tmux: Tmux;
  store: SessionStore;
  projectRoot: string;
  /** シェルに渡す環境（専用のホーム・XDG・locale・Claude のログインの中継） */
  sessionEnv: Record<string, string>;
  /** シェルを起こす前の用意（専用のホームのフォルダを作る等） */
  prepare?: () => Promise<void>;
  log?: (line: string) => void;
}

export interface SessionList {
  sessions: LiveSession[];
  /** 前にあったが、いまは無いもの（コンテナを起こし直した等） */
  lost: KnownSession[];
}

const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

export class Terminal {
  /** tmux の用意（成功だけを覚える——失敗したら次の呼び出しでやり直す） */
  private installed: Promise<void> | undefined;

  constructor(private readonly deps: TerminalDeps) {}

  private ensureTmux(): Promise<void> {
    if (!this.installed) {
      const log = this.deps.log ?? ((line: string) => process.stderr.write(`[terminal] ${line}\n`));
      this.installed = this.deps.tmux.ensureInstalled(log);
      this.installed.catch(() => {
        this.installed = undefined;
      });
    }
    return this.installed;
  }

  async listSessions(): Promise<SessionList> {
    await this.ensureTmux();
    const sessions = await this.deps.tmux.list();
    this.deps.store.remember(sessions.map((s) => ({ name: s.name, cwd: s.cwd })));
    const lost = this.deps.store.read().filter((k) => !sessions.some((s) => s.name === k.name));
    return { sessions, lost };
  }

  /**
   * セッションを足す。`cwd` を書かなければ、消えたセッションの控えがあればその作業ディレクトリ、無ければ Project の根。
   * 同じ名前が生きていれば断る
   */
  async createSession(args: { name?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown }): Promise<SessionList> {
    const name = assertSessionName(args.name);
    const { tmux, store } = this.deps;
    await this.ensureTmux();
    if (await tmux.has(name)) throw new TerminalError(`セッション「${name}」はもうあります`);
    let cwd: string;
    if (args.cwd !== undefined) {
      if (typeof args.cwd !== "string" || !isAbsolute(args.cwd)) throw new TerminalError("cwd は絶対パスで書いてください");
      cwd = args.cwd;
    } else {
      cwd = store.read().find((k) => k.name === name)?.cwd ?? this.deps.projectRoot;
    }
    const isDir = await stat(cwd).then((s) => s.isDirectory(), () => false);
    if (!isDir) throw new TerminalError(`作業ディレクトリ ${cwd} がありません`);
    const size = args.cols === undefined && args.rows === undefined ? DEFAULT_SIZE : parseSize(args.cols, args.rows);
    if (!size) throw new TerminalError("端末の大きさ（cols・rows）が範囲の外です");
    await this.deps.prepare?.();
    await tmux.create(name, cwd, this.deps.sessionEnv, size);
    store.remember([{ name, cwd }]);
    return this.listSessions();
  }

  async renameSession(args: { name?: unknown; newName?: unknown }): Promise<SessionList> {
    const from = assertSessionName(args.name);
    const to = assertSessionName(args.newName);
    const { tmux, store } = this.deps;
    if (from === to) return this.listSessions();
    if (!(await tmux.has(from))) throw new TerminalError(`セッション「${from}」はありません`);
    if (await tmux.has(to)) throw new TerminalError(`セッション「${to}」はもうあります`);
    await tmux.rename(from, to);
    store.rename(from, to);
    return this.listSessions();
  }

  /** 閉じる（中のシェルは終わる）。消えたセッションなら控えから消すだけ */
  async closeSession(args: { name?: unknown }): Promise<SessionList> {
    const name = assertSessionName(args.name);
    const { tmux, store } = this.deps;
    if (await tmux.has(name)) await tmux.kill(name);
    else if (!store.read().some((k) => k.name === name)) throw new TerminalError(`セッション「${name}」はありません`);
    store.forget(name);
    return this.listSessions();
  }
}
