"use client";

// Root パスは打っても選んでもよい——本実装（`banto/apps/frontend/components/banto/
// settings/path-picker.tsx`）の形を写したもの。中身のフォルダ一覧は固定の木
// （本物は host が `/api/fs/directories` で答える）——`lib/mock/github.ts` のフォルダの一覧から導く。
import { useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, FolderPlus, ShieldAlert } from "lucide-react";
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
import { folderExists, listChildFolders, normalizeFolderPath, parentFolder } from "@/lib/mock/github";

/** フォルダの木の引き方。既定はこの機械（別のサーバでは SSH で名前だけを引く——`lib/mock/runtimes.ts`） */
export interface FolderSource {
  exists: (path: string) => boolean;
  list: (path: string) => string[];
  /** どこのフォルダか（選ぶ画面の題に出す。この機械なら無し） */
  where?: string;
}

const HOST_SOURCE: FolderSource = { exists: folderExists, list: listChildFolders };

export function PathPicker({
  id,
  value,
  onChange,
  autoFocus,
  pickerDescription = "いま開いている場所を、この Project の Root にします。",
  source = HOST_SOURCE,
  allowNewFolder = false,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  autoFocus?: boolean;
  /** 「フォルダを選ぶ」の説明文（何のために選ぶか） */
  pickerDescription?: string;
  source?: FolderSource;
  /** 「新しいフォルダ」を出す。作るのは選んだあと（移すときに banto が作る）——ここでは名前を決めるだけ */
  allowNewFolder?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
        autoFocus={autoFocus}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1 px-2 text-xs"
        onClick={() => setOpen(true)}
      >
        <FolderOpen className="size-3.5" /> 選ぶ
      </Button>
      {open ? (
        <PickerDialog
          startAt={value}
          description={pickerDescription}
          source={source}
          allowNewFolder={allowNewFolder}
          onClose={() => setOpen(false)}
          onPick={(path) => {
            onChange(path);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function PickerDialog({
  startAt,
  description,
  source,
  allowNewFolder,
  onClose,
  onPick,
}: {
  startAt: string;
  description: string;
  source: FolderSource;
  allowNewFolder: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  // いま入っているパスから始める。知らない場所なら home から
  const [at, setAt] = useState(() => {
    const start = normalizeFolderPath(startAt);
    return source.exists(start) ? start : "~";
  });
  /** まだ無い（これから作る）フォルダ。そこに居る間はその中は空 */
  const [pending, setPending] = useState<string[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const isPending = (p: string) => pending.some((n) => n === p || p.startsWith(`${n}/`));
  const entries = isPending(at)
    ? pending.filter((n) => parentFolder(n) === at).map((n) => n.slice(at.length + 1))
    : [...new Set([...source.list(at), ...pending.filter((n) => parentFolder(n) === at).map((n) => n.slice(at.length + 1))])].sort();
  const parent = parentFolder(at);
  const nameError =
    naming === null || naming.trim() === ""
      ? undefined
      : /[/\\]/.test(naming) || naming.trim() === "." || naming.trim() === ".."
        ? "名前に / や .. は使えません"
        : entries.includes(naming.trim())
          ? "同じ名前のフォルダがあります"
          : undefined;
  function addFolder() {
    if (!naming || !naming.trim() || nameError) return;
    const path = `${at}/${naming.trim()}`;
    setPending((p) => [...p, path]);
    setNaming(null);
    setAt(path);
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{source.where ? `${source.where} のフォルダを選ぶ` : "フォルダを選ぶ"}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            disabled={!parent}
            onClick={() => parent && setAt(parent)}
          >
            <CornerLeftUp className="size-3.5" /> 上へ
          </Button>
          <p className="min-w-0 flex-1 truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-ink-2">
            {at}
            {isPending(at) ? <span className="ml-1.5 font-sans text-ink-3">（新しく作る）</span> : null}
          </p>
          {allowNewFolder ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs"
              onClick={() => setNaming("")}
              data-testid="path-picker-new-folder"
            >
              <FolderPlus className="size-3.5" /> 新しいフォルダ
            </Button>
          ) : null}
        </div>
        {naming !== null ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={naming}
                placeholder="フォルダの名前"
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addFolder();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setNaming(null);
                  }
                }}
                className="h-8 text-xs"
                aria-label="新しいフォルダの名前"
              />
              <Button type="button" size="sm" className="h-8 shrink-0 text-xs" disabled={!naming.trim() || !!nameError} onClick={addFolder}>
                作る
              </Button>
              <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={() => setNaming(null)}>
                やめる
              </Button>
            </div>
            <p className={nameError ? "text-xs text-stop" : "text-xs text-ink-3"}>
              {nameError ?? `${at} の中に作ります。実際に作るのは、移すのを押したときです。`}
            </p>
          </div>
        ) : null}

        <div className="max-h-72 min-h-32 overflow-auto rounded-md border border-border">
          {entries.length === 0 ? (
            <p className="p-4 text-center text-xs text-ink-3">この中にフォルダはありません</p>
          ) : (
            <ul className="flex flex-col">
              {entries.map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    onClick={() => setAt(`${at}/${name}`)}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink-2 hover:bg-accent hover:text-foreground"
                  >
                    <Folder className="size-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {isPending(`${at}/${name}`) ? <span className="text-ink-3">新しく作る</span> : null}
                    <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            やめる
          </Button>
          <Button type="button" onClick={() => onPick(at)}>
            ここにする
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 広い根を選んだら、選ぶ前に見せる（本実装の `WideRootWarning` と同じ文言。判断は固定） */
export function WideRootWarning({ path }: { path: string }) {
  if (!["~", "~/", "/"].includes(path.trim())) return null;
  return (
    <div className="flex items-start gap-2 rounded-md bg-turn-soft px-3 py-2 text-xs text-foreground">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">このフォルダでは、サンドボックスがほぼ機能しません</p>
        <p className="text-ink-2">
          AI のシェルとファイル操作は、このフォルダ以下をすべて読み書きできます。
          この中には ~/.ssh・~/.config も含まれます。
        </p>
      </div>
    </div>
  );
}
