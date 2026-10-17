// **エージェントの本体の目録**（決定・2026-10-17、ユーザー。アーキ仕様 §4.1「エージェントの本体を取ってくる」）。
//
// OpenCode の実行ファイルは1本で約185MB あり、依存に持つと組み立て済みの版・別のサーバへ送る依存のほとんどを占めていた。
// 依存から外し、**AI か人が初めて使うときに banto 本体（core）が1回だけ取ってくる**。何を取ってくるかはここに固定する
// ——エージェントごと・CPU の種類ごとに、版・npm の tarball の URL・integrity（sha512）・tarball の中の実行ファイルのパス・
// 大きさの上限。**版を上げるときは版と integrity を書き換え、`check:agents`（opencode）を流す**

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** CPU の種類。x64 の glibc だけ（banto がそれだけなので）。baseline は AVX2 の無い機械用 */
export type AgentBinaryCpu = "x64" | "x64-baseline";

export interface AgentBinary {
  /** Subagent Module のエージェントの id（`opencode`） */
  agent: string;
  /** 人に出す名前（進み具合の文に使う） */
  title: string;
  version: string;
  cpu: AgentBinaryCpu;
  /** npm の tarball */
  url: string;
  /** npm の integrity（`sha512-<base64>`）。tarball をこれと比べてから開く */
  integrity: string;
  /** tarball の中の実行ファイルのパス。**これと完全に一致する通常のファイル1件だけ**を取り出す */
  path: string;
  /** 実行ファイルの大きさの上限（バイト）。超えたら断る。tarball の大きさもこれで切る */
  maxBytes: number;
  /** 人に出すおおよその大きさ（「約185MB を取ってきます」） */
  approxBytes: number;
}

const OPENCODE_VERSION = "1.18.32";
const MB = 1_000_000;

export const AGENT_BINARIES: readonly AgentBinary[] = [
  {
    agent: "opencode",
    title: "OpenCode",
    version: OPENCODE_VERSION,
    cpu: "x64",
    url: `https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${OPENCODE_VERSION}.tgz`,
    integrity: "sha512-CIatvoyi8V5a56xyw6ZUnsKxB9wqYIZqfNeqUNWhBBY4aENAm907LP0xXAwL6tR0cYbqNl2+Dvx8mOqXIxbDeQ==",
    path: "package/bin/opencode",
    maxBytes: 300 * MB,
    approxBytes: 185 * MB,
  },
  {
    agent: "opencode",
    title: "OpenCode",
    version: OPENCODE_VERSION,
    cpu: "x64-baseline",
    url: `https://registry.npmjs.org/opencode-linux-x64-baseline/-/opencode-linux-x64-baseline-${OPENCODE_VERSION}.tgz`,
    integrity: "sha512-XXO4htNdJEoj935NGMYNGjD1M8ZiJPo2u2cQzIyeBjinoClI7iXOHBPw+Twm/ZuzFHKtmI2594bt0GWIwTetkw==",
    path: "package/bin/opencode",
    maxBytes: 300 * MB,
    approxBytes: 185 * MB,
  },
];

/**
 * **試験だけが目録ごと差し替える**（`BANTO_AGENT_BINARY_CATALOG`、JSON の配列）。偽のエージェント
 * （`BANTO_SUBAGENT_FAKE_AGENT=1`）のときだけ読む——本番では効かない。core の環境なのでコンテナの AI からは触れない。
 * 壊れていれば起きずに止まる（黙って本物の目録へ落とさない、規則2）
 */
export function catalogFromEnv(env: NodeJS.ProcessEnv = process.env): readonly AgentBinary[] {
  const raw = env.BANTO_AGENT_BINARY_CATALOG;
  if (env.BANTO_SUBAGENT_FAKE_AGENT !== "1" || raw === undefined) return AGENT_BINARIES;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("BANTO_AGENT_BINARY_CATALOG は配列の JSON にしてください");
  return parsed.map((e, i) => {
    const x = e as Partial<AgentBinary>;
    for (const key of ["agent", "title", "version", "cpu", "url", "integrity", "path"] as const) {
      if (typeof x[key] !== "string" || x[key] === "") throw new Error(`BANTO_AGENT_BINARY_CATALOG[${i}] に ${key} がありません`);
    }
    if (typeof x.maxBytes !== "number" || typeof x.approxBytes !== "number") {
      throw new Error(`BANTO_AGENT_BINARY_CATALOG[${i}] に maxBytes・approxBytes がありません`);
    }
    return x as AgentBinary;
  });
}

/** **動かす機械の CPU で選ぶ**：AVX2 があれば x64、無ければ baseline。目録に無いエージェントは undefined */
export function selectAgentBinary(catalog: readonly AgentBinary[], agent: string, avx2: boolean): AgentBinary | undefined {
  const want: AgentBinaryCpu = avx2 ? "x64" : "x64-baseline";
  return catalog.find((e) => e.agent === agent && e.cpu === want);
}

/**
 * 置き場のフォルダの名前：`<agent>-<版>-<CPU の種類>-<integrity の頭12>`（integrity は16進にした頭——base64 の `/`・`+` を
 * 名前に入れない）。中身が変われば名前も変わる
 */
export function agentBinaryDirName(e: AgentBinary): string {
  const digest = Buffer.from(e.integrity.replace(/^sha512-/, ""), "base64").toString("hex").slice(0, 12);
  return `${e.agent}-${e.version}-${e.cpu}-${digest}`;
}

/** 置き場のフォルダの中の実行ファイルの名前（tarball の中のパスの最後） */
export function agentBinaryFileName(e: AgentBinary): string {
  return e.path.split("/").at(-1)!;
}

/** sha512 の integrity（npm の形） */
export function integrityOf(sha512: ReturnType<typeof createHash>): string {
  return `sha512-${sha512.digest("base64")}`;
}

/** この機械の CPU が AVX2 を持つか（host の `/proc/cpuinfo`。読めなければ持たないとする——baseline はどこでも動く） */
export function hostHasAvx2(cpuinfo: () => string = () => readFileSync("/proc/cpuinfo", "utf8")): boolean {
  try {
    return /\bavx2\b/.test(cpuinfo());
  } catch {
    return false;
  }
}
