/**
 * 職人へ渡す pi 拡張の場所（ADR-0010 決定29e）。
 *
 * 拡張の実体は `pi-extension/worker-report.ts`。ここはその在り処を返すだけで、
 * 呼び出し側（WorkerPool・Kobo）が `--extension` として職人に渡す。
 */

/**
 * `worker.report` / `worker.ask` を職人に足す拡張のパス。
 *
 * src から実行する場合と dist から実行する場合で拡張子が変わるため、
 * このモジュール自身の拡張子に合わせて解決する。
 */
export function workerReportExtensionPath(): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./pi-extension/worker-report${ext}`, import.meta.url).pathname;
}
