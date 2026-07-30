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
 * **本タスクは切り出しのみで振る舞いを変えない**（決定32a の1段目）。サービス化
 * （番頭への `env.*` 提供）と Kobo の提供元差し替えは別タスク。
 */

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
