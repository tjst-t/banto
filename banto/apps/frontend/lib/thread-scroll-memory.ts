"use client";

// **会話をどこまで見ていたか**を、Thread ごとに覚える（決定・2026-09-28、ユーザー要望
// 「Canvas や Fork を閉じたときは、スレッドの位置は保存してほしい」）。
//
// 会話の面は作り直されることがある——Fork と Canvas を両方開くと Base は帯だけになって描かれなく
// なり、閉じると新しく作られる。記録から組み直したときも同じ。作り直された面は、ふつうは一番下
// （最新）から始まるので、読んでいた場所を失う。**見ていた場所をここに持ち、作り直されたら戻す**。
//
// **ピクセルではなく「どのメッセージの、どのあたり」で覚える**。Canvas を開くと会話は細くなって
// 折り返しが変わる——細いときに覚えた scrollTop を元の幅で当てると、別の場所へ行く
// （実測・2026-09-28：720px ずれた）。
//
// 覚えるのは **同じ Project の画面に居るあいだだけ**。Project の画面を離れたら（別の Project・設定へ
// 行った）忘れる——Thread を開いたら一番下、が基本（ユーザー要望）。

export interface ScrollAnchor {
  /** 器の上端にかかっているメッセージ（`data-message-id`） */
  messageId: string;
  /** そのメッセージが上から何番目か——組み直すと id が変わるので、見つからなければこちらで探す */
  index: number;
  /** 器の上端が、そのメッセージの高さのどこにあるか（0＝メッセージの上端、1＝下端） */
  ratio: number;
}

/** `"bottom"`＝一番下（最新）を見ていた。それ以外は、見ていたメッセージとその中の位置 */
export type RememberedScroll = "bottom" | ScrollAnchor;

const positions = new Map<string, RememberedScroll>();

export function rememberThreadScroll(threadId: string, position: RememberedScroll): void {
  positions.set(threadId, position);
}

export function recalledThreadScroll(threadId: string): RememberedScroll | undefined {
  return positions.get(threadId);
}

/** Project の画面を離れた——次に開く会話は一番下から */
export function forgetThreadScrolls(): void {
  positions.clear();
}
