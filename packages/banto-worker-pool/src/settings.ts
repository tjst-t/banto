/**
 * Worker Pool が設定画面に出す区画（決定41）。
 *
 * **GUI は持たない。項目の宣言だけ渡す。** 描くのは Banto の設定画面。
 *
 * 職人のモデルは LLM Registry（ADR-0004）が管理するため、ここでは
 * アイドルタイムアウトの安全弁だけを出す。
 */

import type { ModuleSettingsSpec, SettingsSection } from "@banto/core";
import type { WorkerPool } from "./pool.js";

const MINUTE = 60_000;

/**
 * @param section 保存先（省略可）。渡すと**次の起動でも効く**——独立サービスとして立つと
 *   借りる相手がいないので、自分のデータ置き場のファイルを渡す（task-0066）
 */
export function createWorkerPoolSettings(
  pool: WorkerPool,
  section?: SettingsSection
): ModuleSettingsSpec {
  return {
    title: "職人",
    description:
      "畳み忘れの安全弁。職人のモデルは LLM Registry で管理する" +
      "（番頭とは別のモデルを使える——職人は手を動かす側なので、安い・速いモデルで足りることが多い）。",
    fields: [
      {
        key: "idleTimeoutMinutes",
        label: "アイドルの安全弁",
        type: "number",
        unit: "分",
        description:
          "何もしていない職人を畳むまでの時間（既定15分）。**これは安全弁であって主機構ではない**" +
          "——主たる契機は番頭が worker.close で畳むこと。短くして主機構にすると、" +
          "番頭が職人の面倒を見なくなる。0 で切れる（切ると畳み忘れが残り続ける）",
      },
    ],
    read: () => {
      return {
        idleTimeoutMinutes: Math.round(pool.currentIdleTimeoutMs() / MINUTE),
      };
    },
    write: (values) => {
      const raw = values["idleTimeoutMinutes"];
      if (raw !== undefined && raw !== null && raw !== "") {
        const minutes = Number(raw);
        // I2: 数でないものを黙って既定に落とさない
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new Error(`アイドルの安全弁は0以上の数で指定してください（受け取った値: ${String(raw)}）`);
        }
        pool.setIdleTimeout(minutes * MINUTE);
        // 次の起動でも同じ値で立ち上がる（渡されていれば）
        section?.write({ idleTimeoutMs: minutes * MINUTE });
      }

      return { applied: true, message: "変えました（すぐ効きます）。" };
    },
  };
}
