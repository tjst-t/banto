// banto組み込みのデフォルトVaultバックエンド。実装はSOPS + age
// （決定・2026-09-02、docs/specs/v4-architecture.md §2.8）。
// SOPS自身の復号鍵（ageのローカル鍵ファイル）はbantoがファイルとして直接持つ——
// これはalias解決の対象ではない、唯一、本当に特別な1点。

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm, rename, chmod } from "node:fs/promises";
import { createWriteStream, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VaultBackend } from "@banto/vault-kit";

const execFileP = promisify(execFile);

/**
 * グループ名として許す形（決定・2026-09-10、`vault-os-surface-hardening`）。
 *
 * グループ名はそのままディレクトリ名になる。`..` や `/` を通すと、Vault の
 * データ置き場の**外**に書ける——**Vault は Landlock の対象外**（鍵を持つので
 * 閉じ込めの外に置いてある）ので、OS 側で止まってくれる保証も無い。
 * 素直な名前だけを通す（規則2——「たぶん大丈夫」で通さない）。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeGroup(name: string): void {
  if (!SAFE_SEGMENT.test(name) || name === "." || name === "..") {
    throw new Error(
      `vault のグループ名に使えるのは英数字と . _ - だけです（先頭は英数字）: ${JSON.stringify(name)}`,
    );
  }
}

/**
 * **平文を名前付きパイプ越しに渡して** sops に暗号化させ、暗号文を受け取る。
 *
 * なぜ FIFO か（実測・2026-09-10）：sops は「ファイル」を要求し、標準入力を
 * そのまま読む口が無い（`no file specified`）。`/dev/stdin` を渡す手は、
 * Node の `spawn` が作る stdin が**パイプではなくソケット対**なので
 * `ENXIO`（no such device or address）になる——シェルからは通るのに Node からは
 * 通らない、という形で確かめた。名前付きパイプなら **中身はディスクに残らない**
 * （FIFO は入れ物を持たない）——平文の一時ファイルを置かずに済む唯一の素直な道。
 */
async function encryptViaFifo(args: string[], plaintext: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "banto-vault-enc-"));
  await chmod(dir, 0o700);
  const fifo = join(dir, "plain.json");
  try {
    await execFileP("mkfifo", ["-m", "600", fifo]);
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn("sops", [...args, fifo], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      proc.on("error", fail);
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve(stdout);
        else reject(new Error(`sops が失敗しました (exit ${code}): ${stderr.trim()}`));
      });
      // sops が読み口を開くまで、この open は待つ（だから spawn の後に開く）
      const writer = createWriteStream(fifo);
      writer.on("error", fail);
      writer.end(plaintext);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class SopsBackend implements VaultBackend {
  private readonly identityPath: string;
  private readonly groupsDir: string;
  private publicKeyCache?: string;
  /** グループごとの書き込みを直列化する（読んで足して書く、の取りこぼしを防ぐ）。 */
  private readonly groupWrites = new Map<string, Promise<void>>();
  /** 立てた ssh-agent（鍵の参照 → プロセス）。**同じ鍵で増やさない**。 */
  private readonly agents = new Map<string, { socketPath: string; pid: number }>();
  private agentCleanupRegistered = false;

  constructor(private readonly dataDir: string) {
    this.identityPath = join(dataDir, "identity.txt");
    this.groupsDir = join(dataDir, "groups");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(this.groupsDir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.identityPath)) {
      await execFileP("age-keygen", ["-o", this.identityPath]);
      await chmod(this.identityPath, 0o600);
    }
  }

  private async publicKey(): Promise<string> {
    if (this.publicKeyCache) return this.publicKeyCache;
    const { stdout } = await execFileP("age-keygen", ["-y", this.identityPath]);
    this.publicKeyCache = stdout.trim();
    return this.publicKeyCache;
  }

  private splitPath(path: string): { group: string; key: string } {
    const idx = path.indexOf("/");
    if (idx === -1) throw new Error(`vault path must be "group/key", got "${path}"`);
    const group = path.slice(0, idx);
    // **グループはディレクトリになる**——`../` を通さない（上の SAFE_SEGMENT）。
    // key は JSON の中のキーなので、パスにはならない
    assertSafeGroup(group);
    return { group, key: path.slice(idx + 1) };
  }

  private secretsFile(group: string): string {
    return join(this.groupsDir, group, "secrets.sops.json");
  }

  private async readGroupSecrets(group: string): Promise<Record<string, string>> {
    const file = this.secretsFile(group);
    if (!existsSync(file)) return {};
    const { stdout } = await execFileP("sops", ["--decrypt", file], {
      env: { ...process.env, SOPS_AGE_KEY_FILE: this.identityPath },
    });
    return JSON.parse(stdout) as Record<string, string>;
  }

  /**
   * **平文をディスクに置かない**（改訂・2026-09-10）。以前は暗号化のたびに
   * 平文の一時ファイルを書き、`finally` で消していた——**消す前に落ちれば
   * 平文が残る**（しかも Vault のデータ置き場の中に）。sops に標準入力で渡し、
   * 出来上がった暗号文だけをディスクに置く。書き出しは tmp → rename で原子的に。
   */
  private async writeGroupSecrets(group: string, secrets: Record<string, string>): Promise<void> {
    const groupDir = join(this.groupsDir, group);
    await mkdir(groupDir, { recursive: true, mode: 0o700 });
    const file = this.secretsFile(group);
    const pubKey = await this.publicKey();
    const encrypted = await encryptViaFifo(
      ["--encrypt", "--input-type", "json", "--output-type", "json", "--age", pubKey],
      JSON.stringify(secrets),
    );
    const tmp = `${file}.tmp`;
    await writeFile(tmp, encrypted, { mode: 0o600 });
    await rename(tmp, file);
  }

  /**
   * 同じグループへの「読んで・足して・書く」を1本に並べる（追加・2026-09-10）。
   * 並行して2本走ると、**後から書いたほうが前の追加を消す**（更新の取りこぼし）。
   */
  private withGroupLock<T>(group: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.groupWrites.get(group) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    // 鎖自体は必ず解決させる（失敗は呼び出し元にだけ伝える）
    this.groupWrites.set(
      group,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async getSecret(path: string): Promise<string> {
    const { group, key } = this.splitPath(path);
    const secrets = await this.readGroupSecrets(group);
    const value = secrets[key];
    if (value === undefined) throw new Error(`vault secret not found: ${path}`);
    return value;
  }

  async putSecret(path: string, value: string | Buffer): Promise<void> {
    const { group, key } = this.splitPath(path);
    await this.withGroupLock(group, async () => {
      const secrets = await this.readGroupSecrets(group);
      secrets[key] = Buffer.isBuffer(value) ? value.toString("base64") : value;
      await this.writeGroupSecrets(group, secrets);
    });
  }

  async deleteSecret(path: string): Promise<void> {
    const { group, key } = this.splitPath(path);
    await this.withGroupLock(group, async () => {
      const secrets = await this.readGroupSecrets(group);
      delete secrets[key];
      await this.writeGroupSecrets(group, secrets);
    });
  }

  async listPaths(prefix?: string): Promise<string[]> {
    const groups = await this.listGroups();
    const out: string[] = [];
    for (const group of groups) {
      if (prefix && !group.startsWith(prefix.split("/")[0]!)) continue;
      const secrets = await this.readGroupSecrets(group);
      for (const key of Object.keys(secrets)) out.push(`${group}/${key}`);
    }
    return prefix ? out.filter((p) => p.startsWith(prefix)) : out;
  }

  async listGroups(): Promise<string[]> {
    if (!existsSync(this.groupsDir)) return [];
    return readdirSync(this.groupsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  async createGroup(name: string): Promise<void> {
    assertSafeGroup(name);
    await mkdir(join(this.groupsDir, name), { recursive: true, mode: 0o700 });
  }

  async generateKeypair(kind: "ssh", path: string): Promise<{ publicKey: string; privateKeyRef: string }> {
    if (kind !== "ssh") throw new Error(`unsupported keypair kind: ${kind}`);
    const tmpDir = join(tmpdir(), `banto-vault-keygen-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const keyPath = join(tmpDir, "id_ed25519");
    try {
      await execFileP("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"]);
      const privateKey = await readFile(keyPath, "utf8");
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();

      // **置き場は呼び出し側が決める**（改訂・2026-09-13）。以前は
      // `ssh-identities` 決め打ちで、鍵だけがどのグループにも紐付かなかった
      await this.createGroup(path.slice(0, path.indexOf("/")));
      await this.putSecret(path, privateKey);
      return { publicKey, privateKeyRef: path };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async publicKeyOf(privateKeyRef: string): Promise<string> {
    const privateKey = await this.getSecret(privateKeyRef);
    // **平文の鍵は 0700 の一時ディレクトリにだけ置き、finally で消す**
    // （`loadIntoAgent` と同じ形——同じ危険には同じ手当て）
    const tmpDir = await mkdtemp(join(tmpdir(), "banto-pubkey-"));
    const keyFile = join(tmpDir, "key");
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 });
      const { stdout } = await execFileP("ssh-keygen", ["-y", "-f", keyFile]);
      return stdout.trim();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * その鍵を持った ssh-agent の socket を返す。
   *
   * **同じ鍵で agent を増やさない**（改訂・2026-09-10）。以前は呼ばれるたびに
   * 新しい ssh-agent を detached で立て、**誰も止めないまま鍵を抱えて残り続けて**
   * いた（`git push` のたびに1つ増える）。生きている agent があれば使い回し、
   * Vault が終わるときは立てた agent を落とす——**鍵を持つプロセスを、
   * Vault より長生きさせない**。
   */
  async loadIntoAgent(privateKeyRef: string): Promise<{ socketPath: string }> {
    const running = this.agents.get(privateKeyRef);
    if (running && this.isAlive(running.pid) && existsSync(running.socketPath)) {
      return { socketPath: running.socketPath };
    }
    if (running) this.agents.delete(privateKeyRef); // 死んでいた——立て直す

    const privateKey = await this.getSecret(privateKeyRef);
    const socketPath = join(tmpdir(), `banto-ssh-agent-${Date.now()}.sock`);
    let agentPid = 0;

    await new Promise<void>((resolve, reject) => {
      // execFileのコールバック方式はstdio pipeへの参照が残り、プロセスの
      // 自然な終了を妨げることがある（実測で発見）。spawn+stdio:'ignore'+
      // detachedで、fire-and-forgetなデーモンとして起動する。
      const proc = spawn("ssh-agent", ["-a", socketPath, "-D"], {
        stdio: "ignore",
        detached: true,
      });
      proc.on("error", reject);
      agentPid = proc.pid ?? 0;
      proc.unref();
      // ソケットファイルができるまで少し待つ。
      const start = Date.now();
      const check = () => {
        if (existsSync(socketPath)) return resolve();
        if (Date.now() - start > 5000) return reject(new Error("ssh-agent did not create its socket in time"));
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });

    const tmpDir = join(tmpdir(), `banto-vault-addkey-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const keyFile = join(tmpDir, "key");
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 });
      await execFileP("ssh-add", [keyFile], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    this.agents.set(privateKeyRef, { socketPath, pid: agentPid });
    this.registerAgentCleanup();
    return { socketPath };
  }

  private isAlive(pid: number): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** **鍵を持ったプロセスを置き去りにしない**——Vault が終わるときに落とす。 */
  private registerAgentCleanup(): void {
    if (this.agentCleanupRegistered) return;
    this.agentCleanupRegistered = true;
    const stopAll = () => {
      for (const { pid, socketPath } of this.agents.values()) {
        try {
          if (pid) process.kill(pid, "SIGTERM");
        } catch {
          // もう居ない
        }
        try {
          if (existsSync(socketPath)) rmSync(socketPath, { force: true });
        } catch {
          // 消せなくても終了は続ける
        }
      }
      this.agents.clear();
    };
    process.once("exit", stopAll);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        stopAll();
        process.exit(0);
      });
    }
  }

  /** 立てた ssh-agent を落とす（試験と、Vault を畳むときのため）。 */
  async stopAgents(): Promise<void> {
    for (const { pid, socketPath } of this.agents.values()) {
      try {
        if (pid) process.kill(pid, "SIGTERM");
      } catch {
        // もう居ない
      }
      if (existsSync(socketPath)) rmSync(socketPath, { force: true });
    }
    this.agents.clear();
  }
}
