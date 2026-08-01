/**
 * Environment Pool が設定画面に出す区画（決定41）。
 *
 * **GUI は持たない。項目の宣言だけ渡す。** 描くのは Banto の設定画面で、ここが持つのは
 * 「何を設定できるか」と「いまの値」と「変更をどう効かせるか」。
 *
 * 上限はその場で効く（`applyLimits`）——設定したのに次の起動まで効かない、を避けられる
 * 箇所はそうする。保存は貸してもらった区画（`SettingsSection`）に書く。
 */

import type { ModuleSettingsSpec, SettingsSection } from "@banto/core";
import type { EnvironmentPool } from "./pool.js";

/** 分で受けてミリ秒で持つ。画面に「ミリ秒」を並べても人には読めない。 */
const MINUTE = 60_000;

export function createEnvironmentSettings(
  pool: EnvironmentPool,
  section?: SettingsSection
): ModuleSettingsSpec {
  return {
    title: "検証環境",
    description:
      "検証環境の上限と既定。**プロファイルはこの範囲でのみ指定できる**——" +
      "機構が上限を持たないと誰も止められない（外部VMコストは戻せない）。",
    fields: [
      {
        key: "defaultTtlMinutes",
        label: "既定の生存期間",
        type: "number",
        unit: "分",
        description: "プロファイルが期限を書いていないとき・アドホック環境に付く期限（既定30分）",
      },
      {
        key: "maxTtlMinutes",
        label: "生存期間の上限",
        type: "number",
        unit: "分",
        description: "これを超える期限を書いたプロファイルは、丸めずに拒否される（既定24時間）",
      },
      {
        key: "maxInstancesTotal",
        label: "同時に立てられる数（全体）",
        type: "number",
        unit: "件",
        description: "既定8。使い終わったものを畳まないとここで止まる",
      },
      {
        key: "maxInstancesPerProfile",
        label: "同時に立てられる数（プロファイルごと）",
        type: "number",
        unit: "件",
        description: "既定4。プロファイル側でより厳しくはできるが、緩められない",
      },
      {
        key: "defaultRunTimeoutMinutes",
        label: "検証コマンドの制限時間",
        type: "number",
        unit: "分",
        description: "既定10分。呼び出し側は短くのみできる（テスト一式が切れないための値）",
      },
      {
        key: "collectedRetentionDays",
        label: "成果物を残す期間",
        type: "number",
        unit: "日",
        description: "既定7日。過ぎたものは自動で捨てる（要らないと分かれば env.cleanup で先に捨てられる）",
      },
      {
        key: "adhocDrivers",
        label: "アドホック環境で使えるドライバ",
        type: "select",
        options: [
          { value: "builtin", label: "同梱のみ（process / docker）" },
          { value: "all", label: "外部ドライバも許す" },
          { value: "none", label: "アドホックを許さない" },
        ],
        description:
          "既定は同梱のみ。線引きは「お金がかかるかどうか」——外部ドライバはVM等で費用が出る側",
      },
    ],
    read: () => {
      const limits = pool.currentLimits();
      return {
        defaultTtlMinutes: Math.round(limits.defaultTtlMs / MINUTE),
        maxTtlMinutes: Math.round(limits.maxTtlMs / MINUTE),
        maxInstancesTotal: limits.maxInstancesTotal,
        maxInstancesPerProfile: limits.maxInstancesPerProfile,
        defaultRunTimeoutMinutes: Math.round(limits.defaultRunTimeoutMs / MINUTE),
        collectedRetentionDays: Math.round(limits.collectedRetentionMs / (24 * 60 * MINUTE)),
        adhocDrivers: limits.adhocDrivers,
      };
    },
    write: (values) => {
      const num = (key: string): number | undefined => {
        const raw = values[key];
        if (raw === undefined || raw === null || raw === "") return undefined;
        const parsed = Number(raw);
        // I2: 数でないものを黙って既定に落とさない。設定したつもりで別の値になる
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`${key} は正の数で指定してください（受け取った値: ${String(raw)}）`);
        }
        return parsed;
      };

      const applied = pool.applyLimits({
        ...(num("defaultTtlMinutes") !== undefined ? { defaultTtlMs: num("defaultTtlMinutes")! * MINUTE } : {}),
        ...(num("maxTtlMinutes") !== undefined ? { maxTtlMs: num("maxTtlMinutes")! * MINUTE } : {}),
        ...(num("maxInstancesTotal") !== undefined ? { maxInstancesTotal: num("maxInstancesTotal")! } : {}),
        ...(num("maxInstancesPerProfile") !== undefined
          ? { maxInstancesPerProfile: num("maxInstancesPerProfile")! }
          : {}),
        ...(num("defaultRunTimeoutMinutes") !== undefined
          ? { defaultRunTimeoutMs: num("defaultRunTimeoutMinutes")! * MINUTE }
          : {}),
        ...(num("collectedRetentionDays") !== undefined
          ? { collectedRetentionMs: num("collectedRetentionDays")! * 24 * 60 * MINUTE }
          : {}),
        ...(typeof values["adhocDrivers"] === "string"
          ? { adhocDrivers: values["adhocDrivers"] as "builtin" | "all" | "none" }
          : {}),
      });

      // 次の起動でも同じ値で立ち上がるように保存する（貸してもらった区画へ）
      section?.write({
        defaultTtlMs: applied.defaultTtlMs,
        maxTtlMs: applied.maxTtlMs,
        maxInstancesTotal: applied.maxInstancesTotal,
        maxInstancesPerProfile: applied.maxInstancesPerProfile,
        defaultRunTimeoutMs: applied.defaultRunTimeoutMs,
        collectedRetentionMs: applied.collectedRetentionMs,
        adhocDrivers: applied.adhocDrivers,
      });
      return { applied: true, message: "上限を変えました（次に立てる環境から効きます）。" };
    },
  };
}
