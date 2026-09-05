// docs/specs/v4-modules.md §2.3 Shell の実装。alias方式（アーキ仕様§2.5）——
// 値はcommand文字列にもargvにも書かず、子プロセスのenvテーブルに直接注入する。

import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HostRelayClient } from "./host-relay-client.js";

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
  vaultModuleName?: string;
  onProgress?(note: string): void;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_SEC = 120;

export async function runCommand(input: RunCommandInput, deps: RunCommandDeps): Promise<RunCommandResult> {
  const vaultModule = deps.vaultModuleName ?? "vault";
  const env: NodeJS.ProcessEnv = { ...process.env };
  const writtenSecretFiles: string[] = [];

  try {
    for (const [envName, alias] of Object.entries(input.envSecrets ?? {})) {
      env[envName] = await deps.relayClient.resolveAlias(vaultModule, alias);
      deps.onProgress?.(`envSecrets: ${envName} を解決しました`);
    }

    if (input.sshIdentity) {
      const { socketPath } = await deps.relayClient.startSshAgent(vaultModule, input.sshIdentity);
      env.SSH_AUTH_SOCK = socketPath;
      deps.onProgress?.(`sshIdentity: ${input.sshIdentity} をssh-agentに読み込みました`);
    }

    for (const [relPath, alias] of Object.entries(input.secretFiles ?? {})) {
      const value = await deps.relayClient.resolveAlias(vaultModule, alias);
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

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      input.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        input.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("exit", (code, signal) => {
        input.signal?.removeEventListener("abort", onAbort);
        if (signal === "SIGTERM" && code === null) timedOut = true;
        resolvePromise({ stdout, stderr, exitCode: code, timedOut });
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
