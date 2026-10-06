// `VaultBackend`（仕様 §2.1 D節）の Infisical 実装。
//
// **対応づけ**——仕様が最初から想定していたとおり、Infisical の **Folder** が
// 「グループ」にあたる（§2.1「Project ↔ backend グループの紐付け」で
// 「Infisical の Folder」と名指しされている）：
//
//   グループ              → Folder（`/g1`）
//   path `"g1/key"`       → Folder `/g1` の中の秘密 `key`
//   path `"g1/sub/key"`   → Folder `/g1/sub` の中の秘密 `key`（サブフォルダ、2026-10-06。対応は place.ts）
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
import { agentSocketPath, type VariantAxis, type VariantCount, type VaultBackend } from "@banto/vault-kit";
import type { InfisicalConnection } from "./client.js";
import { backendPathOf, ensureFolders, isAlreadyExists, parseGroupId, placeOf } from "./place.js";

const execFileP = promisify(execFile);

export class InfisicalBackend implements VaultBackend {
  /** 立てた ssh-agent（鍵の参照 → プロセス）。**同じ鍵で増やさない**。 */
  private readonly agents = new Map<string, { socketPath: string; pid: number }>();
  private agentCleanupRegistered = false;

  constructor(private readonly conn: InfisicalConnection) {}

  async getSecret(path: string): Promise<string> {
    const { folder, key, env } = placeOf(path);
    const got = await this.conn.secrets().getSecret({
      ...this.conn.scopeFor(env),
      secretName: key,
      secretPath: folder,
      // **Infisical に参照（`${環境.フォルダ.キー}`）を展開させない**（2026-10-04、レビュー）。SDK の既定は
      // 展開するので、Project の刻印で呼べる putSecret で自分のグループに `${dev.tools.X}` を置いて
      // 引くと、**見えないグループの値が返っていた**。banto の参照は台帳の linkTo を kit が辿り、
      // 使えるかを参照の置き場で確かめてから元を引く——Infisical の展開はその判定の外を通る
      expandSecretReferences: false,
    });
    if (got.secretValue === undefined) throw new Error(`vault secret not found: ${path}`);
    return got.secretValue;
  }

  async putSecret(path: string, value: string | Buffer): Promise<void> {
    const place = placeOf(path);
    const { folder, key } = place;
    const scope = this.conn.scopeFor(place.env);
    const secretValue = Buffer.isBuffer(value) ? value.toString("base64") : value;
    // **サブフォルダも作る**（`g/sub/key` なら `/g` と `/g/sub`、2026-10-06）
    await ensureFolders(this.conn, place);
    // **既にあれば上書き、無ければ作る。** Infisical は create と update が
    // 別の口なので、ここで1つの意味（「この名前をこの値にする」）にまとめる
    try {
      await this.conn.secrets().createSecret(key, { ...scope, secretPath: folder, secretValue });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      await this.conn.secrets().updateSecret(key, { ...scope, secretPath: folder, secretValue });
    }
  }

  async deleteSecret(path: string): Promise<void> {
    const { folder, key, env } = placeOf(path);
    await this.conn.secrets().deleteSecret(key, { ...this.conn.scopeFor(env), secretPath: folder });
  }

  async listPaths(prefix?: string): Promise<string[]> {
    // **サブフォルダまで1回で**（2026-10-06）。根に直接置いた秘密はグループに属さないので数えない
    const listed = await this.conn.secrets().listSecrets({
      ...this.conn.scope,
      secretPath: "/",
      recursive: true,
      viewSecretValue: false,
      expandSecretReferences: false,
    });
    const out: string[] = [];
    for (const s of listed.secrets ?? []) {
      const path = backendPathOf(s.secretPath ?? "/", s.secretKey);
      if (path !== undefined) out.push(path);
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
    // `g@prod` なら環境 prod に作る（版付きのグループ、2026-10-06）
    const { group, env } = parseGroupId(name);
    await ensureFolders(this.conn, { group, env, subfolders: [] });
  }

  /**
   * **版＝Infisical の環境**（決定・2026-10-06）。選択肢はその Project の環境の一覧、既定は接続設定の環境。
   * 接続設定の環境が一覧に無いときも選択肢に残す（既定を選べないと今の紐付けが表せない）
   */
  /** いまの既定の環境を指す `g@<既定>` は `g` に揃える（kit が紐付けと置き場を比べる前に通す、2026-10-06）。 */
  canonicalGroup(groupId: string): string {
    const { group, env } = parseGroupId(groupId);
    return env === undefined || env === this.conn.scope.environment ? group : groupId;
  }

  async variants(): Promise<VariantAxis> {
    const envs = await this.conn.listEnvironments();
    const def = this.conn.scope.environment;
    return { label: "環境", options: envs.includes(def) ? envs : [def, ...envs], default: def };
  }

  /**
   * 環境ごとに、そのグループ（サブフォルダも含む）の「値が入っている秘密の数／全部の数」。
   * **値は数えたらすぐ捨てる**。その環境にフォルダが無いのは 0／0（失敗ではない）
   */
  async countByVariant(group: string): Promise<VariantCount[]> {
    parseGroupId(group);
    const { options } = await this.variants();
    return Promise.all(
      options.map(async (env) => {
        let secrets: Array<{ secretValue?: string }> = [];
        try {
          const listed = await this.conn.secrets().listSecrets({
            ...this.conn.scopeFor(env),
            secretPath: `/${group}`,
            recursive: true,
            viewSecretValue: true,
            expandSecretReferences: false,
          });
          secrets = listed.secrets ?? [];
        } catch (err) {
          if (!isFolderMissing(err)) throw err;
        }
        const filled = secrets.filter((s) => typeof s.secretValue === "string" && s.secretValue !== "").length;
        return { variant: env, filled, total: secrets.length };
      }),
    );
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

/**
 * 「その環境にフォルダが無い」を見分ける。**それ以外の失敗は通す**（規則2）
 */
export function isFolderMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // **404 だけでは決めない**（2026-10-06、レビュー）——環境が消された・Project が違う、も 404 で返り、
  // それを「空の置き場」にすると紐付けた秘密が黙って0件になる。文言がフォルダの不在を言うときだけ
  return /folder/i.test(message) && /not found|does not exist/i.test(message);
}
