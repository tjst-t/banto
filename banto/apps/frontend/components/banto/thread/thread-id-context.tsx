"use client";

// **いま描いているのは、どの Thread か**（`frontend-interaction-hardening`、
// 2026-09-10）。
//
// 会話の奥（assistant-ui の components 経由で描かれる tool のカード）には
// props が届かないので、context を1本通す——`canvas-opener.tsx` と同じ形。
//
// これが要る理由：**Fork は親の履歴をそのまま持つ**ので、Base と Fork の
// 会話には**同じ toolCallId** が並ぶ。「どの呼び出しか」だけでは、その画面が
// どちらの Thread のものか決まらない（実測・2026-09-10：Fork を開くと
// Base の画面が Fork のものとして扱われ、橋が張り直されていた）。
import { createContext, useContext } from "react";

const ThreadIdContext = createContext<string | null>(null);

export const ThreadIdProvider = ThreadIdContext.Provider;

export function useThreadId(): string | null {
  return useContext(ThreadIdContext);
}
