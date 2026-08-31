"use client";

// prototype の `.spine`——Fork Thread + Canvas が両方開いているときだけ、
// Base の代わりに出る細い帯。Base も他の2枚と同じ「紙」なので、独自の背景・罫線は
// 持たない——親（panel-stack.tsx の Base の紙、bg-card）がそのまま透けて見える。
// 文言は持たない（「banto そのもの」に意味が無いという指摘を受けて削除）——
// アイコンを押すと Fork Thread が閉じ、Base に戻れる
import { PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SpineTab({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <div className="flex h-full w-8 shrink-0 flex-col items-center py-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" onClick={onOpen} aria-label={`${label} に戻る`}>
            <PanelLeftOpen className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right">{label} に戻る</TooltipContent>
      </Tooltip>
    </div>
  );
}
