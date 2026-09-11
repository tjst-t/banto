"use client";

// **このメッセージの時点から枝を分ける**（決定・2026-09-11、ユーザー要望）。
//
// 会話の奥（assistant-ui の操作の帯）には props が届かないので、context を
// 1本通す——`canvas-opener.tsx`・`thread-id-context.tsx` と同じ形。
//
// 運ぶのは「ここから分けて」という合図だけで、**どのセッションへ戻すかは host が
// 決める**（アーキ仕様 §2.2）——画面は seq を渡すだけ（規則3）。
import { createContext, useContext } from "react";

/**
 * 引数はそのメッセージの seq（host の物差し）。
 * **いま走り終わったばかりの最後の発言は seq を持たない**——記録から組み直す前は
 * host の物差しが無いため。その場合は `undefined`＝「いまの続きから」で分ける
 * （最後の発言から分けることと同じ）。
 */
export type ForkFromMessage = (seq?: number) => void;

const ForkFromMessageContext = createContext<ForkFromMessage | null>(null);

export const ForkFromMessageProvider = ForkFromMessageContext.Provider;

export function useForkFromMessage(): ForkFromMessage | null {
  return useContext(ForkFromMessageContext);
}

/**
 * assistant-ui のメッセージ id から host の seq を読む。
 * `realMessagesToInitial` が振る `real-<seq>` と**同じ規則**（規則3——
 * 記録から組み直した会話だけが、host の物差しを持っている）。
 * モックの台本や、まだ記録に落ちていない走行中の発言は持たない。
 */
export function seqOfMessageId(id: string | undefined): number | undefined {
  const match = /^real-(\d+)$/.exec(id ?? "");
  return match ? Number(match[1]) : undefined;
}
