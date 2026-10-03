"use client";

// Backlog の入力。ダイアログは使わない——足すのは一覧の中でその場に打つ（Linear の素早い作成と同じ）。
//   - InlineComposer：1件足す（createItem）。Enter で足して、続けて次を打てる。Esc で閉じる
//   - SplitComposer：ストーリーをタスクに分ける（splitStory）。1行に1件、「上から順に待つ」で前の行への依存を張る
//   - ItemPicker：依存・親を選ぶ検索つきの小窓（Popover＋cmdk）
// モックなのでメモリ上の見本データに足すだけ。
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  createItem,
  splitStory,
  type BacklogItem,
  type BacklogKind,
} from "@/lib/mock/backlog";
import { ItemMark, KIND_LABEL } from "./backlog-parts";

/** 1件足す。`parent` があればそのストーリーのタスクだけ */
export function InlineComposer({
  projectId,
  milestone,
  parent,
  initialKind = "task",
  autoFocus = true,
  onCreated,
  onClose,
}: {
  projectId: string;
  milestone: string | null;
  parent?: BacklogItem;
  initialKind?: BacklogKind;
  autoFocus?: boolean;
  onCreated?: (item: BacklogItem) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<BacklogKind>(parent ? "task" : initialKind);
  const [title, setTitle] = useState("");
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit() {
    const t = title.trim();
    if (!t) return;
    const item = createItem(projectId, {
      kind,
      title: t,
      status: parent ? "ready" : "backlog",
      parent: parent?.id ?? null,
      milestone: parent ? parent.milestone : milestone,
    });
    setTitle("");
    setCount((c) => c + 1);
    onCreated?.(item);
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <div
      data-testid="backlog-composer"
      className="my-1 flex flex-col gap-2 rounded-md border border-border bg-card px-2.5 py-2 shadow-1"
    >
      <div className="flex items-center gap-2">
        <Plus className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            parent
              ? `「${parent.title}」のタスクの題`
              : `${KIND_LABEL[kind]}の題`
          }
          aria-label="足す項目の題"
          data-testid="backlog-composer-title"
          className="min-w-0 flex-1 bg-transparent text-md text-foreground outline-none placeholder:text-ink-3"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pl-5.5">
        {parent ? (
          <span className="text-xs text-ink-3">タスクとして足します</span>
        ) : (
          <div role="radiogroup" aria-label="種類" className="flex gap-1">
            {(["task", "bug", "story"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => {
                  setKind(k);
                  inputRef.current?.focus();
                }}
                data-testid={`backlog-composer-kind-${k}`}
                className={cn(
                  "rounded-sm px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring",
                  kind === k
                    ? "bg-surface-3 text-foreground"
                    : "text-ink-3 hover:text-foreground",
                )}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        )}
        <span className="text-xs text-ink-3">
          {count > 0 ? `${count} 件足しました。` : null}Enter で足す、Esc
          で閉じる
        </span>
      </div>
    </div>
  );
}

/** ストーリーをタスクに分ける。1行に1件 */
export function SplitComposer({
  projectId,
  story,
  onDone,
  onCancel,
}: {
  projectId: string;
  story: BacklogItem;
  onDone: (created: BacklogItem[]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [chain, setChain] = useState(true);
  const titles = text
    .split("\n")
    .map((l) => l.replace(/^[-*・]\s*/, "").trim())
    .filter((l) => l.length > 0);

  function submit() {
    if (titles.length === 0) return;
    const created = splitStory(
      projectId,
      story.id,
      titles.map((title, i) => ({
        title,
        waitsFor: chain && i > 0 ? [i - 1] : [],
      })),
    );
    onDone(created);
  }

  return (
    <div
      data-testid="backlog-split"
      className="flex flex-col gap-2.5 rounded-md border border-border bg-card p-3"
    >
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
        rows={4}
        placeholder={"1行に1件、タスクの題を書く\n例：設定に場所の欄を足す"}
        aria-label="分けるタスク（1行に1件）"
        data-testid="backlog-split-input"
        className="text-md"
      />
      <label className="flex items-center gap-2 text-xs text-ink-2">
        <Switch
          size="sm"
          checked={chain}
          onCheckedChange={setChain}
          data-testid="backlog-split-chain"
        />
        上から順に待つ（2行目は1行目が終わるまで始めない）
      </label>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          やめる
        </Button>
        <Button
          size="sm"
          onClick={submit}
          disabled={titles.length === 0}
          data-testid="backlog-split-submit"
        >
          {titles.length > 0
            ? `${titles.length} 件のタスクに分ける`
            : "タスクに分ける"}
        </Button>
      </div>
    </div>
  );
}

/** 項目を1つ選ぶ検索つきの小窓。依存の相手・親のストーリーに使う */
export function ItemPicker({
  candidates,
  items,
  onPick,
  placeholder,
  emptyText = "合う項目がありません",
  children,
  testId,
}: {
  candidates: readonly BacklogItem[];
  items: readonly BacklogItem[];
  onPick: (id: string) => void;
  placeholder: string;
  emptyText?: string;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild data-testid={testId}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command>
          <CommandInput placeholder={placeholder} className="text-md" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-ink-3">
              {emptyText}
            </CommandEmpty>
            <CommandGroup>
              {candidates.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.title} ${c.id}`}
                  onSelect={() => {
                    onPick(c.id);
                    setOpen(false);
                  }}
                  className="gap-2 text-md"
                >
                  <ItemMark item={c} items={items} small />
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  {c.kind !== "task" ? (
                    <span className="text-xs text-ink-3">
                      {KIND_LABEL[c.kind]}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
