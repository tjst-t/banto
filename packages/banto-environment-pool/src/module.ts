/**
 * Environment Pool のモジュール定義（ADR-0010 決定25・27・32・task-0034）。
 *
 * Kobo から独立したモジュール（決定32）。番頭は Kobo の完成を待たずに、
 * 「テストが通った」を機構が返した事実として受け取れる。
 *
 * GUI はまだ持たない。環境の一覧は `env.list` で足りており、決定18 の
 * 「将来ニーズを見越した追加はしない」に従って、要る場面が出てから足す。
 *
 * このファイルは banto-host に依存しない（Worker Pool の module.ts と同じ扱い）。
 */

import type { NamespacedToolDefinition } from "@banto/core";
import { createEnvTools } from "./tools.js";
import type { EnvironmentPool } from "./pool.js";

/** 既定の到達先。独立サービスとして立てるなら絶対URLを渡す。 */
export const ENVIRONMENT_POOL_BASE_URL = "/api/environment-pool";

export function createEnvironmentPoolModule(
  pool: EnvironmentPool,
  baseUrl: string = ENVIRONMENT_POOL_BASE_URL
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  views: never[];
  skills: never[];
} {
  return {
    name: "environment-pool",
    title: "検証環境",
    description:
      "動作検証用の環境を立てて、コマンドを走らせて、畳む。番頭が「テストが通った」を" +
      "職人の主張ではなく機構の返す事実として受け取るための実行能力（決定29a）。" +
      "使い捨てなら env.verify 一本、居座らせたいなら低位動詞を使う。",
    endpoint: { baseUrl },
    tools: createEnvTools(pool),
    views: [],
    skills: [],
  };
}
