// `VaultBackend`（仕様 §2.1 D節）の Infisical 実装。
//
// **対応づけ**——仕様が最初から想定していたとおり、Infisical の **Folder** が
// 「グループ」にあたる（§2.1「Project ↔ backend グループの紐付け」で
// 「Infisical の Folder」と名指しされている）：
//
//   グループ            → Folder（`/g1`）
//   path `"g1/key"`     → Folder `/g1` の中の秘密 `key`
//
// **SOPS と違うところ**（2本目を書いて分かった、2026-09-12）：
//
//   1. **`createGroup` が冪等でない。** SOPS は `mkdir -p` なので何度でも通るが、
//      Infisical の `folders.create` は既にあると 400 で落ちる。呼び出し側
//      （vault-kit）は alias を作るたびに `createGroup` を呼ぶ設計なので、
//      **ここで飲み込む**——`VaultBackend` の契約は「冪等であること」だと
//      はっきりさせた（仕様にも書いた）
//   2. **秘密鍵を自分では作れない。** Infisical に鍵ペア生成の口は無いので、
//      `ssh-keygen` で作って**秘密鍵を秘密として預ける**。`privateKeyRef` は
//      その置き場を指す不透明な参照——呼び出し側はこれが何かを知らない

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentSocketPath, type VaultBackend } from "@banto/vault-kit";
import type { InfisicalConnection } from "./client.js";

const execFileP = promisify(execFile);

/**
 * グループ名として許す形。**組み込み Vault と同じ規律**（2026-09-10 の
 * `vault-os-surface-hardening`）——Infisical では `/` がフォルダの区切りなので、
 * 通すとフォルダ階層の外を指せる。
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeGroup(name: string): void {
  if (!SAFE_SEGMENT.test(name) || name === "." || name === "..") {
    throw new Error(
      `グループ名に使えるのは英数字と . _ - だけです（先頭は英数字）: ${JSON.stringify(name)}`,
    );
  }
}

/** SSH 鍵を預けるグループ。**人が作った名前と混ざらない**ように分けておく。 */

export class InfisicalBackend implements VaultBackend {
  /** 立てた ssh-agent（鍵の参照 → プロセス）。**同じ鍵で増やさない**。 */
  private readonly agents = new Map<string, { socketPath: string; pid: number }>();
  private agentCleanupRegistered = false;

  constructor(private readonly conn: InfisicalConnection) {}

  private split(path: string): { group: string; key: string } {
    const idx = path.indexOf("/");
    if (idx === -1) throw new Error(`vault path must be "group/key", got "${path}"`);
    const group = path.slice(0, idx);
    assertSafeGroup(group);
    return { group, key: path.slice(idx + 1) };
  }

  async getSecret(path: string): Promise<string> {
    const { group, key } = this.split(path);
    const got = await this.conn.secrets().getSecret({
      ...this.conn.scope,
      secretName: key,
      secretPath: `/${group}`,
    });
    if (got.secretValue === undefined) throw new Error(`vault secret not found: ${path}`);
    return got.secretValue;
  }

  async putSecret(path: string, value: string | Buffer): Promise<void> {
    const { group, key } = this.split(path);
    const secretValue = Buffer.isBuffer(value) ? value.toString("base64") : value;
    await this.createGroup(group);
    // **既にあれば上書き、無ければ作る。** Infisical は create と update が
    // 別の口なので、ここで1つの意味（「この名前をこの値にする」）にまとめる
    try {
      await this.conn.secrets().createSecret(key, { ...this.conn.scope, secretPath: `/${group}`, secretValue });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      await this.conn.secrets().updateSecret(key, { ...this.conn.scope, secretPath: `/${group}`, secretValue });
    }
  }

  async deleteSecret(path: string): Promise<void> {
    const { group, key } = this.split(path);
    await this.conn.secrets().deleteSecret(key, { ...this.conn.scope, secretPath: `/${group}` });
  }

  async listPaths(prefix?: string): Promise<string[]> {
    const out: string[] = [];
    for (const group of await this.listGroups()) {
      const listed = await this.conn.secrets().listSecrets({ ...this.conn.scope, secretPath: `/${group}` });
      for (const s of listed.secrets ?? []) out.push(`${group}/${s.secretKey}`);
    }
    return prefix ? out.filter((p) => p.startsWith(prefix)) : out;
  }

  async listGroups(): Promise<string[]> {
    // `listFolders` は**配列をそのまま返す**（`{folders:[…]}` ではない。型で確認）
    const folders = await this.conn.folders().listFolders({ ...this.conn.scope, path: "/" });
    return folders.map((f) => f.name);
  }

  /**
   * **冪等にする。** 呼び出し側は alias を作るたびに呼ぶので、既にあることは
   * 失敗ではない。Infisical の `folders.create` は 400 を返すので飲み込む
   * ——ただし**「既にある」以外の失敗は通す**（規則2——握りつぶさない）。
   */
  async createGroup(name: string): Promise<void> {
    assertSafeGroup(name);
    try {
      await this.conn.folders().create({ ...this.conn.scope, name, path: "/" });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  /**
   * **Infisical は鍵ペアを作れない**ので、こちらで作って預ける。
   * 返す `privateKeyRef` は置き場を指す不透明な参照——呼び出し側は中身を知らない。
   */
  async generateKeypair(kind: "ssh", path: string): Promise<{ publicKey: string; privateKeyRef: string }> {
    if (kind !== "ssh") throw new Error(`unsupported keypair kind: ${kind}`);
    const dir = join(tmpdir(), `banto-infisical-keygen-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, "id_ed25519");
    try {
      await execFileP("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"]);
      const privateKey = await readFile(keyPath, "utf8");
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
      // **置き場は呼び出し側が決める**（改訂・2026-09-13）。以前は
      // `ssh-identities` 決め打ちで、そこから **alias 名が公開鍵の断片に
      // 化ける**不具合も出ていた（置き場を決める主体が2つあったのが根）
      await this.createGroup(path.slice(0, path.indexOf("/")));
      await this.putSecret(path, privateKey);
      return { publicKey, privateKeyRef: path };
    } finally {
      // **平文の鍵をディスクに残さない**
      await rm(dir, { recursive: true, force: true });
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
   * その鍵を持った ssh-agent の socket を返す。**同じ鍵で増やさない・
   * 置き去りにしない**——組み込み Vault と同じ規律（2026-09-10）。
   */
  async loadIntoAgent(privateKeyRef: string, opts: { socketDir?: string } = {}): Promise<{ socketPath: string }> {
    // **置き場ごとに1つ**——同じ鍵でも、コンテナが違えば見える窓口が要る（追加・2026-09-27）
    const agentKey = opts.socketDir ? `${privateKeyRef}\0${opts.socketDir}` : privateKeyRef;
    const running = this.agents.get(agentKey);
    if (running && isAlive(running.pid) && existsSync(running.socketPath)) {
      return { socketPath: running.socketPath };
    }
    if (running) this.agents.delete(agentKey);

    const privateKey = await this.getSecret(privateKeyRef);
    const socketPath = agentSocketPath(opts.socketDir, `banto-ssh-agent-${process.pid}-${Date.now()}.sock`);
    let agentPid = 0;

    await new Promise<void>((resolve, reject) => {
      const proc = spawn("ssh-agent", ["-a", socketPath, "-D"], { stdio: "ignore", detached: true });
      proc.on("error", reject);
      agentPid = proc.pid ?? 0;
      proc.unref();
      const start = Date.now();
      const check = () => {
        if (existsSync(socketPath)) return resolve();
        if (Date.now() - start > 5000) return reject(new Error("ssh-agent did not create its socket in time"));
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });

    const dir = join(tmpdir(), `banto-infisical-addkey-${process.pid}-${Date.now()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const keyFile = join(dir, "key");
    try {
      await writeFile(keyFile, privateKey, { mode: 0o600 });
      await execFileP("ssh-add", [keyFile], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    this.agents.set(agentKey, { socketPath, pid: agentPid });
    this.registerAgentCleanup();
    return { socketPath };
  }

  private registerAgentCleanup(): void {
    if (this.agentCleanupRegistered) return;
    this.agentCleanupRegistered = true;
    const stopAll = () => this.stopAgentsSync();
    process.once("exit", stopAll);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        stopAll();
        process.exit(0);
      });
    }
  }

  private stopAgentsSync(): void {
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
  }

  /** 立てた ssh-agent を落とす（試験と、Module を畳むときのため）。 */
  async stopAgents(): Promise<void> {
    this.stopAgentsSync();
  }
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Infisical の「もうある」を見分ける。**文言に頼るのは弱い**ので、状態符号も見る。 */
function isAlreadyExists(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exist/i.test(message) || /StatusCode=409/.test(message);
}
