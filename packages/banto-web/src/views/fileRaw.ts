/**
 * `file.raw`（そのまま配る口）への到達先を組み立てる（spec-file-browser §5.8）。
 *
 * Tool の口（`{endpoint}/tools/{名前}` への POST）とは別の経路で、**バイトをそのまま**受け取る。
 * 別タブで開く・HTML を iframe に載せる・画像を `<img>` に出す・ダウンロードする、
 * のすべてがこの URL 1本に乗る。
 */

/** 経路の接頭辞。ホスト側（`file-raw.ts` の `RAW_PATH`）と揃える。 */
const RAW_PATH = "/raw/";

/**
 * ファイルをそのまま取る URL。
 *
 * **場所の id だけを符号化し、パスは経路のまま置く**——HTML の中の相対パスは
 * ブラウザが URL から解決するので、パスごと符号化すると資産が全部 404 になる。
 * ただし各段のファイル名は符号化する（`#` や `?` を含む名前でも壊れないように）。
 *
 * @param download true なら添付として落とす（`?dl=1`）
 */
export function fileRawUrl(
  endpoint: string,
  place: string,
  path: string,
  download = false
): string {
  const base = endpoint.replace(/\/$/, "");
  const segments = path
    .split("/")
    .filter((s) => s.length > 0 && s !== ".")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `${base}${RAW_PATH}${encodeURIComponent(place)}/${segments}${download ? "?dl=1" : ""}`;
}
