// **composer に画像を添える**（決定・2026-09-26、ユーザー要望「入力欄に画像を貼り付けたい」）。
// 貼り付け・＋ボタン・ドラッグの3つとも、この1つを通る（assistant-ui の添付の受け皿）。
//
// 中身は assistant-ui の SimpleImageAttachmentAdapter のまま（送るときに data URL にする）——
// banto が足すのは「送れるものを絞る」ことだけ。data URL の base64 は `adapter.ts` が host へ渡す。

import { SimpleImageAttachmentAdapter } from "@assistant-ui/react";

/**
 * 送れる形式と大きさ。**正は host**（`packages/core/src/images/store.ts`）——ここは
 * **送る前に知らせる**ために同じ値を持つだけ。食い違っても host が理由をつけて断る（黙らない）。
 * 形式は AI（Claude の画像入力）が読めるものだけ
 */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class ImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
  override accept = IMAGE_ACCEPT;

  override async add(state: { file: File }) {
    if (state.file.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `画像が大きすぎます（${(state.file.size / 1024 / 1024).toFixed(1)}MB、1枚 ${MAX_IMAGE_BYTES / 1024 / 1024}MB まで）`,
      );
    }
    return super.add(state);
  }
}

/** 添えられなかった理由を、人に読める文にする（assistant-ui の既定の文は英語で、形式の列挙がそのまま出る） */
export function describeAttachmentAddError(reason: string, message: string): string {
  if (reason === "not-accepted") return "添えられるのは画像（PNG・JPEG・GIF・WebP）だけです";
  if (reason === "no-adapter") return "この会話には画像を添えられません";
  return message;
}
