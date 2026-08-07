/**
 * ドライバが内側のコマンドに与える持ち時間（task-0079）。
 *
 * **ドライバは自分で持ち時間を決めない。** 決めるのは能力側（Environment Pool）で、
 * spec-environment §5.1 の表と §8 の裁定（2026-08-01）がそう定めている——
 * 「`run` のタイムアウトは能力側が既定と上限を持ち、呼び出し側は厳しくのみできる」。
 *
 * ところが同梱の docker ドライバは、内側の `docker compose` 呼び出しに
 * **自前の 120 秒**を掛けていた（`runCmd` の既定値）。Pool が `resolveRunTimeout` で
 * 10 分・上限 60 分を決めても、内側の 2 分が先に効く。実測：
 *
 *   env.run(cmd="sleep 200", timeoutMs=1_500_000) → **121 秒で exit 255**
 *
 * しかも `docker` は SIGTERM を捕まえて 255 で終わるので、**時間切れが時間切れに
 * 見えない**。ゲートは「検証コマンドが 255 で落ちた」と読み、task-0071 で入れた
 * 「時間切れなら延ばして再試行」（exit 124 を見ている）は一度も発火しない。
 * loamium の `npm test` はホストで4分なので、**マージ前ゲートを永久に通れなかった**。
 *
 * ここでの決め方：
 *
 * - **内側の持ち時間は呼び出し側の予算から導く**（`input.timeoutMs`）。ドライバが
 *   独自の数字を持つと、同じ「持ち時間」に2つの真実ができる（D3）
 * - **報告のための取り分を残す**（`REPORT_MARGIN_MS`）。内側と外側を同じにすると、
 *   ログを書いて JSON を返す前に外側が殺す——時間切れの証拠ごと消える
 * - **予算が届かないときは縛らない**。ドライバが勝手に短く切るのが今回の壊れ方だった。
 *   外側（`runDriverVerb` の subprocess timeout）が必ず居るので、上限が無くなるわけではない
 */

/**
 * 時間切れの終了コード。`timeout(1)` の慣習であり、**マージ前ゲートが見ている値**
 * （`merge-gate.ts` の `VERIFY_TIMEOUT_EXIT`）。ここを変えると
 * 「時間切れなら延ばして再試行」が黙って効かなくなるので、
 * 一致は `driver-timeout-budget.spec.ts` が機械で見張る。
 */
export const DRIVER_TIMEOUT_EXIT = 124;

/**
 * 内側の持ち時間から差し引く、報告のための取り分。
 *
 * ログを書き出して stdout に JSON を出すまでの分。外側に殺されると
 * `log_path` も exit も返らず、**何が起きたか分からない失敗**になる。
 */
export const REPORT_MARGIN_MS = 10_000;

/**
 * 状態を訊くだけのコマンド（`docker ps` / `docker compose ls`）に与える持ち時間。
 *
 * これらは**すぐ返るはず**のもので、返らないなら docker 自体が不調。
 * 検証コマンドの予算とは性質が違うので分けてある——ここを長くしても誰も得しない。
 */
export const QUERY_TIMEOUT_MS = 30_000;

/**
 * 呼び出し側の予算（`input.timeoutMs`）から、内側のコマンドに渡す持ち時間を出す。
 *
 * @returns ミリ秒。予算が無い・読めない・取り分に足りないほど短いときは `undefined`
 *          （＝内側では縛らない。外側の subprocess timeout が governs）
 */
export function innerBudgetMs(input: Record<string, unknown>): number | undefined {
  const raw = input["timeoutMs"];
  const budget = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(budget) || budget <= 0) return undefined;
  const inner = budget - REPORT_MARGIN_MS;
  // 取り分すら取れない短い予算は、内側で縛る意味がない（外側が先に殺す）
  return inner > 0 ? inner : undefined;
}
