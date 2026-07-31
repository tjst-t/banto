/**
 * Environment Pool（動作検証環境）— ADR-0010 決定32・task-0033。
 *
 * **Kobo から独立したモジュール。** Kobo のサブシステムではなく、Kobo が無くても単体で
 * 成立する（Worker Pool と同じ扱い・決定23）。番頭は Kobo の完成を待たずに、
 * 「テストが通った」を機構が返した事実として受け取れるようになる——決定29(a)
 * 「報告は主張であって完了の証明ではない」と噛み合う。
 *
 * ここにあるのは実行能力だけで、統治（どのプロファイルをどのタスクに使うか、検証が
 * 通ったら review-ready へ動かすか）は Kobo に残る。
 *
 * 契約（`EnvDriver` の7動詞）は `@banto/core` にあり、ランタイム中立のまま。
 * このパッケージはその具象——ドライバ2種・runner・環境台帳・credentials の復号。
 *
 * task-0034 で中の契約が入った（決定34）：`envId` を主キーにした `EnvironmentPool` と
 * `env.*` Tool、`repoPath` からのプロファイル解決、`workdir`、アドホック環境、上限。
 * **Kobo を経由しない経路がここで成立する**（決定32c）。
 *
 * サービス化（HTTP面）と Kobo の提供元差し替えはまだ別タスク（決定32a の2段目）。
 */

// 本体（envId を主キーにした操作一式・決定34b）
export { EnvironmentPool, ADHOC_PROFILE_PREFIX } from "./pool.js";
export type {
  EnvironmentPoolOptions,
  ProvisionRequest,
  EnvSummary,
  RunResult,
  VerifyResult,
} from "./pool.js";

// 外から見えるようにする口（決定39）。中継は Environment Pool の責務——banto-host に置くと
// Banto がブローカーになり（決定27）、独立サービス化のときに移すことになる
export { createEnvProxyExposer, ENV_PROXY_PATH } from "./proxy-exposer.js";
export type { EnvProxy, EnvProxyOptions } from "./proxy-exposer.js";

// 外から見えるようにする口の Caddy 実装（決定39）。既定ではない——banto が Caddy を持つ配置向け
export { createCaddyExposer } from "./caddy-exposer.js";
export type { CaddyExposerOptions } from "./caddy-exposer.js";

// 番頭へ渡す Tool とモジュール定義（決定34a）
export { createEnvTools } from "./tools.js";
export { createEnvironmentPoolModule, ENVIRONMENT_POOL_BASE_URL } from "./module.js";

// 既定とハード上限・アドホックの可否（決定34e・f）
export {
  DEFAULT_ENV_LIMITS,
  BUILTIN_DRIVER_NAMES,
  resolveLimits,
  checkProfileLimits,
  checkAdhocDriver,
  clampTtl,
} from "./limits.js";
export type { EnvLimits, AdhocDriverPolicy, BuiltinDriverName, LimitCheck } from "./limits.js";

// プロファイルの解決（決定34c: 在り処は呼び出し側が渡す）
export { loadProfile, listProfiles, environmentsFilePath } from "./profiles.js";
export type { ProfileLookup } from "./profiles.js";

// 環境台帳（provision した環境の帳簿。作った者が片付ける責任を負う・決定32e）
export { EnvLedger, countLiveByProfile } from "./env-ledger.js";
export type { EnvLedgerEntry } from "./env-ledger.js";

// ドライバの起動（7動詞を子プロセスとして回し、結果を受け取る）
export {
  runDriverVerb,
  resolveDriverPath,
  DEFAULT_DRIVER_TIMEOUT_MS,
} from "./env-driver-runner.js";
export type { DriverRunResult } from "./env-driver-runner.js";

// credentials の復号（決定32d: 鍵はこのモジュールが持つ。番頭の文脈に平文を出さない）
export { decryptSops, resolveCredentialsPath } from "./sops.js";
export type { SopsDecryptResult } from "./sops.js";

/**
 * 同梱ドライバの実体（`process` / `docker`）。
 *
 * どちらも stdin/stdout で喋る独立した実行ファイルで、モジュールとしては import しない
 * ——`resolveDriverPath()` がパスを返し、runner が子プロセスとして起こす。
 * ここから export しないのは、import すると CLI 本体が走ってしまうため。
 */
export const BUILTIN_ENV_DRIVERS = ["process", "docker"] as const;
