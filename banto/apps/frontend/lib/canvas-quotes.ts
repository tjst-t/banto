"use client";

// **Module の画面から会話の入力欄へ渡された文**（MCP Apps の `ui/message`、v4-frontend.md §6.2「画面から会話の入力欄へ
// 文を渡す」、Backlog #307、2026-10-15）。
//
// 画面（`module-canvas.tsx`）が受けた文は、**その画面を開いた会話の入力欄の上に「添付」の塊として置くだけ**——送るのは人。
// 人の書きかけとは混ぜない。塊は assistant-ui の添付（独自の type）として持つ：送信ボタンが文の無いときも押せ、送った
// 発言にもそのまま残り、送るとき adapter が host へ `quotes` として渡す（host が出所つきの引用として AI に渡す）。
//
// - **1枚の画面から1つ**：同じ画面（`slot`）から新しいものが来たら、前のものを置き換える
// - 出所（Module の名前・第三者か）は添付の id に持たせる——添付には任意の項目を足せないため。第三者かどうかの
//   **正は host**（送ったときに host が自分の宣言から決め直す）。ここの値は入力欄で強く出すためだけ
// - **会話の面が開いていない**（別タブで開いた画面・会話を閉じている）ときは、その Thread の書きかけに入れる
//   （会話を開けば出る、`composer-drafts.ts`）

import type { CreateAttachment, ThreadComposerRuntime } from "@assistant-ui/react";

/** 添付の type。assistant-ui は任意の文字列を許す */
export const CANVAS_QUOTE_TYPE = "banto-canvas-quote";
/** 添付の contentType。入力欄の受け皿（`image-attachment.ts`）はこれだけを画像のほかに受ける */
export const CANVAS_QUOTE_CONTENT_TYPE = "application/vnd.banto.canvas-quote";
/** 1つの塊の長さ。**正は host**（`packages/core/src/http/canvas-quotes.ts`）——ここは受ける前に断るために同じ値を持つ */
export const CANVAS_QUOTE_MAX_CHARS = 20_000;
const ID_PREFIX = "canvas-quote:";

export interface CanvasQuote {
  /** 出所の Module（宣言上の名前） */
  module: string;
  /** 第三者の Module か（入力欄で強く出す） */
  thirdParty: boolean;
  /** どの画面から来たか。同じ画面からのものは1つにする */
  slot: string;
  text: string;
}

/** 塊の出所を人に見せる1行。**第三者は強く言う** */
export function quoteSourceLabel(quote: Pick<CanvasQuote, "module" | "thirdParty">): string {
  return quote.thirdParty ? `第三者の Module「${quote.module}」の画面から` : `${quote.module} の画面から`;
}

export function quoteToAttachment(quote: CanvasQuote): CreateAttachment {
  return {
    id: ID_PREFIX + JSON.stringify({ module: quote.module, thirdParty: quote.thirdParty, slot: quote.slot }),
    type: CANVAS_QUOTE_TYPE,
    name: quoteSourceLabel(quote),
    contentType: CANVAS_QUOTE_CONTENT_TYPE,
    content: [{ type: "text", text: quote.text }],
  };
}

/** 添付が画面からの塊なら、その中身。違えば undefined */
export function quoteFromAttachment(attachment: {
  id: string;
  type: string;
  content?: readonly { type: string; text?: string }[] | undefined;
}): CanvasQuote | undefined {
  if (attachment.type !== CANVAS_QUOTE_TYPE || !attachment.id.startsWith(ID_PREFIX)) return undefined;
  try {
    const meta = JSON.parse(attachment.id.slice(ID_PREFIX.length)) as { module?: unknown; thirdParty?: unknown; slot?: unknown };
    if (typeof meta.module !== "string" || typeof meta.slot !== "string") return undefined;
    const text = (attachment.content ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    // 出所が読めないものは第三者として扱う（弱く出さない）
    return { module: meta.module, thirdParty: meta.thirdParty !== false, slot: meta.slot, text };
  } catch {
    return undefined;
  }
}

// ── 入れる先 ─────────────────────────────────────────────────────────────

/** 開いている会話の入力欄（Thread ごと）。会話の面が作られたら登録される（`thread-panel.tsx`） */
const composers = new Map<string, ThreadComposerRuntime>();

export function registerQuoteComposer(threadId: string, composer: ThreadComposerRuntime): () => void {
  composers.set(threadId, composer);
  return () => {
    if (composers.get(threadId) === composer) composers.delete(threadId);
  };
}

/** 開いている会話の入力欄（無ければ undefined） */
export function openComposerOf(threadId: string): ThreadComposerRuntime | undefined {
  return composers.get(threadId);
}

/** その入力欄から、同じ画面から来た前の塊を外す */
async function removeSameSlot(composer: ThreadComposerRuntime, slot: string): Promise<void> {
  const attachments = composer.getState().attachments;
  for (let i = attachments.length - 1; i >= 0; i--) {
    const quote = quoteFromAttachment(attachments[i]!);
    if (quote?.slot === slot) await composer.getAttachmentByIndex(i).remove();
  }
}

/**
 * **その Thread の入力欄の上に塊を置く**。会話の面が開いていなければ書きかけに入れる。同じ画面からの前の塊は置き換える。
 * 送りはしない
 */
export async function placeCanvasQuote(threadId: string, quote: CanvasQuote): Promise<void> {
  const composer = composers.get(threadId);
  if (!composer) {
    const saved = readDraftQuotes(threadId).filter((q) => q.slot !== quote.slot);
    writeDraftQuotes(threadId, [...saved, quote]);
    return;
  }
  await removeSameSlot(composer, quote.slot);
  await composer.addAttachment(quoteToAttachment(quote));
}

// ── 書きかけの塊（localStorage） ─────────────────────────────────────────

const DRAFT_PREFIX = "banto.composerQuotes.";

export function readDraftQuotes(threadId: string): CanvasQuote[] {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + threadId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (q): q is CanvasQuote =>
        typeof q === "object" && q !== null && typeof q.module === "string" && typeof q.slot === "string" && typeof q.text === "string",
    ).map((q) => ({ ...q, thirdParty: q.thirdParty !== false }));
  } catch (err) {
    // 読めない（保存が禁じられたブラウザ等）——塊が戻らないだけで、会話は使える。黙りはしない
    console.warn("[banto] 書きかけの塊を読めませんでした:", err);
    return [];
  }
}

export function writeDraftQuotes(threadId: string, quotes: readonly CanvasQuote[]): void {
  try {
    if (quotes.length === 0) window.localStorage.removeItem(DRAFT_PREFIX + threadId);
    else window.localStorage.setItem(DRAFT_PREFIX + threadId, JSON.stringify(quotes));
  } catch (err) {
    console.warn("[banto] 書きかけの塊を残せませんでした:", err);
  }
}
