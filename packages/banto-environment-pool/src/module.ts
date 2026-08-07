/**
 * Environment Pool のモジュール定義（ADR-0010 決定25・27・32・task-0034）。
 *
 * Kobo から独立したモジュール（決定32）。番頭は Kobo の完成を待たずに、
 * 「テストが通った」を機構が返した事実として受け取れる。
 *
 * このファイルは banto-host に依存しない（Worker Pool の module.ts と同じ扱い）。
 */

import { Type } from "typebox";
import type * as http from "node:http";
import type { Duplex } from "node:stream";
import type { NamespacedToolDefinition } from "@banto/core";
import { createEnvTools } from "./tools.js";
import type { EnvProxy } from "./proxy-exposer.js";
import { createEnvironmentSettings } from "./settings.js";

/**
 * 検証環境の管理画面。
 *
 * **一番の役目は畳み忘れを見えるようにすること**（I3）。番頭が畳み損ねた環境は
 * `env.list` に残るが、番頭に聞かないと見えないのでは、費用が出続けていることに
 * POが気づけない。
 */
const envViews = [
  {
    kind: "env.manager",
    title: "検証環境",
    description:
      "いま立っている検証環境の一覧と、リポジトリごとの検証プロファイル。" +
      "環境をその場で畳める。畳み損ねた環境も分かる（放置すると費用がかかり続ける）。" +
      "「いま何が立っている？」「検証環境を片付けたい」ときに開く。",
    parameters: Type.Object({}),
    component: "EnvManager",
    category: "workspace",
    icon: "🧫",
  },
];
import type { EnvironmentPool } from "./pool.js";

/** 既定の到達先。独立サービスとして立てるなら絶対URLを渡す。 */
export const ENVIRONMENT_POOL_BASE_URL = "/api/environment-pool";

/** SKILL の置き場所（`packages/banto-environment-pool/skills`）。 */
export function environmentPoolSkillsDir(): string {
  return new URL("../skills", import.meta.url).pathname;
}

/**
 * @param proxy 検証環境への中継（決定39）。渡すと `{baseUrl}/env/<envId>/` が生える。
 *   **中継はこのモジュールの責務**——ホストは経路を渡すだけ（決定27：Banto をブローカーにしない）
 */
export function createEnvironmentPoolModule(
  pool: EnvironmentPool,
  baseUrl: string = ENVIRONMENT_POOL_BASE_URL,
  proxy?: EnvProxy,
  settingsSection?: import("@banto/core").SettingsSection
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  views: typeof envViews;
  settings: import("@banto/core").ModuleSettingsSpec;
  skills: Array<{ name: string; description: string; filePath: string }>;
  serve?(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  handleUpgrade?(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
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
    ...(proxy
      ? {
          serve: (req, res) => proxy.handle(req, res),
          handleUpgrade: (req, socket, head) => proxy.handleUpgrade(req, socket, head),
        }
      : {}),
    views: envViews,
    // 決定41: 設定画面に自分の区画を出す。GUI ではなく項目の宣言を渡す
    settings: createEnvironmentSettings(pool, settingsSection),
    // SKILL は decision 26 の第2層（モジュールが出す既定）。frontmatter はパースせず
    // コードで name / description を持ち、本体は `skills/environment/SKILL.md` に置く
    skills: [
      {
        name: "environment",
        description:
          "検証環境を立てて検証し、必ず畳む手順。「このブランチでテストが通るか」を" +
          "機構が返す事実として確かめたいとき（I1）、およびレビュー用に環境を残したいときに使う。" +
          "使い捨ては env.verify 一本、残すなら低位動詞。畳み忘れ・公開・成果物の取り出しもここに書いてある。",
        filePath: `${environmentPoolSkillsDir()}/environment/SKILL.md`,
      },
      {
        name: "environment-profiles",
        description:
          "検証環境の設定ファイル（meta/environments.yaml）の書き方。プロファイルを新しく" +
          "作る・直す・なぜ使えないのかを調べるときに使う。レビューで PO に触ってもらう環境を" +
          "用意したいとき、および env.verify に渡すプロファイルが無いときの最初の一歩。",
        filePath: `${environmentPoolSkillsDir()}/environment-profiles/SKILL.md`,
      },
    ],
  };
}
