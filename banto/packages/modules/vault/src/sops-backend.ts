// banto組み込みのデフォルトVaultバックエンド。実装はSOPS + age
// （決定・2026-09-02、docs/specs/v4-architecture.md §2.8）。
// SOPS自身の復号鍵（ageのローカル鍵ファイル）はbantoがファイルとして直接持つ——
// これはalias解決の対象ではない、唯一、本当に特別な1点。

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm, unlink, chmod } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { VaultBackend } from "./backend.js";

const execFileP = promisify(execFile);

export class SopsBackend implements VaultBackend {
  private readonly identityPath: string;
  private readonly groupsDir: string;
  private publicKeyCache?: string;

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
    return { group: path.slice(0, idx), key: path.slice(idx + 1) };
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

  private async writeGroupSecrets(group: string, secrets: Record<string, string>): Promise<void> {
    const groupDir = join(this.groupsDir, group);
    await mkdir(groupDir, { recursive: true, mode: 0o700 });
    const file = this.secretsFile(group);
    const plainTmp = join(groupDir, `.plain-${Date.now()}.json`);
    await writeFile(plainTmp, JSON.stringify(secrets), { mode: 0o600 });
    try {
      const pubKey = await this.publicKey();
      await execFileP("sops", [
        "--encrypt",
        "--age",
        pubKey,
        "--output",
        file,
        plainTmp,
      ]);
    } finally {
      // 平文の一時ファイルは必ず消す（規則2、Shellのsecret Filesと同じ原則）。
      await unlink(plainTmp).catch(() => undefined);
    }
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
    const secrets = await this.readGroupSecrets(group);
    secrets[key] = Buffer.isBuffer(value) ? value.toString("base64") : value;
    await this.writeGroupSecrets(group, secrets);
  }

  async deleteSecret(path: string): Promise<void> {
    const { group, key } = this.splitPath(path);
    const secrets = await this.readGroupSecrets(group);
    delete secrets[key];
    await this.writeGroupSecrets(group, secrets);
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
    await mkdir(join(this.groupsDir, name), { recursive: true, mode: 0o700 });
  }

  async generateKeypair(kind: "ssh"): Promise<{ publicKey: string; privateKeyRef: string }> {
    if (kind !== "ssh") throw new Error(`unsupported keypair kind: ${kind}`);
    const tmpDir = join(tmpdir(), `banto-vault-keygen-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const keyPath = join(tmpDir, "id_ed25519");
    try {
      await execFileP("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-q"]);
      const privateKey = await readFile(keyPath, "utf8");
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();

      const group = "ssh-identities";
      await this.createGroup(group);
      const ref = `${group}/${publicKey.split(" ")[1]?.slice(0, 16) ?? Date.now()}`;
      await this.putSecret(ref, privateKey);
      return { publicKey, privateKeyRef: ref };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  async loadIntoAgent(privateKeyRef: string): Promise<{ socketPath: string }> {
    const privateKey = await this.getSecret(privateKeyRef);
    const socketPath = join(tmpdir(), `banto-ssh-agent-${Date.now()}.sock`);

    await new Promise<void>((resolve, reject) => {
      // execFileのコールバック方式はstdio pipeへの参照が残り、プロセスの
      // 自然な終了を妨げることがある（実測で発見）。spawn+stdio:'ignore'+
      // detachedで、fire-and-forgetなデーモンとして起動する。
      const proc = spawn("ssh-agent", ["-a", socketPath, "-D"], {
        stdio: "ignore",
        detached: true,
      });
      proc.on("error", reject);
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

    return { socketPath };
  }
}
