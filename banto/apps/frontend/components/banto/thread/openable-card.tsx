"use client";

// 会話の中に残る**「ここを開く」カード**（決定・2026-09-07、ユーザー要望）。
//
// 会話の途中で開いたもの——Module の画面（MCP Apps）、分岐した Fork Thread——は、
// 閉じたら会話から辿れなくなっていた。**開いた事実はその場所に残り、押せば
// 同じものがまた開く**のが自然な形。
//
// **1つの部品にする**（規則3・規則11）。Canvas 用と Fork 用で別々のカードを
// 作ると、次に「受信箱を開く」「設定を開く」が来たときにまた増える。
// 種類ごとに変わるのは「何のアイコンで、何と書いて、押したら何を開くか」だけ。

import type { LucideIcon } from "lucide-react";

export function OpenableCard({
  icon: Icon,
  title,
  description,
  actionLabel = "開く",
  onOpen,
  testId,
  moduleName,
  children,
}: {
  icon: LucideIcon;
  title: string;
  /** 何を開くのかの手がかり（呼ばれた引数の要約・Fork のやり取り件数など） */
  description?: string;
  actionLabel?: string;
  onOpen?: () => void;
  testId?: string;
  /** E2E から「どの Module のものか」を見分けるため */
  moduleName?: string;
  /** 中身を持つカード（inline の Canvas はここに埋まる） */
  children?: React.ReactNode;
}) {
  return (
    <div
      className="my-1.5 flex flex-col overflow-hidden rounded-lg border border-border"
      data-testid={testId ?? "openable-card"}
      data-module={moduleName}
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
        <Icon className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink-2">
          {title}
          {description ? (
            <>
              {" "}
              <span aria-hidden>·</span> <span className="text-ink-3">{description}</span>
            </>
          ) : null}
        </span>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-ink-2 hover:bg-accent"
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      {children ? <div className="min-h-0">{children}</div> : null}
    </div>
  );
}
