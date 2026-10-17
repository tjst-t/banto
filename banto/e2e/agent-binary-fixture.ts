// **エージェントの本体の偽の登録簿**（追加・2026-10-17、アーキ仕様 §4.1「試験」）。本物の OpenCode（約185MB）は取らない
// ——偽のエージェント `fake` の本体として、受けた引数をそのまま exec する sh を小さな tarball にして出す。core は
// `BANTO_AGENT_BINARY_CATALOG`（偽のエージェントのときだけ読む）でこの登録簿を指す目録を受け、本物の opencode と同じ道
// （取る・sha512 で確かめる・1件だけ取り出す・置く・コンテナに見せる・別のサーバへ送る）を通る
import { readFileSync, writeFileSync } from "node:fs";
import { AGENT_BINARY_CATALOG_FILE } from "./config.ts";
import { integrityOfBytes, startFakeRegistry, tgzOf } from "../packages/core/dist/agent-binaries/fake-registry.js";
import type { AgentBinary } from "../packages/core/dist/agent-binaries/agent-binaries.js";

/** 偽の本体の中身（spec が、置かれたものと突き合わせる） */
export const FAKE_AGENT_BINARY_SCRIPT = '#!/bin/sh\n# banto E2E の偽のエージェントの本体\nexec "$@"\n';
export const FAKE_AGENT_BINARY_PATH = "/fake.tgz";

export async function startAgentBinaryFixture(): Promise<{ catalog: AgentBinary[]; hitsUrl: string }> {
  const tgz = tgzOf([
    { name: "package/package.json", body: '{"name":"banto-e2e-fake-agent","version":"0.0.1"}' },
    { name: "package/bin", type: "dir" },
    { name: "package/bin/fake", body: FAKE_AGENT_BINARY_SCRIPT, mode: 0o755 },
  ]);
  const registry = await startFakeRegistry({ [FAKE_AGENT_BINARY_PATH]: { body: tgz } });
  registry.server.unref();
  const base = { agent: "fake", title: "Fake Agent", version: "0.0.1", url: registry.url(FAKE_AGENT_BINARY_PATH), integrity: integrityOfBytes(tgz) };
  // CPU の種類は2つとも同じ中身（host の AVX2 の有無に依らず通る）
  const catalog: AgentBinary[] = (["x64", "x64-baseline"] as const).map((cpu) => ({
    ...base,
    cpu,
    path: "package/bin/fake",
    maxBytes: 1_000_000,
    approxBytes: 1_000,
  }));
  writeFileSync(AGENT_BINARY_CATALOG_FILE, JSON.stringify({ catalog, hitsUrl: registry.url("/__hits") }));
  return { catalog, hitsUrl: registry.url("/__hits") };
}

/** この回の core が立てた登録簿の目録（自前の host に渡す・spec が読む） */
export function agentBinaryFixture(): { catalog: AgentBinary[]; hitsUrl: string } {
  return JSON.parse(readFileSync(AGENT_BINARY_CATALOG_FILE, "utf8")) as { catalog: AgentBinary[]; hitsUrl: string };
}
