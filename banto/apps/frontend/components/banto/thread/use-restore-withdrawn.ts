"use client";

// **止めて取り消した発言を、入力欄へ戻す**（決定・2026-10-01、ユーザー要望「AI が何も出力していない間に停止ボタンを
// 押したら、確定前＝入力したプロンプトを編集中の状態に戻してほしい」。v4-frontend.md §6.31）。
//
// 取り消すかを決めるのは host（AI がまだ何も出していなければ取り消す）。adapter がその知らせを受けて
// `onTurnWithdrawn` で流すので、ここは入力欄に文字と画像を戻し、続けて直せるようにカーソルを置くだけ。

import { useEffect, type RefObject } from "react";
import { useAui } from "@assistant-ui/react";
import { useThreadId } from "@/components/banto/thread/thread-id-context";
import { onTurnWithdrawn } from "@/lib/backend/adapter";

export function useRestoreWithdrawn(inputRef: RefObject<HTMLTextAreaElement | null>): void {
  const threadId = useThreadId();
  const aui = useAui();
  useEffect(() => {
    if (!threadId) return;
    return onTurnWithdrawn((id, withdrawn) => {
      if (id !== threadId) return;
      // 止めるまでの間に打ち始めていたものは消さない——取り消した発言を前に置く
      const current = aui.composer.getState().text;
      aui.composer.setText(current.trim() === "" ? withdrawn.text : `${withdrawn.text}\n\n${current}`);
      for (const image of withdrawn.images) {
        void image
          .load()
          .then((blob) =>
            aui.composer.addAttachment(new File([blob], image.name ?? "image", { type: blob.type || "image/png" })),
          )
          // 戻せなかった画像は、添えられなかった理由として入力欄の中に出る（`composer.attachmentAddError`）。
          // 取ってこられなかったものはここで書き残す（黙らない）
          .catch((err: unknown) => console.warn("[banto] 取り消した発言の画像を入力欄へ戻せませんでした:", err));
      }
      // すぐ直せるように、入力欄の末尾にカーソルを置く（停止ボタンは消えるので、焦点が宙に浮く）
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      });
    });
  }, [aui, threadId, inputRef]);
}
