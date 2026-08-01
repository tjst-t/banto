/**
 * Worker Pool が設定画面に出す区画（決定41）。
 *
 * **GUI は持たない。項目の宣言だけ渡す。** 描くのは Banto の設定画面。
 *
 * ここに出すのは「POが決めること」だけ。到達先や台帳の置き場のような**配線**は
 * 設定ではない——動かすために必要な値で、画面から変えるものではない。
 */

import type { ModuleSettingsSpec, SettingsSection } from "@banto/core";
import type { WorkerPool } from "./pool.js";

const MINUTE = 60_000;

/** 職人のモデルを差し替えられるドライバ（PiRpcDriver が満たす）。 */
export interface ModelConfigurableDriver {
  currentDefaults(): { provider: string; model: string };
  setDefaults(next: { provider?: string; model?: string }): void;
}

export function createWorkerPoolSettings(
  pool: WorkerPool,
  driver?: ModelConfigurableDriver,
  section?: SettingsSection
): ModuleSettingsSpec {
  return {
    title: "職人",
    description:
      "職人（worker）に渡すモデルと、畳み忘れの安全弁。" +
      "**番頭とは別のモデルを使える**——職人は手を動かす側なので、番頭より安い・速いモデルで足りることが多い。",
    fields: [
      {
        key: "provider",
        label: "プロバイダ",
        type: "text",
        placeholder: "opencode",
        description: "職人に渡すプロバイダ。番頭の設定とは別（次に起こす職人から効く）",
      },
      {
        key: "model",
        label: "モデル",
        type: "text",
        placeholder: "deepseek-v4-flash-free",
        description: "職人に渡すモデル。動いている職人は途中で変えない（分かりにくいため）",
      },
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
      const defaults = driver?.currentDefaults();
      return {
        ...(defaults ? { provider: defaults.provider, model: defaults.model } : {}),
        idleTimeoutMinutes: Math.round(pool.currentIdleTimeoutMs() / MINUTE),
      };
    },
    write: (values) => {
      if (driver && (values["provider"] || values["model"])) {
        driver.setDefaults({
          ...(typeof values["provider"] === "string" ? { provider: values["provider"] } : {}),
          ...(typeof values["model"] === "string" ? { model: values["model"] } : {}),
        });
      }

      const raw = values["idleTimeoutMinutes"];
      if (raw !== undefined && raw !== null && raw !== "") {
        const minutes = Number(raw);
        // I2: 数でないものを黙って既定に落とさない
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new Error(`アイドルの安全弁は0以上の数で指定してください（受け取った値: ${String(raw)}）`);
        }
        pool.setIdleTimeout(minutes * MINUTE);
      }

      const defaults = driver?.currentDefaults();
      section?.write({
        ...(defaults ? { provider: defaults.provider, model: defaults.model } : {}),
        idleTimeoutMs: pool.currentIdleTimeoutMs(),
      });
      return { applied: true, message: "変えました（次に起こす職人から効きます）。" };
    },
  };
}
