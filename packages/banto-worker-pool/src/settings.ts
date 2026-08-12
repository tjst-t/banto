/**
 * Worker Pool が設定画面に出す区画（決定41・決定43 の拡張）。
 *
 * ここは**項目の宣言では表せない**ので、描き先（`WorkerSettings`）を宣言する:
 *
 *   - バックエンド（pi / Claude Code / 将来の Codex）の一覧・状態・入切・既定
 *   - 等級ごとのモデルの割り当て（**どのバックエンドのモデルも同じ表に並ぶ**）
 *   - 職人の既定の等級と、畳み忘れの安全弁
 *
 * 一覧とその中の状態が絡み合っていて、平たい項目の並びにすると
 * 「どのバックエンドのモデルなのか」「切ってあるのに選べるように見える」が出る。
 *
 * **読み書きは設定画面の口のまま**（`settings.describe` / `settings.update`）。
 * GUI を宣言しても、値のやりとりは他の区画と同じ経路——モジュールごとに
 * 独自の口を生やすと、番頭に渡らないはずの操作が別の面から漏れる。
 */

import type { ModuleSettingsSpec, SettingsSection } from "@banto/core";
import { WORKER_TIERS, type WorkerTier } from "./backends.js";
import type { WorkerPool } from "./pool.js";

const MINUTE = 60_000;

/** 画面へ渡す値の形（`WorkerSettings` がそのまま描く）。 */
export interface WorkerSettingsValues extends Record<string, unknown> {
  idleTimeoutMinutes: number;
  defaultTier: WorkerTier | "";
  tiers: readonly WorkerTier[];
  assignments: Partial<Record<WorkerTier, string>>;
  backends: ReturnType<WorkerPool["backends"]>;
  models: ReturnType<WorkerPool["selectableModels"]>;
  /** 指定しなかった等級を解くバックエンドと、そこで選ばれるもの（分かるものだけ）。 */
  fallbackBackend: string;
  fallbacks: Partial<Record<WorkerTier, string>>;
}

/** 画面から来る変更の形（触った分だけ入る）。 */
export interface WorkerSettingsUpdate {
  idleTimeoutMinutes?: number;
  defaultTier?: WorkerTier;
  /** 等級 → モデル名（空文字で解除）。 */
  assignments?: Partial<Record<WorkerTier, string>>;
  /** バックエンドの入切・既定。 */
  backends?: Record<string, { enabled?: boolean; makeDefault?: boolean }>;
}

export interface WorkerPoolSettingsOptions {
  /**
   * 安全弁の保存先（省略可）。バックエンドと割り当ての保存は `WorkerPool` が持つ
   * （`settingsSection`）——真実を1か所にするため、ここでは触らない。
   */
  section?: SettingsSection;
}

export function createWorkerPoolSettings(
  pool: WorkerPool,
  options?: SettingsSection | WorkerPoolSettingsOptions
): ModuleSettingsSpec {
  const opts: WorkerPoolSettingsOptions =
    options && "read" in options
      ? { section: options as SettingsSection }
      : ((options ?? {}) as WorkerPoolSettingsOptions);
  const section = opts.section;

  return {
    title: "職人",
    description:
      "職人を動かすバックエンドと、等級ごとに使うモデル。" +
      "**「LLM・モデル」の区画で職人に許したモデル**が、ここの選択肢に並ぶ" +
      "（あちらは素材と採用、ここは職人の当て方）。",
    // 決定43（モジュールへ開放。PO要望 2026-08-10）: 一覧と状態が絡むため描き先を宣言する
    view: "WorkerSettings",
    fields: [],
    read: (): WorkerSettingsValues => ({
      idleTimeoutMinutes: Math.round(pool.currentIdleTimeoutMs() / MINUTE),
      defaultTier: pool.tierAssignments().defaultTier ?? "",
      tiers: WORKER_TIERS,
      assignments: pool.tierAssignments().assignments,
      backends: pool.backends(),
      models: pool.selectableModels(),
      fallbackBackend: pool.fallbackModels().backendTitle,
      fallbacks: pool.fallbackModels().models,
    }),
    write: (values) => {
      const update = values as WorkerSettingsUpdate;
      const messages: string[] = [];

      if (update.idleTimeoutMinutes !== undefined) {
        const minutes = Number(update.idleTimeoutMinutes);
        // I2: 数でないものを黙って既定に落とさない
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new Error(
            `アイドルの安全弁は0以上の数で指定してください（受け取った値: ${String(update.idleTimeoutMinutes)}）`
          );
        }
        pool.setIdleTimeout(minutes * MINUTE);
        section?.write({ ...(section.read() ?? {}), idleTimeoutMs: minutes * MINUTE });
        messages.push("安全弁を変えました（すぐ効きます）。");
      }

      for (const [id, next] of Object.entries(update.backends ?? {})) {
        pool.setBackend(id, next);
        messages.push(
          next.makeDefault
            ? `${id} を既定にしました。`
            : `${id} を${next.enabled === false ? "切りました" : "入れました"}。`
        );
      }

      for (const [tier, model] of Object.entries(update.assignments ?? {})) {
        if (!WORKER_TIERS.includes(tier as WorkerTier)) {
          throw new Error(`知らない等級です: ${tier}`);
        }
        pool.setTierAssignment(tier as WorkerTier, model);
        messages.push(
          model && model.length > 0 ? `${tier} は ${model} で起こします。` : `${tier} の指定を外しました。`
        );
      }

      if (update.defaultTier !== undefined) {
        pool.setDefaultTier(update.defaultTier);
        messages.push(`職人の既定を ${update.defaultTier} にしました。`);
      }

      return {
        applied: true,
        message:
          messages.length > 0
            ? `${messages.join(" ")}（次に起こす職人から効きます）`
            : "変えるものがありませんでした。",
      };
    },
  };
}
