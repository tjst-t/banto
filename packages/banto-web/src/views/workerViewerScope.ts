/**
 * WorkerViewer の絞り込み判断（純粋関数）。
 *
 * `tsconfig.check.json`（リポジトリ直下）は `jsx` を設定していないため、
 * `tests/acceptance` から `.tsx` を直接 import すると型検査が落ちる
 * （`filePreview.ts`・`prefersNoAutoFocus.ts` と同じ理由・同じ回避）。
 * DOM無しで（node:test で）確かめられるよう、判断だけをここへ切り出す。
 */

/**
 * `threadFamily`（threadId の一族）を worker.list の `origins` へ変換する。
 *
 * origin の形は `banto:<threadId>`（`packages/banto-host/src/worker-notice.ts` の
 * `threadOrigin`）。Worker Pool 側はこの接頭辞の意味を知らず文字列一致でしか絞れない
 * ——番頭が職人を起こすときに付けた値をそのまま組み立てて渡す（形は変えない・決定29）。
 */
export function originsOfFamily(threadFamily: string[] | undefined): string[] {
  return (threadFamily ?? []).map((threadId) => `banto:${threadId}`);
}

/**
 * 一覧が0件のときに出す文言（task-0310 a4）。
 *
 * PO報告の実害はここが直接の再発防止——「この会話には居ない」のか「そもそも誰も
 * 頼んでいない」のかを区別できないと、また誤読を生む。
 */
export function emptyStateText(opts: {
  query: string;
  scopedToThread: boolean;
  closedCount: number;
  showClosed: boolean;
}): { title: string; body: string } {
  const { query, scopedToThread, closedCount, showClosed } = opts;
  if (query) {
    return { title: `「${query}」に当てはまる職人はいません`, body: "" };
  }
  const title = scopedToThread ? "この会話では職人を起こしていません" : "動いている職人はいません";
  if (closedCount > 0 && !showClosed) {
    return { title, body: `終わった職人が ${closedCount} 人います。「終わった職人も表示」で見られます。` };
  }
  const body = scopedToThread
    ? "ほかの会話の職人を見るには「全部の会話」へ切り替えてください。"
    : "番頭に仕事を頼むと、ここに職人が並びます。";
  return { title, body };
}
