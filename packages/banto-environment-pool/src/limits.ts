/**
 * 能力側が持つ既定とハード上限（ADR-0010 決定34e・f・task-0034）。
 *
 * **なぜ能力側が持つのか。** D9 で外部VMコストは one-way な副作用（D1 に戻る）とされている。
 * プロファイルに `ttl: 720h` と書けば通る状態では quota が歯止めとして機能しない——
 * 機構が上限を持たないと誰も止められない。
 *
 * **超えるプロファイルは黙って丸めず拒否する**（I2）。丸めると、プロファイルに書いた値と
 * 実際に効く値が食い違ったまま誰も気づかない。拒否すれば書いた人が直せる。
 *
 * アドホックの可否も同じ置き場にする（決定34f）。上限と許可は同じ性質——
 * 能力側が持つ安全側の既定であり、置き場を割らない。
 */

import type { EnvProfile } from "@banto/core";

/** 同梱ドライバ。「お金がかからない側」の線引きでもある（決定34e）。 */
export const BUILTIN_DRIVER_NAMES = ["process", "docker"] as const;
export type BuiltinDriverName = (typeof BUILTIN_DRIVER_NAMES)[number];

/**
 * アドホック環境（`driver` + `config` 直指定）でどのドライバを許すか。
 *
 * - `builtin`（既定）: `process` / `docker` のみ。線引きが「お金がかかるかどうか」で
 *   説明でき、I3 を守りつつ手元の検証は軽く回せる
 * - `all`: 外部ドライバも許す。プロジェクトによっては開けたい場面がある
 * - `none`: アドホック自体を許さない。プロファイル経由だけにする
 */
export type AdhocDriverPolicy = "builtin" | "all" | "none";

export interface EnvLimits {
  /** TTL を書いていないプロファイル・アドホックに付ける既定。 */
  defaultTtlMs: number;
  /** これを超える TTL は拒否する。 */
  maxTtlMs: number;
  /** 1プロファイルあたりの同時実行数の上限。プロファイルの quota はこの範囲でのみ指定できる。 */
  maxInstancesPerProfile: number;
  /** 全体の同時実行数の上限。プロファイルをまたいで効く。 */
  maxInstancesTotal: number;
  /** アドホック環境の可否（決定34e）。 */
  adhocDrivers: AdhocDriverPolicy;
  /**
   * `run` の既定の制限時間（spec §8 の裁定・2026-08-01）。
   *
   * 以前はドライバの全動詞に一律30秒だった。**`npm test` が30秒で切れる**——検証を
   * 回すための機構なのに、検証コマンドが最後まで走れないという状態だった。
   */
  defaultRunTimeoutMs: number;
  /** `run` に指定できる制限時間の上限。呼び出し側は**厳しくのみ**できる。 */
  maxRunTimeoutMs: number;
  /**
   * プロファイルの `setup` に与える制限時間（task-0080）。
   *
   * **`run` とは別に持つ。** setup は依存の取得（`npm ci` 等）が主で、検証コマンドより
   * 長くなりがちな一方、**1環境につき1回**しか走らない。実測：loamium の
   * `npm ci --ignore-scripts` が1分。ここが短いと、受け持ったばかりのプロジェクトが
   * 「用意の途中で切れる」形で必ず落ちる（task-0075 の provision で同じ踏み方をした）。
   */
  defaultSetupTimeoutMs: number;
  /**
   * 回収した成果物を残す期間（既定7日）。
   *
   * **放っておくと増え続ける。** `collect` のたびに環境ごとのディレクトリができ、
   * 環境を畳んでも残る。番頭は検証のたびに回収できるので、Kobo が task 単位で回して
   * いた頃より速く溜まる。
   */
  collectedRetentionMs: number;
  /**
   * 畳んだ環境を台帳に残す期間（既定30日）。
   *
   * 台帳は監査のために畳んだ分も残す（spec §5）が、無期限だと際限がない。
   * 生きている環境は期間に関係なく残る。
   */
  ledgerRetentionMs: number;
}

/**
 * 既定値。**`spec-environment` §5.1 の表がそのまま真実**——ここで別の数字を選ばない。
 *
 * 以前このファイルは既定TTLを4時間にしていた（spec は30分）。「手元の検証には十分」と
 * いう理屈を後から付けただけで、spec を見ていなかった——番頭に指摘されて直した（P3）。
 */
export const DEFAULT_ENV_LIMITS: EnvLimits = {
  defaultTtlMs: 30 * 60 * 1000,
  maxTtlMs: 24 * 3600 * 1000,
  maxInstancesPerProfile: 4,
  maxInstancesTotal: 8,
  adhocDrivers: "builtin",
  defaultRunTimeoutMs: 10 * 60 * 1000,
  maxRunTimeoutMs: 60 * 60 * 1000,
  defaultSetupTimeoutMs: 15 * 60 * 1000,
  collectedRetentionMs: 7 * 24 * 3600 * 1000,
  ledgerRetentionMs: 30 * 24 * 3600 * 1000,
};

/** 設定で一部だけ上書きできるようにする（ホストの起動設定から渡す）。 */
export function resolveLimits(overrides: Partial<EnvLimits> = {}): EnvLimits {
  return { ...DEFAULT_ENV_LIMITS, ...overrides };
}

/** 拒否の理由。`env_profile_rejected` にそのまま載せる。 */
export type LimitCheck = { ok: true } | { ok: false; reason: string };

/**
 * プロファイルが上限の範囲に収まっているか。
 *
 * I2: 超えていたら丸めずに理由つきで拒否する。
 */
export function checkProfileLimits(profile: EnvProfile, limits: EnvLimits): LimitCheck {
  if (profile.ttlMs > limits.maxTtlMs) {
    return {
      ok: false,
      reason:
        `profile "${profile.name}": ttl ${formatMs(profile.ttlMs)} は上限 ` +
        `${formatMs(limits.maxTtlMs)} を超えています（丸めずに拒否します）`,
    };
  }
  const max = profile.quota?.max_instances;
  if (max !== undefined && max > limits.maxInstancesPerProfile) {
    return {
      ok: false,
      reason:
        `profile "${profile.name}": quota.max_instances ${max} は上限 ` +
        `${limits.maxInstancesPerProfile} を超えています（丸めずに拒否します）`,
    };
  }
  return { ok: true };
}

/**
 * アドホックのドライバ指定が許されているか（決定34e）。
 *
 * I2: 許していない指定は黙ってビルトインに差し替えず拒否する——「頼んだものと違うもので
 * 検証された」が一番困る。
 */
export function checkAdhocDriver(driver: string, limits: EnvLimits): LimitCheck {
  if (limits.adhocDrivers === "none") {
    return {
      ok: false,
      reason: "アドホック環境は許可されていません（adhocDrivers: none）。プロファイルを使ってください",
    };
  }
  if (limits.adhocDrivers === "all") return { ok: true };
  if ((BUILTIN_DRIVER_NAMES as readonly string[]).includes(driver)) return { ok: true };
  return {
    ok: false,
    reason:
      `アドホックで使えるのは ${BUILTIN_DRIVER_NAMES.join(" / ")} だけです（adhocDrivers: builtin）。` +
      `"${driver}" のような外部ドライバは費用が出る側なので、設定で明示的に開ける必要があります`,
  };
}

/**
 * `run` の制限時間を決める。**呼び出し側は厳しくのみできる**（spec §5.1 と同じ性質）。
 *
 * 上限を超える指定は丸める——TTL や quota と違って拒否にしないのは、ここが「待つ長さ」で
 * あって外に残るものではないから。長く待たせすぎないための歯止めで足りる。
 */
export function resolveRunTimeout(requested: number | undefined, limits: EnvLimits): number {
  if (requested === undefined) return limits.defaultRunTimeoutMs;
  return Math.min(Math.max(1000, requested), limits.maxRunTimeoutMs);
}

/** 上限の TTL に収める（アドホックの既定TTLを決めるときに使う）。 */
export function clampTtl(requested: number | undefined, limits: EnvLimits): number {
  if (requested === undefined) return limits.defaultTtlMs;
  return Math.min(requested, limits.maxTtlMs);
}

function formatMs(ms: number): string {
  const hours = ms / 3600 / 1000;
  return hours >= 1 ? `${Number(hours.toFixed(2))}h` : `${Math.round(ms / 1000)}s`;
}
