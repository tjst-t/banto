"use client";

// **Root のパスは、打っても選んでもよい**（決定・2026-09-11、ユーザー要望）。
//
// 打つほうが速い人もいる（`~/worktrees/…` を覚えている）し、どこに何があったか
// 忘れているときは選びたい。**両方を1つの部品に持つ**——入力欄はそのまま、
// 右に「選ぶ」を置く。
//
// 中身（フォルダの一覧）は host が答える（`/api/fs/directories`）
// ——画面はファイルの場所を推測しない（規則3）。
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeFailure } from "@/lib/report-failure";
import { listRealDirectories, type RealDirectoryListing } from "@/lib/backend/client";

export function PathPicker({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 shrink-0 gap-1 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <FolderOpen className="size-3.5" /> 選ぶ
      </Button>
      <PickerDialog
        open={open}
        onOpenChange={setOpen}
        startAt={value}
        onPick={(path) => {
          onChange(path);
          setOpen(false);
        }}
      />
    </div>
  );
}

function PickerDialog({
  open,
  onOpenChange,
  startAt,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startAt: string;
  onPick: (path: string) => void;
}) {
  const [at, setAt] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<RealDirectoryListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((path: string | undefined) => {
    listRealDirectories(path)
      .then((next) => {
        setError(null);
        setListing(next);
      })
      // **読めなかったことを、空のフォルダに見せない**（規則2）
      .catch((err: unknown) => setError(describeFailure(err)));
  }, []);

  // 開いたときは、いま入っているパスから始める（打った途中でも、その近くへ）。
  // **開いた回数で数える**——`open` を効果の中で見て state を触ると、描画が
  // 連鎖する（lint が拾う）。ここでは「開いた瞬間に1回だけ読む」で足りる
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  if (open && openedAt === null) {
    setOpenedAt(startAt.trim() || "");
    setAt(startAt.trim() || undefined);
  }
  if (!open && openedAt !== null) setOpenedAt(null);
  useEffect(() => {
    if (openedAt === null) return;
    load(openedAt || undefined);
  }, [openedAt, load]);

  function go(path: string | undefined) {
    setAt(path);
    load(path);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="path-picker">
        <DialogHeader>
          <DialogTitle>フォルダを選ぶ</DialogTitle>
          <DialogDescription>
            いま開いている場所を、この Project の Root にします。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={!listing?.parent}
            onClick={() => go(listing?.parent)}
          >
            <CornerLeftUp className="size-3.5" /> 上へ
          </Button>
          <p
            data-testid="path-picker-current"
            className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-ink-2"
          >
            {listing?.path ?? at ?? "…"}
          </p>
        </div>

        {error ? (
          <p className="rounded-md bg-turn-soft px-2.5 py-2 text-xs text-foreground">
            このフォルダを開けません：{error}
          </p>
        ) : null}

        <div className="max-h-72 min-h-32 overflow-auto rounded-md border border-border">
          {(listing?.entries.length ?? 0) === 0 ? (
            <p className="p-4 text-center text-xs text-ink-3">
              {error ? "" : "この中にフォルダはありません"}
            </p>
          ) : (
            <ul className="flex flex-col">
              {listing!.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    data-testid="path-picker-entry"
                    onClick={() => go(entry.path)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink-2 hover:bg-accent hover:text-foreground"
                  >
                    <Folder className="size-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            やめる
          </Button>
          <Button
            type="button"
            disabled={!listing?.path}
            onClick={() => listing?.path && onPick(listing.path)}
          >
            ここにする
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
