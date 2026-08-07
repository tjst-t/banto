/**
 * Kobo のモジュール定義（ADR-0010 決定25・27b、task-0048／0064）。
 *
 * **Kobo は独立プロセス**（PO裁定 2026-07-28）。だから他のモジュールと違い、番頭ホストに
 * 載るのは実装ではなく**到達先**で、Tool は `{baseUrl}/tools/{名前}` を叩く写しになる。
 * 契約（名前・説明・引数）は Kobo 側の定義から**そのまま持ってくる**——2箇所で書くと、
 * 番頭が読む説明と実際の振る舞いが静かにずれる。
 *
 * このファイルは banto-host に依存しない（Worker Pool の `module.ts` と同じ理由）。
 * 構造的に一致する平たいオブジェクトを返す。
 */

import { Type } from "typebox";
import { createModuleClient, defineNamespacedTool } from "@banto/core";
import type { ModuleClient, NamespacedToolDefinition } from "@banto/core";
import { KOBO_MODULE_PATH } from "./http-server.js";
import type { Daemon } from "./daemon.js";
import { createKoboTools } from "./kobo-tools.js";

/** モジュール名（Tool 名前空間のドメインでもある）。 */
export const KOBO_MODULE_NAME = "kobo";

/** 既定の到達先。独立プロセスなので絶対URL。 */
export function defaultKoboUrl(): string {
  return (
    process.env["BANTO_KOBO_URL"] ??
    `http://127.0.0.1:${process.env["BANTO_KOBO_PORT"] ?? "3000"}${KOBO_MODULE_PATH}`
  );
}

/** SKILL の置き場所（`packages/banto-daemon/skills`）。 */
export function koboSkillsDir(): string {
  return new URL("../skills", import.meta.url).pathname;
}

/**
 * 契約（名前・説明・引数）だけを取り出すための、実装を持たない Kobo。
 *
 * **触られたら投げる**——写しの `execute` は必ず差し替わるので、ここへ来たら配線の誤りである。
 * 契約を2箇所に書くより、実装だけを空にする方が「番頭が読む説明と実際の振る舞いがずれる」
 * 事故を構造的に防げる（I2: 黙って別物にならない）。
 */
function contractOnlyDaemon(): Daemon {
  return new Proxy({} as Daemon, {
    get(_target, prop) {
      throw new Error(
        `Kobo の写しは実装を持ちません（${String(prop)} が呼ばれました）。到達先へ HTTP で聞いてください。`
      );
    },
  });
}

/**
 * Kobo の Tool を**呼ぶだけ**の写しを作る。
 *
 * I2: 到達できないことを「結果なし」と混同しない——`ModuleClient` が理由を添えて投げる。
 */
export function createKoboProxyTools(
  specs: NamespacedToolDefinition[],
  client: ModuleClient
): NamespacedToolDefinition[] {
  return specs.map((spec) => ({
    ...spec,
    async execute(args: unknown) {
      const result = await client.invoke(
        KOBO_MODULE_NAME,
        spec.name,
        (args ?? {}) as Record<string, unknown>
      );
      return { content: result.content, ...(result.details ? { details: result.details } : {}) };
    },
  })) as NamespacedToolDefinition[];
}

/**
 * Kobo のモジュール定義を返す（番頭ホストが登録する）。
 *
 * @param baseUrl 到達先（既定は `BANTO_KOBO_URL`）
 * @param fetchImpl テストで差し替える口
 */
export function createKoboModule(
  baseUrl: string = defaultKoboUrl(),
  fetchImpl: typeof fetch = fetch
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  views: Array<{
    kind: string;
    title: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
    component: string;
    category?: string;
    icon?: string;
  }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
} {
  const client = createModuleClient(
    { modules: { [KOBO_MODULE_NAME]: { baseUrl } } },
    fetchImpl
  );
  // 契約は Kobo 側の定義そのもの。`execute` だけを HTTP 越しに差し替える
  const specs = createKoboTools(contractOnlyDaemon());

  return {
    name: KOBO_MODULE_NAME,
    title: "工場",
    description:
      "タスクを積むと、依存ゲート・職人の差配・監査・直列マージまでを自動で運ぶ統治基盤。" +
      "コードを変える仕事はここへ積む（決定62a）。",
    endpoint: { baseUrl },
    tools: createKoboProxyTools(specs, client),
    // ボード（状態機械のビューア）とレビュー面は Phase 4（task-0049）
    views: [],
    skills: [
      {
        name: "kobo-enqueue",
        description:
          "工場（Kobo）へ仕事を積むときの手順。何をタスクにし、定義に何を書き、" +
          "積んだあと何が返ってくるか。コードを変える依頼を受けたときに使う。",
        filePath: `${koboSkillsDir()}/kobo-enqueue/SKILL.md`,
      },
    ],
  };
}
