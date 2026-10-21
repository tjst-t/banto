"use client";

// **新しいチャットの画面**（追加・2026-10-21、v4-frontend.md §6.53。見本はモック `fork/draft-projects` の
// `mock/app/chat/new/new-chat-page.tsx`）。
//
// **ここではまだ何も作らない**——開いただけで離れても、Project もフォルダも残らない。最初の書き込みを送ったときに初めて
// チャットを作り（`POST /api/projects { kind: "chat" }`）、同じ書き込みを最初のターンとして送って、その会話へ移る。題は
// host が最初のターンのあとで付ける（それまでサイドバーの行は「題を考えています…」）。
// 作れなかったら書き込みを入力欄に残して理由を出す。作れたが送れなかったら、書き込みをその会話の入力欄へ戻して移る
// （チャットはもうある——黙って捨てない、規則2）
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileNavButton } from "@/components/banto/shell/mobile-nav-drawer";
import { placeComposerText } from "@/lib/composer-drafts";
import { isImeComposing } from "@/lib/ime";
import { startChat } from "@/lib/mock/projects";
import { describeFailure } from "@/lib/report-failure";
import { Button } from "@/components/ui/button";

export function NewChatContent() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSend = text.trim().length > 0 && !busy;

  async function send() {
    if (!canSend) return;
    const message = text.trim();
    setBusy(true);
    setError(null);
    let started;
    try {
      started = await startChat(message);
    } catch (err) {
      setError(describeFailure(err));
      setBusy(false);
      return;
    }
    if (started.sendError !== undefined) {
      placeComposerText(started.project.baseThreadId, message);
      toast.error("チャットはできましたが、最初の書き込みを送れませんでした", {
        description: `${describeFailure(started.sendError)}（書き込みは入力欄に戻しました）`,
      });
    }
    router.push(`/p/${started.project.id}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
        {isMobile ? <MobileNavButton /> : null}
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
              void send();
            }}
            className="flex flex-col gap-2 rounded-3xl border border-border bg-card p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/40"
          >
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={busy}
              rows={2}
              placeholder="メッセージを書く"
              aria-label="最初のメッセージ"
              className="min-h-16 resize-none bg-transparent px-3 py-2 text-md outline-none placeholder:text-ink-3"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <span className="text-xs text-ink-3">{busy ? "チャットを作っています…" : "送るとチャットができ、AI が題を付けます"}</span>
              {/* 会話の入力欄の送るボタンと同じ形 */}
              <Button type="submit" variant="default" size="icon" disabled={!canSend} aria-label="送る" className="size-8 shrink-0 rounded-full">
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </form>
          {error ? (
            <p className="text-center text-sm text-destructive" role="alert" data-testid="new-chat-error">
              チャットを作れませんでした（{error}）
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
