"use client";

// Thread の運用操作（§2.2 冒頭の表——畳む・やり直す等と同じ列）。
// 「会話を畳む」は Base Thread のためのもの（同じ Thread のまま resume-point
// を捨てて整理する）。Fork Thread を丸ごと閉じる操作は別物
// （ヘッダーの GitMerge アイコン、closed-forks-panel 参照）——同じ「畳む」
// という語でも、Base では継続、Fork では終了という違う意味を持つ。
// 圧縮（compaction）は SDK 側が自動で発火するものだが（§3）、いつ効いたかを
// 見えるようにする窓口としてここに置く——実際の圧縮ロジックはモックしない。
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThreadActionsMenu({ canClear = true }: { canClear?: boolean }) {
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(t);
  }, [note]);

  return (
    <div className="flex items-center gap-2">
      {note ? <span className="text-xs text-ink-3">{note}</span> : null}
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
          {canClear ? (
            <DropdownMenuItem
              onClick={() => setNote("会話を畳みました——次の発言から新しい文脈で続きます")}
            >
              会話を畳む（Clear）
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setNote("圧縮しました（モック——実際の発火は SDK 側、§3）")}>
            圧縮する（Compact）
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
