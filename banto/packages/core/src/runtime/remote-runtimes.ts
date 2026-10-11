// **実行場所「別のサーバ」の登録と、選ぶときの判断**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」、
// Backlog `remote-runtime-registry`）。
//
// 登録の順（画面もこの順で進む）：
//   1. 宛先を書く → **host 鍵を引く**（`scan`。まだ繋がない）
//   2. 指紋を人が向こうで確かめる → **その鍵で繋いで前提を確かめる**（`check`）
//   3. **登録する**（`register`。host がもう一度確かめる——画面が送ってきた結果を信じない。✕ があれば断る）
//
// 覚えた鍵と違う鍵が返ってきたら繋がない（`StrictHostKeyChecking=yes`）。そのとき向こうがいま返す鍵を引いて記録し、
// 画面に「覚えていた鍵」と並べて出す。人が向こうで確かめて「覚え直す」を押すまで、その実行場所は使えない。
//
// known_hosts と公開鍵のファイルは、繋ぐたびに記録から書き出す（真実は記録だけ。規則3）。置き場は banto のデータの置き場の
// 中で、人の `~/.ssh` には触らない。鍵は Vault に ssh-agent を立ててもらう（core が自分のために頼む——人が登録した鍵だけ）。

import { coreSocketDir } from "./socket-dir.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_REMOTE_DATA_ROOT,
  HOST_CONTAINER_RUNTIME,
  REMOTE_RUNTIME_PREFIX,
  type RemoteRuntime,
  type RemoteRuntimeInput,
  type RemoteRuntimeStore,
} from "./remote-store.js";
import {
  fingerprintOf,
  isHostKeyRefusal,
  knownHostsLine,
  listRemoteDirectories,
  probePrerequisites,
  realpathRemote,
  remoteRootIncludesDataRoot,
  scanHostKey,
  sshFailure,
  SshCommandError,
  targetProblem,
  type HostKey,
  type RemoteDirectoryListing,
  type RuntimeCheck,
  type SshFiles,
} from "./ssh.js";

/** 画面に返す失敗（状態番号つき）。理由はそのまま人に見せる */
export class RemoteRuntimeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface RemoteRuntimeDeps {
  dataDir: string;
  store: RemoteRuntimeStore;
  /** Vault に、その SSH 鍵を持った ssh-agent を `socketDir` に立ててもらう。窓口のパスを返す */
  startSshAgent(identity: string, socketDir: string): Promise<string>;
  /** その SSH 鍵の公開鍵（`ssh-ed25519 AAAA…`） */
  publicKeyOf(identity: string): Promise<string>;
  /**
   * その実行場所を使っている Project（閉じたものも数える——閉じても向こうの置き場は残り、再開できる）。移している途中の
   * Project は、移す先としても数える
   */
  projectsUsing(runtime: string): Array<{ id: string; name: string }>;
}

/** 一覧に出す1件（記録＋導いた値） */
export interface RemoteRuntimeView extends RemoteRuntime {
  /** Project の記録に書く印（`remote:<名前>`） */
  runtime: string;
  usedBy: Array<{ id: string; name: string }>;
  /** 新しい Project で選べない理由。選べるなら無し */
  unavailableReason?: string;
}

/** 名前の形（id も兼ねる。Project の記録・置き場のフォルダ名に入る） */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function runtimeIdOf(name: string): string {
  return `${REMOTE_RUNTIME_PREFIX}${name}`;
}

/** Project の記録の `runtime` から、別のサーバの名前を引く（この機械のコンテナなら undefined） */
export function remoteNameOf(runtime: string | undefined): string | undefined {
  return runtime?.startsWith(REMOTE_RUNTIME_PREFIX) ? runtime.slice(REMOTE_RUNTIME_PREFIX.length) : undefined;
}

/** 画面から来た宛先を確かめて形を揃える（壊れた値は入れない——規則2） */
export function parseRuntimeInput(raw: unknown): RemoteRuntimeInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
  const input: RemoteRuntimeInput = {
    name: str("name"),
    host: str("host"),
    user: str("user"),
    port: typeof b.port === "number" ? b.port : Number(str("port") || "22"),
    identity: str("identity"),
    dataRoot: str("dataRoot") || DEFAULT_REMOTE_DATA_ROOT,
  };
  if (!NAME_PATTERN.test(input.name)) {
    throw new RemoteRuntimeError(400, "名前は英小文字・数字・- で 32 字まで（先頭は英小文字か数字）にしてください");
  }
  const problem = targetProblem(input);
  if (problem) throw new RemoteRuntimeError(400, problem);
  if (!input.identity) throw new RemoteRuntimeError(400, "SSH 鍵（Vault の alias）を選んでください");
  if (!input.dataRoot.startsWith("/") && input.dataRoot !== "~" && !input.dataRoot.startsWith("~/")) {
    throw new RemoteRuntimeError(400, "向こうの置き場は絶対パスか ~ で始めてください");
  }
  if (/[\0\n]/.test(input.dataRoot)) throw new RemoteRuntimeError(400, "向こうの置き場に使えない字があります");
  return input;
}

/** 画面から来た host 鍵（人が見て確かめたもの）を確かめる */
export function parseHostKey(raw: unknown): HostKey {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.type !== "string" || !/^[a-z0-9@.-]+$/.test(b.type) || typeof b.key !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b.key)) {
    throw new RemoteRuntimeError(400, "host 鍵の形が違います");
  }
  // 指紋は画面の言うことを信じず、鍵から計算し直す
  return { type: b.type, key: b.key, fingerprint: fingerprintOf(b.key) };
}

export class RemoteRuntimes {
  /** 実行場所ごとの、いま通している Project の作成（1本ずつ通す） */
  private readonly creating = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: RemoteRuntimeDeps) {}

  /** 一覧（使っている Project・選べない理由を添える） */
  list(): RemoteRuntimeView[] {
    return this.deps.store.list().map((r) => this.view(r));
  }

  get(name: string): RemoteRuntimeView | undefined {
    const r = this.deps.store.get(name);
    return r ? this.view(r) : undefined;
  }

  /**
   * **新しい Project で選べない理由**（画面にそのまま出す）。順に：ほかの Project が使っている（1つの実行場所に
   * Project は1つ——v4-security.md §1）→ host 鍵が違う → 前提が足りない
   */
  unavailableReason(r: RemoteRuntime): string | undefined {
    const used = this.deps.projectsUsing(runtimeIdOf(r.name))[0];
    if (used) return `Project「${used.name}」が使っています（1つの実行場所に Project は1つ）`;
    if (r.hostKeyMismatch) return "host 鍵が前と違うので繋ぎません";
    if (r.checks.some((c) => c.status === "fail")) return "前提が足りません";
    return undefined;
  }

  /** 1. host 鍵を引く（まだ繋がない・覚えない） */
  async scan(input: RemoteRuntimeInput): Promise<HostKey> {
    try {
      return await scanHostKey(input);
    } catch (err) {
      throw new RemoteRuntimeError(502, err instanceof Error ? err.message : String(err));
    }
  }

  /** 2. 人が確かめた鍵で繋いで、前提を確かめる（まだ登録しない） */
  async check(input: RemoteRuntimeInput, hostKey: HostKey): Promise<RuntimeCheck[]> {
    return this.probe(input, hostKey, `.probe-${randomBytes(4).toString("hex")}`, true);
  }

  /** 前提を確かめる。`dirName` の置き場に known_hosts・公開鍵を書き出して繋ぐ（`temporary` なら終わったら消す） */
  private probe(input: RemoteRuntimeInput, hostKey: HostKey, dirName: string, temporary: boolean): Promise<RuntimeCheck[]> {
    return this.withFiles(input, hostKey, dirName, temporary, async (files) => {
      const { checks, result } = await probePrerequisites(input, files, hostKey.type, input.dataRoot);
      if (checks.length > 0) return checks;
      if (isHostKeyRefusal(result)) {
        throw new RemoteRuntimeError(409, "確かめた鍵と、いま向こうが返す鍵が違います。もう一度「繋いで確かめる」からやり直してください");
      }
      throw new RemoteRuntimeError(502, sshFailure(`${input.user}@${input.host} に繋げませんでした`, result).message);
    });
  }

  /** 3. 登録する。host がもう一度確かめ、✕ があれば断る */
  async register(input: RemoteRuntimeInput, hostKey: HostKey): Promise<RemoteRuntimeView> {
    if (this.deps.store.get(input.name)) throw new RemoteRuntimeError(409, `「${input.name}」という名前はもう使われています`);
    // 登録のときから恒久の置き場（`remote-runtimes/<名前>/`）に書き出して繋ぐ——known_hosts は「繋ぐたびに記録から
    // 書き出す」写しなので、登録の接続でも同じ場所に書く。登録しなかったら消す（記録に無い名前の写しを残さない）
    const dir = join(this.deps.dataDir, "remote-runtimes", input.name);
    try {
      const checks = await this.probe(input, hostKey, input.name, false);
      if (checks.some((c) => c.status === "fail")) {
        throw new RemoteRuntimeError(409, "足りない前提があるので登録できません", { checks });
      }
      return this.view(await this.deps.store.register(input, hostKey, checks));
    } catch (err) {
      if (!this.deps.store.get(input.name)) rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** 確かめ直す。鍵が違えば繋がずに記録する */
  async recheck(name: string): Promise<RemoteRuntimeView> {
    const r = this.mustGetUsable(name);
    await this.connect(r, async (files) => {
      const { checks, result } = await probePrerequisites(r, files, r.hostKey.type, r.dataRoot);
      if (checks.length === 0) return this.refused(r, result, "前提を確かめられませんでした");
      await this.deps.store.recordChecks(r.name, checks);
    });
    return this.view(this.deps.store.get(name)!);
  }

  /**
   * **新しい鍵を覚え直す**。人が見た指紋（`fingerprint`）が、記録した「いま返ってきた鍵」と同じときだけ
   * ——見ている間にまた変わっていたら断る。覚え直したら、その鍵で繋いで確かめ直す
   */
  async acceptHostKey(name: string, fingerprint: string): Promise<RemoteRuntimeView> {
    const r = this.deps.store.get(name);
    if (!r) throw new RemoteRuntimeError(404, `実行場所「${name}」はありません`);
    if (!r.hostKeyMismatch) throw new RemoteRuntimeError(409, "覚え直す鍵がありません（host 鍵は前と同じです）");
    if (r.hostKeyMismatch.fingerprint !== fingerprint) {
      throw new RemoteRuntimeError(409, "確かめた指紋と、記録した新しい鍵の指紋が違います。画面を読み直してください");
    }
    const { seenAt: _seenAt, ...hostKey } = r.hostKeyMismatch;
    await this.deps.store.acceptHostKey(name, hostKey);
    return this.recheck(name);
  }

  /** 外す。使っている Project があれば外せない（閉じた Project も——再開できるので） */
  async remove(name: string): Promise<void> {
    if (!this.deps.store.get(name)) throw new RemoteRuntimeError(404, `実行場所「${name}」はありません`);
    const used = this.deps.projectsUsing(runtimeIdOf(name))[0];
    if (used) throw new RemoteRuntimeError(409, `Project「${used.name}」が使っているあいだは外せません`);
    await this.deps.store.remove(name);
  }

  /** 向こうのフォルダの一覧（名前だけ） */
  async listDirectories(name: string, path: string | undefined): Promise<RemoteDirectoryListing> {
    const r = this.mustGetUsable(name);
    return this.connect(r, (files) => listRemoteDirectories(r, files, r.hostKey.type, path));
  }

  /** **広すぎる根か**（向こうの banto の置き場を含むか）。`/api/config/root-scope` と同じ形で返す */
  async describeRootScope(name: string, root: string): Promise<{ wide: boolean; includes: string[] }> {
    const r = this.mustGetUsable(name);
    const { includes, dataRoot } = await this.connect(r, (files) =>
      remoteRootIncludesDataRoot(r, files, r.hostKey.type, root, r.dataRoot),
    );
    return includes
      ? { wide: true, includes: [`banto が向こうに置くコードと Module の状態（${dataRoot}）`] }
      : { wide: false, includes: [] };
  }

  /**
   * **別のサーバに Project を作る**。根を向こうで正規化し（作るときに1回）、`create` に渡す。選べない実行場所なら理由を
   * 添えて断る——画面が薄く出していても host がもう一度確かめる。**1つの実行場所に Project は1つ**なので、同じ実行場所への
   * 作成は1本ずつ通し、正規化のあとでもう一度確かめる（同時に2つ押されても2つ目は断る）
   */
  async createProjectOn<T>(name: string, root: string, create: (resolvedRoot: string, runtime: string) => Promise<T>): Promise<T> {
    return this.exclusive(name, async () => {
      const r = this.deps.store.get(name);
      if (!r) throw new RemoteRuntimeError(400, `実行場所「${name}」はありません`);
      const before = this.unavailableReason(r);
      if (before) throw new RemoteRuntimeError(409, `実行場所「${name}」は選べません：${before}`);
      const resolved = await this.connect(r, (files) => realpathRemote(r, files, r.hostKey.type, root));
      const after = this.deps.store.get(name);
      const reason = after ? this.unavailableReason(after) : "登録が外されました";
      if (reason) throw new RemoteRuntimeError(409, `実行場所「${name}」は選べません：${reason}`);
      return create(resolved, runtimeIdOf(name));
    });
  }

  /**
   * **その実行場所を押さえて `fn` を通す**（1本ずつ）。Project の作成と、別の実行場所へ移す（移す先として。
   * v4-security.md §1「Project を別の実行場所へ移す」の 4）が同じ鍵で並ぶ——1つの実行場所に Project は1つ
   */
  async exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.creating.get(name) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.creating.set(name, run);
    try {
      return await run;
    } finally {
      if (this.creating.get(name) === run) this.creating.delete(name);
    }
  }

  /**
   * **本当の起動のために繋ぐ**（`remote-ssh.ts`）。known_hosts・公開鍵を書き出し、Vault に鍵の窓口を立ててもらってから
   * `fn` を呼ぶ。無い・鍵が違う、は繋ぐ前に断る。ssh そのものが鍵の違いで落ちたら（`SshCommandError`）、いまの鍵を記録して断る
   */
  async withConnection<T>(name: string, fn: (r: RemoteRuntime, files: SshFiles) => Promise<T>): Promise<T> {
    const r = this.mustGetUsable(name);
    return this.connect(r, (files) => fn(r, files));
  }

  /** 繋いだときに確かめた前提を記録する（設定の一覧に出す） */
  async recordChecks(name: string, checks: RuntimeCheck[]): Promise<void> {
    if (this.deps.store.get(name)) await this.deps.store.recordChecks(name, checks);
  }

  private view(r: RemoteRuntime): RemoteRuntimeView {
    const reason = this.unavailableReason(r);
    return {
      ...r,
      runtime: runtimeIdOf(r.name),
      usedBy: this.deps.projectsUsing(runtimeIdOf(r.name)),
      ...(reason ? { unavailableReason: reason } : {}),
    };
  }

  /** 繋いでよい実行場所か（無い・鍵が違う、は繋ぐ前に断る） */
  private mustGetUsable(name: string): RemoteRuntime {
    const r = this.deps.store.get(name);
    if (!r) throw new RemoteRuntimeError(404, `実行場所「${name}」はありません`);
    if (r.hostKeyMismatch) {
      throw new RemoteRuntimeError(409, "host 鍵が前と違うので繋ぎません。向こうで指紋を確かめて、覚え直してください");
    }
    return r;
  }

  /**
   * 登録した1件に繋ぐ。ssh そのものが落ちたら（`SshCommandError`）、鍵の違いならいまの鍵を引いて記録し、繋がずに断る。
   * 向こうで答えた断り（フォルダが無い等）は、そのまま人に見せる
   */
  private connect<T>(r: RemoteRuntime, fn: (files: SshFiles) => Promise<T>): Promise<T> {
    return this.withFiles(r, r.hostKey, r.name, false, async (files) => {
      try {
        return await fn(files);
      } catch (err) {
        if (err instanceof RemoteRuntimeError) throw err;
        if (err instanceof SshCommandError) return this.refused(r, err.result, err.what);
        throw new RemoteRuntimeError(400, err instanceof Error ? err.message : String(err));
      }
    });
  }

  /** ssh の失敗を、人に見せる形にする（鍵が違うなら記録してから） */
  private async refused(r: RemoteRuntime, result: { code: number; stdout: string; stderr: string }, what: string): Promise<never> {
    if (isHostKeyRefusal(result)) {
      // 向こうがいま返す鍵を引く（引けなければ、鍵が違うことだけを言う）
      const now = await scanHostKey(r).catch(() => undefined);
      if (now && now.fingerprint !== r.hostKey.fingerprint) await this.deps.store.recordMismatch(r.name, now);
      throw new RemoteRuntimeError(409, "host 鍵が前と違うので繋ぎませんでした。向こうで指紋を確かめて、覚え直してください", {
        hostKeyMismatch: true,
      });
    }
    throw new RemoteRuntimeError(502, sshFailure(`${what}（${r.user}@${r.host}）`, result).message);
  }

  /** known_hosts・公開鍵のファイルを書き、Vault に鍵の窓口を立ててもらってから繋ぐ */
  private async withFiles<T>(
    target: RemoteRuntimeInput,
    hostKey: HostKey,
    dirName: string,
    temporary: boolean,
    fn: (files: SshFiles) => Promise<T>,
  ): Promise<T> {
    const dir = join(this.deps.dataDir, "remote-runtimes", dirName);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const knownHostsFile = join(dir, "known_hosts");
      writeFileSync(knownHostsFile, knownHostsLine(hostKey), { mode: 0o600 });
      let publicKey: string;
      let agentSocket: string;
      try {
        publicKey = (await this.deps.publicKeyOf(target.identity)).trim();
        // 窓口はデータの置き場の短いパスに（Unix ソケットは 107 バイトまで。収まらなければ短い場所——socket-dir.ts）
        const socketDir = coreSocketDir(this.deps.dataDir);
        agentSocket = await this.deps.startSshAgent(target.identity, socketDir);
      } catch (err) {
        throw new RemoteRuntimeError(
          502,
          `SSH 鍵「${target.identity}」を Vault から使えませんでした：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const publicKeyFile = join(dir, "id.pub");
      writeFileSync(publicKeyFile, `${publicKey}\n`, { mode: 0o600 });
      return await fn({ knownHostsFile, agentSocket, publicKeyFile });
    } finally {
      if (temporary) rmSync(dir, { recursive: true, force: true });
    }
  }
}

export { HOST_CONTAINER_RUNTIME };
