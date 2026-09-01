"use client";

// Thread の運用操作（§2.2 冒頭の表——畳む・やり直す等と同じ列）。
// 用語は Claude Code 自身のコマンド名に合わせる（Clear／Compaction）——
// 「畳む」という訳語は Fork Thread を閉じる操作（GitMerge アイコン、
// archive-dialog 参照）だけで使い、ここでは使わない（同じ語が2つの
// 意味を持つのを避ける、レビュー指摘 2026-09-01）。
// 結果はヘッダーには出さない——チャット欄に横線として残す
// （thread-panel.tsx の ThreadMarkers、composerHint 経由）
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";

export function ThreadActionsMenu({
  onClear,
  onCompact,
}: {
  onClear: () => void;
  onCompact: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Thread の操作"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onClear}>Clear</DropdownMenuItem>
        <DropdownMenuItem onClick={onCompact}>Compaction</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
