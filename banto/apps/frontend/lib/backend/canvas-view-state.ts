// **大きく開いた Module の画面の「見ている場所」**（banto の拡張、2026-09-23、ユーザー要望）。
//
// MCP Apps には「画面が自分の状態を host に預け、開き直したときに返してもらう」口が無い
// （OpenAI Apps SDK の widget state にあたるもの）。無いと、ファイルブラウザでファイルを
// 開いたまま「別タブで開く」と、別タブでは最初の画面に戻ってしまう。
//
// - 画面 → banto：通知 `dev.banto/view-state`（`params.state` に小さな JSON）
// - banto：URL の `canvasView` に持つ——リロードしても、別タブ（URL をそのまま運ぶ）でも残る
// - banto → 画面：開き直したとき `hostContext["dev.banto/view-state"]` で返す
//
// **中身は画面のもの**で、banto は解釈しない。受け取るのは JSON の値で、URL に載せるので
// 小さいものだけ（超えたら預からない）。

export const VIEW_STATE_KEY = "dev.banto/view-state";
export const VIEW_STATE_PARAM = "canvasView";

/** URL に載せてよい大きさ（JSON の文字数）。 */
export const MAX_VIEW_STATE_LENGTH = 2000;

/** URL の値を画面に返す形にする。壊れていたら無いことにする（開き直すと最初の画面になるだけ）。 */
export function parseViewState(param: string | null): unknown {
  if (!param) return undefined;
  try {
    return JSON.parse(param) as unknown;
  } catch {
    return undefined;
  }
}

/** 画面から来た値を URL の値にする。**大きすぎる・JSON にできないものは預からない**（undefined）。 */
export function serializeViewState(state: unknown): string | undefined {
  if (state === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(state);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length > MAX_VIEW_STATE_LENGTH) return undefined;
  return json;
}

/**
 * いまの URL の `canvasView` だけを書き換える。**履歴には積まない**（replaceState）
 * ——画面の中でファイルを選ぶたびに「戻る」が増えるのは、banto の移動ではないので。
 * Next の router を通さないのは、サーバへの取り直しを起こさないため（Next は
 * 素の history API の変更を useSearchParams に反映する）。
 *
 * **第1引数は null にする**（2026-09-23 に踏んだ）。いまの `history.state` を渡すと、
 * そこに入っている Next の内部の印（`__NA`）を見て Next は「自分の操作」と扱い、
 * useSearchParams に反映しない——「別タブで開く」が古い場所を運んだ。
 * Next が自分の内部の状態は写し直す（`copyNextJsInternalHistoryState`）。
 */
export function writeViewStateToUrl(state: unknown): void {
  const json = serializeViewState(state);
  if (json === undefined) {
    if (state !== undefined) console.warn(`[banto] 画面の見ている場所が大きすぎるので預かりません（${MAX_VIEW_STATE_LENGTH} 字まで）`);
    return;
  }
  const url = new URL(window.location.href);
  if (url.searchParams.get(VIEW_STATE_PARAM) === json) return;
  url.searchParams.set(VIEW_STATE_PARAM, json);
  window.history.replaceState(null, "", url.toString());
}
