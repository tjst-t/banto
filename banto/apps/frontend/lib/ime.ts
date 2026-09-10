// **日本語入力の「変換確定」の Enter を、送信の Enter と取り違えない**
// （決定・2026-09-10、`memory-input-ime-enter`）。
//
// IME で変換中に Enter を押すと「いま出ている候補で確定する」という意味になる。
// ここで送信してしまうと、**まだ書き終えていない文が送られる**——Memory は
// 追記オンリー（取り消し線でしか消せない、アーキ仕様 §2.2）なので実害が残る。
//
// 見るのは `isComposing`（変換中かどうか、DOM の標準）。古いブラウザ向けの
// `keyCode === 229` と、Safari が出す `key === "Process"` も一緒に見る
// ——3つとも「まだ変換の途中」を表す言い方の違いでしかない。

import type { KeyboardEvent } from "react";

export function isImeComposing(event: KeyboardEvent): boolean {
  const native = event.nativeEvent as KeyboardEvent["nativeEvent"] & { isComposing?: boolean };
  return native.isComposing === true || event.key === "Process" || native.keyCode === 229;
}
