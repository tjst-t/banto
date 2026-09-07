"use client";

// 会話の中から「この面を大きく開いて」と言うための通り道（§6.2、決定・2026-09-07）。
//
// inline の Canvas は会話の奥（assistant-ui の components 経由）で描かれるので、
// **props では届かない**。React の context を1本だけ通す——ここで運ぶのは
// 「開いて」という合図だけで、どこに出すかは受け取った側（Project の画面）が決める
// （§6.2「Module は『どんな面か』を宣言する。banto が『どこに出すか』を決める」）。
import { createContext, useContext } from "react";

/** `toolCallId` があれば実 Module の面、無ければモックの面。 */
export type CanvasOpener = (moduleId: string, viewId: string, toolCallId?: string) => void;

const CanvasOpenerContext = createContext<CanvasOpener | null>(null);

export const CanvasOpenerProvider = CanvasOpenerContext.Provider;

export function useCanvasOpener(): CanvasOpener | null {
  return useContext(CanvasOpenerContext);
}
