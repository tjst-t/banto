// **画面から会話の入力欄へ文を渡す**（MCP Apps の `ui/message`、v4-frontend.md §6.2「画面から会話の入力欄へ文を渡す」、
// Backlog #307、2026-10-15）。受けてよいかを決める——入れる先は `lib/canvas-quotes.ts`、受け口は `module-canvas.tsx`。
//
// - **会話の中の画面からだけ**（Thread が持ち主の画面）。会話の外（launcher・設定・新しい Project の画面）には返す先が無い
// - **人が画面の中を押した直後だけ**（一時的な利用者の操作）——画面が開いた途端に勝手に入れさせない
// - 受けるのは `role: "user"` の `text` だけ（画像・資源は断る）、1回 20,000 字まで
//
// 断るときは理由を返す（受け口は `isError` で返し、理由は開発者向けに書き残す）

import { CANVAS_QUOTE_MAX_CHARS } from "../canvas-quotes.ts";

export function decideCanvasMessage(input: {
  /** 会話の中の画面か（持ち主が Thread） */
  fromConversation: boolean;
  /** 人がその画面を押した直後か */
  activated: boolean;
  role: unknown;
  content: unknown;
}): { text: string } | { error: string } {
  if (!input.fromConversation) return { error: "会話の外の画面からは受けません（返す先の会話がありません）" };
  if (!input.activated) return { error: "人が画面の中を押した直後でなければ受けません" };
  if (input.role !== "user") return { error: `role は user だけを受けます（${String(input.role)}）` };
  if (!Array.isArray(input.content) || input.content.length === 0) return { error: "中身がありません" };
  const texts: string[] = [];
  for (const block of input.content as unknown[]) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type !== "text" || typeof b.text !== "string") return { error: "受けるのは文（text）だけです" };
    texts.push(b.text);
  }
  const text = texts.join("\n\n");
  if (text.trim() === "") return { error: "中身が空です" };
  if (text.length > CANVAS_QUOTE_MAX_CHARS) return { error: `長すぎます（${CANVAS_QUOTE_MAX_CHARS} 字まで、いまは ${text.length} 字）` };
  return { text };
}
