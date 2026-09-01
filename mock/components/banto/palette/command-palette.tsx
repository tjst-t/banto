"use client";

// Command Palette（Ctrl-K、§6.3）——「あらゆるものへの1つの入口」。
// 自分の索引を持たない：出るものは Project/Thread・受信箱・Module集合から
// 導出する（`lib/mock/palette.ts`）。banto 全体を検索する Project/Thread・
// 受信箱と、いまの Project に限る Module の入口・資源は範囲が違う（§6.3「範囲」）。
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { buildPaletteGroups, type PaletteItem } from "@/lib/mock/palette";
import type { UsePanelStackResult } from "@/components/banto/shell/use-panel-stack";

export function CommandPalette({
  projectId,
  open,
  onOpenChange,
  stack,
}: {
  /** null＝いま Project の外（/settings 等）を見ている */
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** operation 実行に使う。projectId が無いページでは undefined */
  stack?: UsePanelStackResult;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => buildPaletteGroups(projectId, query), [projectId, query]);

  // usePanelStack.open() は呼ぶたびに「そのレンダーの searchParams」から
  // 新しい URL を組み立てて router.push する。同じイベントハンドラの中で
  // open() を2回続けて呼ぶと、2回目は1回目の変更をまだ知らない（React が
  // 間で再レンダーしていない）ので、1回目の変更を踏みつぶす——だから
  // 「操作を実行する」と「パレットを閉じる（overlay を消す）」は、
  // **必ず1回の open() 呼び出しにまとめる**（overlay: null を一緒に渡す）
  function runOperation(actionId: string) {
    switch (actionId) {
      case "open-fork":
        stack?.open({ fork: "ui", overlay: null });
        break;
      case "open-canvas":
        stack?.open({ canvas: { moduleId: "banto.repo", viewId: "diff" }, overlay: null });
        break;
      case "open-inbox":
        stack?.open({ overlay: "inbox" });
        break;
      case "open-project-settings":
        stack?.open({ overlay: "settings-project" });
        break;
      case "open-instance-settings":
        router.push("/settings");
        break;
    }
    setQuery("");
  }

  function select(item: PaletteItem) {
    if (item.href) {
      // href は常に新しい URL 全体（overlay=palette を含まない）を指すので、
      // 遷移だけで閉じたことになる——ここで追加の open()/close() を呼ばない
      router.push(item.href);
      setQuery("");
    } else if (item.kind === "operation" && item.actionId) {
      runOperation(item.actionId);
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        // Escape・外側クリックで CommandDialog 自身が閉じるときも検索語を
        // 残さない（次に Ctrl-K で開いたとき、前回の検索が残ると紛らわしい）
        if (!next) setQuery("");
        onOpenChange(next);
      }}
      title="Command Palette"
      description="Project・Thread・受信箱・Module の入口・操作を検索する"
    >
      {/* 固定高さにしない——中身が短いと下に空白が残る。CommandList 側の
          max-h-72（既定）＋overflow-y-auto が、多いときのスクロールを持つ */}
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="検索、または移動先・操作を選ぶ…"
        />
        <CommandList>
          {groups.every((g) => g.items.length === 0) ? (
            <CommandEmpty>見つからない</CommandEmpty>
          ) : null}
          {groups.map((g) => (
            <CommandGroup key={g.kind} heading={g.label}>
              {g.items.map((item) => (
                <CommandItem key={item.id} value={item.id} onSelect={() => select(item)}>
                  <item.icon className="size-4 text-ink-3" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.title}</span>
                    {item.subtitle ? (
                      <span className="truncate text-xs text-ink-3">{item.subtitle}</span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
