// docs/specs/v4-modules.md §4.2 Service。登録（マスター）の形と、AI の引数の検査。

import { isAbsolute, relative, resolve } from "node:path";

/** 名前：unit 名にそのまま使うので、systemd のエスケープが要らない文字だけ（§4.2「実装で守る細部」） */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** host が Module に渡す変数の接頭辞。定義に写さない（§2.3・v4-security.md §3） */
export const HOST_ENV_PREFIX = "BANTO_";

/** 環境変数名として受け付ける形（POSIX の名前） */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Desired = "running" | "stopped";

/** 登録の中身。**秘密の値は持たない**——envSecrets は alias 名だけ（§4.2「Fable のレビューを受けて決めたこと」） */
export interface ServiceDefinition {
  command: string;
  /** Project の根からの相対パス（正規化済み。根そのものは ""） */
  cwd: string;
  /** 昇順・重複なし */
  ports: number[];
  /** 環境変数名 → alias 名 */
  envSecrets: Record<string, string>;
}

export interface ServiceRecord extends ServiceDefinition {
  desired: Desired;
  createdAt: string;
}

export class ServiceError extends Error {
  override name = "ServiceError";
}

export function assertName(name: unknown): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new ServiceError(
      `name は英小文字・数字・ハイフンで、先頭は英小文字か数字、63文字まで（例 "web"、"api-dev"）: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * AI の引数を、比べられる形に揃える（§4.2「まったく同じの比較は正規化してから」）。
 * 根の外を指す cwd・BANTO_* の envSecrets・範囲外のポートは断る——黙って直さない（規則2）
 */
export function normalizeDefinition(
  input: { command?: unknown; cwd?: unknown; ports?: unknown; envSecrets?: unknown },
  projectRoot: string,
): ServiceDefinition {
  if (typeof input.command !== "string" || input.command.trim() === "") {
    throw new ServiceError("command（/bin/sh -c に渡す文字列）が要ります");
  }
  const command = input.command.trim();

  let cwd = "";
  if (input.cwd !== undefined && input.cwd !== null && input.cwd !== "") {
    if (typeof input.cwd !== "string") throw new ServiceError("cwd は Project の根からの相対パス（文字列）");
    const abs = resolve(projectRoot, input.cwd);
    const rel = relative(projectRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new ServiceError(`cwd が Project の根の外を指しています: ${input.cwd}`);
    cwd = rel;
  }

  let ports: number[] = [];
  if (input.ports !== undefined && input.ports !== null) {
    if (!Array.isArray(input.ports)) throw new ServiceError("ports は数字の配列（例 [3000]）");
    for (const p of input.ports) {
      if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
        throw new ServiceError(`ports の値は 1〜65535 の整数: ${JSON.stringify(p)}`);
      }
    }
    ports = [...new Set(input.ports as number[])].sort((a, b) => a - b);
  }

  const envSecrets: Record<string, string> = {};
  if (input.envSecrets !== undefined && input.envSecrets !== null) {
    if (typeof input.envSecrets !== "object" || Array.isArray(input.envSecrets)) {
      throw new ServiceError('envSecrets は {環境変数名: alias 名}（例 {"OPENAI_API_KEY": "openai"}）');
    }
    for (const name of Object.keys(input.envSecrets as object).sort()) {
      const alias = (input.envSecrets as Record<string, unknown>)[name];
      if (name.startsWith(HOST_ENV_PREFIX)) throw new ServiceError(`envSecrets に ${HOST_ENV_PREFIX} で始まる名前は使えません: ${name}`);
      if (!ENV_NAME_PATTERN.test(name)) throw new ServiceError(`envSecrets の環境変数名が不正です: ${name}`);
      if (typeof alias !== "string" || alias === "") throw new ServiceError(`envSecrets の ${name} には alias 名（文字列）を書く`);
      envSecrets[name] = alias;
    }
  }
  return { command, cwd, ports, envSecrets };
}

export function sameDefinition(a: ServiceDefinition, b: ServiceDefinition): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(d: ServiceDefinition): unknown {
  return {
    command: d.command,
    cwd: d.cwd,
    ports: [...d.ports],
    envSecrets: Object.keys(d.envSecrets)
      .sort()
      .map((k) => [k, d.envSecrets[k]]),
  };
}

export function definitionOf(r: ServiceRecord): ServiceDefinition {
  return { command: r.command, cwd: r.cwd, ports: r.ports, envSecrets: r.envSecrets };
}
