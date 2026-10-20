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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { CloseIcon, ForkIcon } from "./thread-icons";
import { StartMissionDialog, useCanStartMission } from "./mission-panel";

/**
 * **「Fork を開く」と「この Fork Thread を Close」もこのメニューに入れる**（2026-10-20、ユーザー要望）——右上には
 * 文脈のメーターと「…」（携帯は検索・受信箱も）だけを並べる。渡されないときは項目を出さない
 */
export function ThreadActionsMenu({
  threadId,
  onClear,
  onCompact,
  onFork,
  onCloseFork,
}: {
  /** この会話の id（「任務にする」に使う、v4-frontend.md §6.47） */
  threadId: string;
  onClear: () => void;
  onFork?: () => void;
  onCloseFork?: () => void;
  /** hostに残らない操作はまだ繋いでいない——渡されないときは項目自体を出さない（規則13） */
  onCompact?: () => void;
}) {
  // **「任務にする」**（追加・2026-10-20、§6.47）。任務が動いていない会話だけ——自動化・見回り・判断役の Fork、読むだけの会話には
  // 出さない（host が理由を返す）
  const canStartMission = useCanStartMission(threadId);
  const [missionOpen, setMissionOpen] = useState(false);
  return (
    <>
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
        {onFork ? (
          <DropdownMenuItem onClick={onFork}>
            <ForkIcon className="size-4" />
            Fork を開く
          </DropdownMenuItem>
        ) : null}
        {onCloseFork ? (
          <DropdownMenuItem onClick={onCloseFork}>
            <CloseIcon className="size-4" />
            この Fork Thread を Close
          </DropdownMenuItem>
        ) : null}
        {onFork || onCloseFork ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onClick={onClear}>Clear</DropdownMenuItem>
        {onCompact ? <DropdownMenuItem onClick={onCompact}>Compaction</DropdownMenuItem> : null}
        {canStartMission ? <DropdownMenuItem onClick={() => setMissionOpen(true)}>任務にする</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
    <StartMissionDialog threadId={threadId} open={missionOpen} onOpenChange={setMissionOpen} />
    </>
  );
}
