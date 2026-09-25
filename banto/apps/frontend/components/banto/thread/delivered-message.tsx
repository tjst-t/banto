"use client";

// **機械から届いたもの**（決定・2026-09-25、アーキ仕様 §4.2、`docs/specs/v4-frontend.md` §6.8）。
//
// 待たない仕事の完了（サブエージェントの `runInBackground`）など、人ではなく Module が届けたものは、会話の中で
// **人の吹き出しの形を使わない**——人が言ったように見えると、誰の意思でその続きが始まったのかを見失う
// （RFC 3834 の「機械が出した」印を、画面でも使う）。形は会話の中の「開くカード」と揃える。
//
// 本文は AI に渡した全文。人が最初に読むところ（サブエージェントの最後の返答・失敗の理由）だけを先に出し、
// 全文は開いて見る。

import { useState } from "react";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { ChevronDown, ChevronRight, Inbox } from "lucide-react";
import type { RealMessageOrigin } from "@/lib/backend/client";

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 人が最初に読むところ——構造を持った本文なら返答（`text`）か失敗の理由（`error`）。無ければ出さない */
function summaryOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as { text?: unknown; error?: unknown };
  if (typeof v.text === "string" && v.text.trim() !== "") return v.text;
  if (typeof v.error === "string") return v.error;
  return undefined;
}

export function DeliveredMessage({ origin }: { origin: RealMessageOrigin }) {
  const text = useAuiState((s) =>
    s.message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n"),
  );
  const [open, setOpen] = useState(false);
  const value = parsed(text);
  const summary = value === undefined ? text : summaryOf(value);

  return (
    <MessagePrimitive.Root
      data-role="delivered"
      data-testid="delivered-message"
      data-from={origin.from}
      className="px-2"
    >
      <div className="my-1.5 flex flex-col overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
          <Inbox className="size-3.5 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{origin.from} から届きました</span>
        </div>
        <div className="flex flex-col gap-1.5 px-3 py-2">
          <p className="text-sm font-medium text-foreground" data-testid="delivered-title">
            {origin.title}
          </p>
          {summary ? (
            <p className="line-clamp-4 text-sm whitespace-pre-wrap text-ink-2" data-testid="delivered-summary">
              {summary}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-1 self-start rounded-md text-xs text-ink-3 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            届いた中身をすべて見る
          </button>
          {open ? (
            <pre
              className="max-h-80 overflow-auto rounded-md bg-surface-2 p-2 text-xs whitespace-pre-wrap text-ink-2"
              data-testid="delivered-body"
            >
              {value === undefined ? text : JSON.stringify(value, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}
