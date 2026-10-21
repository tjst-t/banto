"use client";

// 閉じたチャット（モック・2026-10-21）。サイドバーの「閉じたチャット」を押すと開く。
// 見た目は「履歴」（archive-dialog.tsx）と同じ——検索・行を開くと中身の説明・「再度開く」。
// Project の履歴とは分ける（チャットは Project の一覧と別の欄なので）
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle, Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ArchiveRow } from "@/components/banto/archive/archive-dialog";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getClosedDrafts, getDraftSettings, reopenDraft } from "@/lib/mock/drafts";

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
  const q = query.trim().toLowerCase();
  const closed = getClosedDrafts().filter((c) => c.title.toLowerCase().includes(q));
  const { cleanup } = getDraftSettings();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
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
          {closed.length === 0 ? <p className="px-2 py-6 text-center text-xs text-ink-3">見つからない</p> : null}
          {closed.map((c) => (
            <ArchiveRow
              key={c.id}
              icon={MessageCircle}
              title={c.title}
              subtitle={`閉じた日：${c.closedAt}（${c.why}）`}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId((prev) => (prev === c.id ? null : c.id))}
              onReopen={() => {
                const id = reopenDraft(c.id);
                setQuery("");
                onOpenChange(false);
                onNavigate?.();
                if (id) router.push(`/p/${id}`);
              }}
            >
              <p className="text-xs text-ink-2">
                会話とフォルダは残っています。開き直すと話すだけの状態から始まり、試作を続けるときにコンテナを作り直します。
              </p>
            </ArchiveRow>
          ))}
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-ink-3">
          {cleanup === "off" ? "触らなくなったチャットは自動では閉じません" : `${cleanup}日触らなかったチャットは自動で閉じます`}（設定の「チャット」で変えられます）
        </p>
      </DialogContent>
    </Dialog>
  );
}
