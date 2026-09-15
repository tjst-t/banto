// docs/specs/v4-modules.md §2.3 Shell の実装。alias方式（アーキ仕様§2.5）——
// 値はcommand文字列にもargvにも書かず、子プロセスのenvテーブルに直接注入する。

import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AliasPlace, HostRelayClient } from "./host-relay-client.js";

export interface RunCommandInput {
  command: string;
  cwd?: string;
  timeout?: number;
  envSecrets?: Record<string, string>;
  secretFiles?: Record<string, string>;
  sshIdentity?: string;
  signal?: AbortSignal;
}

export interface RunCommandDeps {
  projectRoot: string;
  relayClient: HostRelayClient;
  /** 名前から在りかを引く窓口（既定 `vault-directory`）。**試験で差し替えるための穴**。 */
  directoryModuleName?: string;
  onProgress?(note: string): void;
  /** 進捗を送る間隔（既定 10 秒）。**試験で短くするための穴**——本番では既定のまま。 */
  progressIntervalMs?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_SEC = 120;

/**
 * 実行中に進捗を送る間隔（docs/specs/v4-modules.md §2.3）。
 *
 * **MCP の呼び出しは既定60秒で切れる**（呼び出し元が待つ側の上限）。`npm install`
 * のように60秒を超えるコマンドは普通にあるので、実行中に `notifications/progress`
 * を定期送出して、呼び出し元のタイムアウトを更新させる——**新しい機構ではなく、
 * MCP が既に持つ仕組みの使い先**（規則12）。10秒は「60秒より十分短く、
 * 通知が煩くならない」ところ。
 */
const PROGRESS_INTERVAL_MS = 10_000;

// hostがModuleに渡す変数の接頭辞。BANTO_HOST_MCP_TOKENは「どのModuleからの
// 呼び出しか」の識別そのものなので（アーキ仕様§2.5「プロセスごとに発行」＝
// プロセスが身元）、AIの書いたコマンドを走らせる子プロセスはこの身元ではない
// ——渡さない（決定・2026-09-10、docs/specs/v4-security.md「中継が縛らないもの」）。
const HOST_ENV_PREFIX = "BANTO_";

/** 親（Moduleプロセス）のenvから、hostが渡した`BANTO_*`を落とした写しを作る。 */
export function buildChildEnv(parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (name.startsWith(HOST_ENV_PREFIX)) continue;
    child[name] = value;
  }
  return child;
}

export async function runCommand(input: RunCommandInput, deps: RunCommandDeps): Promise<RunCommandResult> {
  const directoryModule = deps.directoryModuleName ?? "vault-directory";
  const env = buildChildEnv();

  // **どの Vault にあるかは、名前から引く**（改訂・2026-09-12）。以前は
  // `"vault"` を決め打ちしていたので、2本目の backend（`vault-infisical`）に
  // 預けた秘密には**構造的に届かなかった**。窓口に聞いてから、その backend を
  // 直接呼ぶ——**値は窓口を通らない**（アーキ仕様 §2.5）。
  //
  // 1回の runCommand の中では同じ名前を2度引かない（`envSecrets` と
  // `secretFiles` に同じ alias が出ることがある）。**跨いでは持たない**
  // ——別のホストが預け先を変えたとき、古い在りかを見せることになる（規則3）。
  //
  // **引くのは「在りか」＝(Vault, グループ, 名前) の三つ組**（訂正・2026-09-15）。
  // 以前は実装名だけを覚えて、`resolveAlias` には AI が書いた文字列を渡していた
  // ——**修飾名（`vault-infisical:npm-token`）では backend にその名前が無い**ので、
  // 一覧に出た名前をそのまま書いても使えなかった
  const whereCache = new Map<string, Promise<AliasPlace>>();
  const vaultOf = (alias: string, note: (n: string) => string): Promise<AliasPlace> => {
    let found = whereCache.get(alias);
    if (!found) {
      found = deps.relayClient.lookupAlias(directoryModule, alias, (n) => deps.onProgress?.(note(n)));
      whereCache.set(alias, found);
    }
    return found;
  };
  const writtenSecretFiles: string[] = [];

  // 落とした名前をenvSecretsで復活させられては同じこと。黙って無視すると
  // 「指定したのに入っていない」が見えない失敗になるので、ここで止める（規則2）。
  for (const envName of Object.keys(input.envSecrets ?? {})) {
    if (envName.startsWith(HOST_ENV_PREFIX)) {
      throw new Error(`envSecretsに${HOST_ENV_PREFIX}で始まる名前は使えません: ${envName}`);
    }
  }

  try {
    for (const [envName, alias] of Object.entries(input.envSecrets ?? {})) {
      // 中継の初回は host が人に承認を聞く——待っている間の合図をそのまま
      // 上（AI のターン）へ流し、外側の tool 呼び出しが先に切れないようにする
      const place = await vaultOf(alias, (n) => `envSecrets: ${envName}——${n}`);
      env[envName] = await deps.relayClient.resolveAlias(place, (note) =>
        deps.onProgress?.(`envSecrets: ${envName}——${note}`),
      );
      deps.onProgress?.(`envSecrets: ${envName} を解決しました`);
    }

    if (input.sshIdentity) {
      const place = await vaultOf(input.sshIdentity, (n) => `sshIdentity——${n}`);
      const { socketPath } = await deps.relayClient.startSshAgent(place, (note) =>
        deps.onProgress?.(`sshIdentity——${note}`),
      );
      env.SSH_AUTH_SOCK = socketPath;
      deps.onProgress?.(`sshIdentity: ${input.sshIdentity} をssh-agentに読み込みました`);
    }

    for (const [relPath, alias] of Object.entries(input.secretFiles ?? {})) {
      const place = await vaultOf(alias, (n) => `secretFiles: ${relPath}——${n}`);
      const value = await deps.relayClient.resolveAlias(place, (note) =>
        deps.onProgress?.(`secretFiles: ${relPath}——${note}`),
      );
      const absPath = resolve(deps.projectRoot, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, value, { mode: 0o600 });
      writtenSecretFiles.push(absPath);
      deps.onProgress?.(`secretFiles: ${relPath} を書き出しました`);
    }

    const cwd = input.cwd ? resolve(deps.projectRoot, input.cwd) : deps.projectRoot;
    const timeoutMs = (input.timeout ?? DEFAULT_TIMEOUT_SEC) * 1000;

    return await new Promise<RunCommandResult>((resolvePromise, reject) => {
      const child = spawn("/bin/sh", ["-c", input.command], {
        cwd,
        env,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      // 走っている間、呼び出し元のタイムアウトを更新し続ける（上記）。
      // 経過と出力量も一緒に伝える——人が見たときに「止まっている」と
      // 「時間が掛かっている」を区別できる
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        const sec = Math.round((Date.now() - startedAt) / 1000);
        deps.onProgress?.(`実行中（${sec}秒経過、出力 ${stdout.length + stderr.length} 文字）`);
      }, deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
      // このタイマーだけで Node を生かし続けない
      heartbeat.unref();

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const settle = (fn: () => void) => {
        clearInterval(heartbeat);
        input.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      child.on("error", (err) => {
        settle(() => reject(err));
      });
      child.on("exit", (code, signal) => {
        if (signal === "SIGTERM" && code === null) timedOut = true;
        settle(() => resolvePromise({ stdout, stderr, exitCode: code, timedOut }));
      });
    });
  } finally {
    // 中断・タイムアウト・正常終了いずれでも、secretFilesは必ず削除する
    // （規則2、決定・2026-09-02「既知の限界として受け入れる」節のTODO対応の一部）。
    for (const path of writtenSecretFiles) {
      await unlink(path).catch(() => undefined);
    }
  }
}
