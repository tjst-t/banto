"use client";

// 明暗切替（要件E7：選択が残る）。next-themes が localStorage に保存する。
import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // ハイドレーション不一致を避ける（サーバは theme を知らない）。
  // next-themes の標準パターン——マウント直後の1回だけ発火し、cascading render は起きない
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 上記コメント参照
    setMounted(true);
  }, []);

  const current = (mounted ? theme : "system") as keyof typeof ICONS;
  const Icon = ICONS[current] ?? Monitor;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground"
              aria-label="明暗を切り替え"
            >
              <Icon className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">明暗切替</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="size-4" /> ライト
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="size-4" /> ダーク
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="size-4" /> システム
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
