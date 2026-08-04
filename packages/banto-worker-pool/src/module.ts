/**
 * Worker Pool のモジュール定義（ADR-0010 決定25・27c）。
 *
 * 決定27 の登録単位（接続情報＋番頭へのTool＋キャンバスへのGUI＋SKILL）を満たす。
 * Banto から見れば**必須の組み込みモジュール**——常に同梱されるが、機構としては他の
 * モジュールと対等。無いと番頭は職人へ委譲できず D10 が構造的に満たせない。
 *
 * このファイルは banto-host に依存しない。モジュールの形（BantoModule）は banto-host が
 * 定義しているが、構造的に一致する平たいオブジェクトを返すことで依存を持たずに済ませる
 * ——Kobo など banto-host に依存できない側からも同じ定義を使えるようにするため。
 */

import { Type } from "typebox";
import type { NamespacedToolDefinition } from "@banto/core";
import { createWorkerReportTools, createWorkerTools } from "./worker-tools.js";
import type { WorkerPool } from "./pool.js";
import { resumeWorkers } from "./resume.js";
import { createWorkerPoolSettings } from "./settings.js";

/** 既定の到達先。Worker Pool は独立サービスなので、通常は絶対URLで設定される。 */
export const WORKER_POOL_BASE_URL = "/api/worker-pool";

/** SKILL の置き場所（`packages/banto-worker-pool/skills`）。 */
export function workerPoolSkillsDir(): string {
  return new URL("../skills", import.meta.url).pathname;
}

/**
 * Worker Pool のモジュール定義を返す。
 *
 * @param pool 対象の Worker Pool
 * @param baseUrl 到達先。独立サービスとして立てるなら絶対URL、Banto に同居させるなら相対パス
 */
export function createWorkerPoolModule(
  pool: WorkerPool,
  baseUrl: string = WORKER_POOL_BASE_URL,
  /** 職人の復帰に使う状態の置き場（前回の起動時刻）。省略すると復帰しない。 */
  resumeStateDir?: string
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  internalTools: NamespacedToolDefinition[];
  init(ctx: { log(message: string): void }): Promise<void>;
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
  settings: import("@banto/core").ModuleSettingsSpec;
} {
  return {
    name: "worker-pool",
    title: "職人",
    description:
      "職人（worker）を起こして実作業を任せる。番頭が細かい仕事をせず委譲するための実行能力（D10）。",
    endpoint: { baseUrl },
    /**
     * 起動のたびに、落ちる前に生きていた職人を起こし直す（決定44）。
     *
     * 中核ではなくここに置くのは、これが Worker Pool の都合だから——番頭核は
     * 「職人がどう畳まれ、どう起き直るか」を知らなくてよい（決定27）。
     */
    async init(ctx) {
      if (!resumeStateDir) {
        ctx.log("復帰の状態置き場が渡されていないため、職人の復帰は行いません");
        return;
      }
      const results = await resumeWorkers({
        pool,
        stateDir: resumeStateDir,
        log: (m) => ctx.log(m),
      });
      const resumed = results.filter((r) => r.detail === "復帰").length;
      ctx.log(`職人の復帰: ${resumed} 件（対象 ${results.length} 件）`);
    },
    tools: createWorkerTools(pool),
    // 職人（別プロセス）から呼ばれる口。番頭には渡さない（決定29e）
    internalTools: createWorkerReportTools(pool),
    views: [
      {
        kind: "worker.viewer",
        title: "職人",
        description:
          "動いている職人の一覧と、その出力を覗く（セッションビューア）。" +
          "「いま何が動いているか」「あの作業はどうなったか」を見せたいときに開く。",
        parameters: Type.Object({
          sessionId: Type.Optional(
            Type.String({ description: "最初に選ぶ職人（省略時は一覧から選ぶ）" })
          ),
        }),
        component: "WorkerViewer",
        category: "worker-pool",
        icon: "🛠",
      },
    ],
    // SKILL は decision 26 の第2層（モジュールが出す既定）
    skills: [
      {
        name: "worker-delegation",
        description:
          "職人（worker）へ実作業を委譲するときの手順。何を渡し、どこまで書き切り、どう見届けるか。" +
          "調査・実装・修正など手を動かす仕事を自分でやりそうになったとき、およびPOから作業を頼まれたときに使う。",
        filePath: `${workerPoolSkillsDir()}/worker-delegation/SKILL.md`,
      },
    ],
    // 決定41: 設定画面に自分の区画を出す。GUI ではなく項目の宣言
    settings: createWorkerPoolSettings(pool),
  };
}
