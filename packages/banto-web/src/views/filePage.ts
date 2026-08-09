/**
 * 別タブで開く1枚（`FilePage`）への到達先（spec-file-browser §5.8.4）。
 *
 * **別タブは「そのまま配る口」ではなく、整形して読む1枚へ送る**（PO要望 2026-08-09：
 * 「別タブではマークダウンに限らずすべてプレビュー表示にしてほしい」）。`file.raw` へ
 * 直に送ると、md も ts も `text/plain`（§5.8.2）——ブラウザは**原文しか出せない**。
 *
 * 依存を持たない純粋関数だけを置く（node:test から読めるように）。DOM は呼ぶ側が渡す。
 */

/** 別タブの1枚が要るもの。どれか欠けたら「別タブの位置ではない」と見なす。 */
export interface FilePageTarget {
  /** データを取りに行くモジュールの到達先（例 `/api/workspace`）。 */
  endpoint: string;
  /** 場所の id。 */
  place: string;
  /** 場所の中の相対パス。 */
  path: string;
}

/** URL に載せるキー。他のクエリ（`host=` 等）は触らない。 */
const KEY_PATH = "file";
const KEY_PLACE = "place";
const KEY_ENDPOINT = "ep";

/**
 * **自分のオリジンの中しか指させない**。
 *
 * 到達先を URL に載せるのは、面が持っている値をそのまま渡すため（決定25：エンドポイントを
 * コンポーネントに直書きしない）。ただし**受け取る側は疑う**——`//evil.example` は
 * プロトコル相対＝別のオリジンなので、`/` 始まりというだけでは足りない。
 * 逆斜線もブラウザによっては `/` として解かれるので、通す字を絞る。
 */
function isSameOriginPath(value: string): boolean {
  return /^\/(?!\/)[\w\-./%~]*$/.test(value);
}

/**
 * 別タブで開く1枚の URL。
 *
 * @param basePath いま配られている経路（`window.location.pathname`）。中継の下でも効くように
 *   呼ぶ側から渡す
 */
export function filePageUrl(
  basePath: string,
  endpoint: string,
  place: string,
  path: string
): string {
  const params = new URLSearchParams();
  params.set(KEY_PATH, path);
  params.set(KEY_PLACE, place);
  params.set(KEY_ENDPOINT, endpoint);
  return `${basePath}?${params.toString()}`;
}

/**
 * クエリから別タブの1枚の宛先を読む。**別タブの位置でなければ undefined**
 * （呼ぶ側はいつもの画面を出す）。
 */
export function parseFilePageTarget(search: string): FilePageTarget | undefined {
  const params = new URLSearchParams(search);
  const path = params.get(KEY_PATH);
  const place = params.get(KEY_PLACE);
  const endpoint = params.get(KEY_ENDPOINT);
  if (!path || !place || !endpoint) return undefined;
  // I2: 外を指す到達先は黙って自分のオリジンへ読み替えず、位置として認めない
  if (!isSameOriginPath(endpoint)) return undefined;
  return { endpoint, place, path };
}
