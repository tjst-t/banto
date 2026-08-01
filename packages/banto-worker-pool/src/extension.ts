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
  return piExtensionPath("worker-report");
}

/**
 * `web.fetch` / `web.search` を職人に足す拡張のパス（imp-0005）。
 *
 * **既定では渡さない**（PO裁定 2026-07-30）。`delegate` に `network: true` が来たときだけ
 * 載せる——載せなければ Tool 自体が存在しない。
 */
export function webToolsExtensionPath(): string {
  return piExtensionPath("web-tools");
}

/** src から実行する場合と dist から実行する場合で拡張子が変わるため、自分に合わせて解決する。 */
function piExtensionPath(name: string): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./pi-extension/${name}${ext}`, import.meta.url).pathname;
}
