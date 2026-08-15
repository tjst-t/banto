/**
 * 会話を切り替えたとき、入力欄へ自動でフォーカスして良いか（PO報告 2026-08-15）。
 *
 * **画面幅では判定しない**——ウィンドウを狭くしただけの PC が巻き込まれ、物理キーボードの
 * ある環境で「切り替えたらすぐ打てる」が失われる。見るのは**ポインタの種別**。
 *
 * 2本立てで見る：`(pointer: coarse)` だけだと拾えない端末があり、`(hover: none)` だけだと
 * スタイラス等（hover は無いが pointer は fine）で外れる。どちらかが真ならタッチ扱いにする。
 */
export function prefersNoAutoFocus(): boolean {
  const matchMedia = (globalThis as { matchMedia?: (query: string) => { matches: boolean } })
    .matchMedia;
  // SSR・古いブラウザ・試験環境では matchMedia が無い。握り潰さず、従来どおりの PC 挙動（false）に倒す
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(pointer: coarse)").matches || matchMedia("(hover: none)").matches;
}
