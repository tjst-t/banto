"use client";

// **閉じたチャット**（追加・2026-10-21、v4-frontend.md §6.53。見本はモック `fork/draft-projects` の
// `mock/components/banto/shell/closed-chats-dialog.tsx`）。サイドバーの「閉じたチャット N」を押すと開く。
// 見た目は「履歴」（`archive-dialog.tsx`）と同じ——名前で検索・行を開くと中身の説明と「再度開く」。下の端に何日で自動で
// 閉じるか。Project の履歴とは分ける（チャットは Project の一覧と別の欄なので）
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageCircle, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ArchiveRow, ThreadOverviewContent } from "@/components/banto/archive/archive-dialog";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getClosedChats, reopenProject } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";
import { closeAfterSentence, useChatSettings } from "@/lib/backend/chat-settings";
import { describeFailure } from "@/lib/report-failure";

export function ClosedChatsDialog({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate?: () => void;
}) {
  useMockStoreVersion();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();
  const { settings, error } = useChatSettings();
  const q = query.trim().toLowerCase();
  const closed = getClosedChats().filter((c) => c.name.toLowerCase().includes(q));

  async function reopen(id: string) {
    try {
      await reopenProject(id);
      setQuery("");
      onOpenChange(false);
      onNavigate?.();
      router.push(`/p/${id}`);
    } catch (err) {
      toast.error("チャットを開き直せませんでした", { description: describeFailure(err) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg" data-testid="closed-chats-dialog">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4 text-ink-3" />
            閉じたチャット
          </DialogTitle>
        </DialogHeader>
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名前で検索"
              className="h-8 pl-8"
              autoFocus
            />
          </div>
        </div>
        <div ref={containerRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          {closed.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-ink-3">{q ? "見つからない" : "閉じたチャットはまだ無い"}</p>
          ) : null}
          {closed.map((chat) => {
            const base = getThread(chat.baseThreadId);
            return (
              <ArchiveRow
                key={chat.id}
                icon={MessageCircle}
                title={chat.name}
                {...(chat.closedAt ? { subtitle: `閉じた日：${chat.closedAt}` } : {})}
                expanded={expandedId === chat.id}
                onToggle={() => setExpandedId((prev) => (prev === chat.id ? null : chat.id))}
                onReopen={() => void reopen(chat.id)}
              >
                {base ? <ThreadOverviewContent thread={base} /> : null}
                <p className="text-xs text-ink-2">
                  会話とフォルダは残っています。開き直すと話すだけの状態から始まり、試作を続けるときにコンテナを作り直します。
                </p>
              </ArchiveRow>
            );
          })}
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-ink-3" data-testid="closed-chats-auto-close">
          {settings
            ? `${closeAfterSentence(settings)}（設定の「チャット」で変えられます）`
            : error
              ? `自動で閉じるまでの日数を読めませんでした（${error}）`
              : "自動で閉じるまでの日数を読んでいます…"}
        </p>
      </DialogContent>
    </Dialog>
  );
}
