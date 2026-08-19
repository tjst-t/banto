/**
 * Worker Pool が設定画面に出す区画（決定41）。
 *
 * **モデルの当て方は「役割とモデル」に統合**（ADR-0021 の続き・2026-08-19 提案）。
 * ここが持つのは、工房自身の設定で残ったもの——アイドルの安全弁だけ。
 *
 * 値の読み書きは設定画面の口（`settings.describe` / `settings.update`）のまま。
 */

import type { ModuleSettingsSpec, SettingsSection } from "@banto/core";
import type { WorkerPool } from "./pool.js";

const MINUTE = 60_000;

/** 画面へ渡す値の形（アイドルの安全弁だけ）。 */
export interface WorkerSettingsValues extends Record<string, unknown> {
  /** 何もしていない職人を畳むまでの時間（分）。 */
  idleTimeoutMinutes: number;
}

export function createWorkerPoolSettings(
  pool: WorkerPool,
  section?: SettingsSection
): ModuleSettingsSpec {
  return {
    title: "Worker Pool",
    description:
      "職人のランタイム（工房）の設定。モデルの当て方（等級既定・工場の上書き）は" +
      "「役割とモデル」で決めます。ここが持つのはアイドルの安全弁だけです——" +
      "何もしていない職人を畳むまでの時間（0 で切る）。",
    fields: [
      {
        key: "idleTimeoutMinutes",
        label: "アイドルの安全弁（分）",
        type: "number",
        description:
          "何もしていない職人を畳むまでの時間。0 で切る（環境変数 BANTO_WORKER_IDLE_MS でも指定可）",
      },
    ],
    read: (): WorkerSettingsValues => ({
      idleTimeoutMinutes: Math.round(pool.currentIdleTimeoutMs() / MINUTE),
    }),
    write: (values) => {
      const minutes = Number(values["idleTimeoutMinutes"]);
      if (!Number.isFinite(minutes) || minutes < 0) {
        throw new Error(
          `アイドルの安全弁は0以上の数で指定してください（受け取った値: ${String(values["idleTimeoutMinutes"])}）`
        );
      }
      pool.setIdleTimeout(minutes * MINUTE);
      section?.write({ ...(section.read() ?? {}), idleTimeoutMs: minutes * MINUTE });
      return { applied: true, message: "安全弁を変えました（すぐ効きます）。" };
    },
  };
}
