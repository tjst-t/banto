"use client";

// **書きかけのメッセージは、Thread ごとにブラウザに残す**（決定・2026-09-28、ユーザー要望
// 「別のページへ行く・設定を開いて閉じる・Fork の画面を閉じる、でも全部残してほしい」）。
//
// 入力欄の中身は assistant-ui のランタイムが持つ。ランタイムは面が作り直されるたびに新しく
// なる（ページを移る・Fork と Canvas を両方開く・記録から組み直す）ので、そこにだけ置くと
// そのたびに消える。**打つたびにここへ写し、ランタイムが作られたら戻す**。
//
// 置き場は localStorage——読み込み直しても、タブを閉じて開き直しても残る。送ったら入力欄は
// 空になるので、そのとき一緒に消える。残すのは文字だけ（添えた画像は残さない）。

import type { ThreadComposerRuntime } from "@assistant-ui/react";

const KEY_PREFIX = "banto.composerDraft.";

function read(threadId: string): string {
  try {
    return window.localStorage.getItem(KEY_PREFIX + threadId) ?? "";
  } catch (err) {
    // 読めない（保存が禁じられたブラウザ等）——書きかけが戻らないだけで、会話は使える。黙りはしない
    console.warn("[banto] 書きかけを読めませんでした:", err);
    return "";
  }
}

function write(threadId: string, text: string): void {
  try {
    if (text === "") window.localStorage.removeItem(KEY_PREFIX + threadId);
    else window.localStorage.setItem(KEY_PREFIX + threadId, text);
  } catch (err) {
    console.warn("[banto] 書きかけを残せませんでした:", err);
  }
}

/**
 * その Thread の入力欄に書きかけを戻し、以後の変化を残し続ける。返り値で止める。
 * 入力欄にすでに何かある（作り直す前から打っていた）ときは、そちらを優先する
 */
export function keepComposerDraft(threadId: string, composer: ThreadComposerRuntime): () => void {
  const saved = read(threadId);
  if (saved !== "" && composer.getState().text === "") composer.setText(saved);
  let last = composer.getState().text;
  return composer.subscribe(() => {
    const text = composer.getState().text;
    if (text === last) return;
    last = text;
    write(threadId, text);
  });
}
