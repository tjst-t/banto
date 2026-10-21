"use client";

// 新しいチャットの画面（モック・2026-10-21、Fork「Project 作成前の検討」）。
// **ここではまだ何も作らない**——開いただけで閉じても、Project もコンテナも残らない。
// 最初の書き込みを送った時点で Project（チャット）を作り、その会話へ移る。題は AI が書き込みから付ける
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { startDraftWithMessage } from "@/lib/mock/drafts";
import { cn } from "@/lib/utils";

export function NewChatPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0;

  function send() {
    if (!canSend) return;
    const p = startDraftWithMessage(text.trim());
    router.push(`/p/${p.id}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
        {isMobile ? <MobileNavDrawer projectId={null} /> : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">新しいチャット</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4">
        <div className="flex w-full max-w-[44rem] flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-medium tracking-tight">何について話しますか？</h1>
            <p className="max-w-md text-sm text-ink-3">
              話して調べるだけならコンテナは作りません。試作を始めたら作り、まとまったら「Project にする」でそのまま続けられます。
            </p>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="flex flex-col gap-2 rounded-3xl border border-border bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/40"
          >
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="メッセージを書く"
              aria-label="最初のメッセージ"
              className="min-h-16 resize-none bg-transparent px-3 py-2 text-base outline-none placeholder:text-ink-3"
            />
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="text-xs text-ink-3">送るとチャットができ、AI が題を付けます</span>
              <button
                type="submit"
                disabled={!canSend}
                aria-label="送る"
                className={cn(
                  "flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity",
                  !canSend && "opacity-40",
                )}
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
