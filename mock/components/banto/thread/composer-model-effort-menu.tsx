"use client";

// 入力欄の「＋」の右に置く、モデル／エフォート選択（§2.6 runtime config の
// instance/Project 既定と同じ値域だが、ここは Thread 単位の一時的な上書き
// ——送信前にその場で変えられる、という操作をモックで見せる）。
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MOCK_EFFORT_LEVELS, MOCK_MODELS } from "@/lib/mock/settings";
import { ChevronDownIcon } from "lucide-react";

export function ComposerModelEffortMenu({
  defaultModel,
  defaultEffort,
}: {
  defaultModel: string;
  defaultEffort: (typeof MOCK_EFFORT_LEVELS)[number];
}) {
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<(typeof MOCK_EFFORT_LEVELS)[number]>(defaultEffort);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="モデルと reasoning effort を選択"
          className="text-ink-3 hover:text-foreground hover:bg-muted-foreground/15 flex h-7 items-center gap-1 rounded-full px-2 text-xs"
        >
          <span>{model}</span>
          <span className="text-ink-3/70">·</span>
          <span>{effort}</span>
          <ChevronDownIcon className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>モデル</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={model} onValueChange={setModel}>
          {MOCK_MODELS.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {m}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Effort</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={effort}
          onValueChange={(v) => setEffort(v as (typeof MOCK_EFFORT_LEVELS)[number])}
        >
          {MOCK_EFFORT_LEVELS.map((e) => (
            <DropdownMenuRadioItem key={e} value={e}>
              {e}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
