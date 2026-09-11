"use client";

// **名前を変える**（決定・2026-09-11、ユーザー要望）。Project も Fork も、
// 右クリック（タッチは長押し）のメニューからここへ来る。
//
// 口は1つ（規則3）——Project 用・Fork 用に2つ作らない。違うのは題と、
// どこへ書きに行くかだけ。
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import { describeFailure } from "@/lib/report-failure";

export function RenameDialog({
  open,
  onOpenChange,
  what,
  currentName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 何の名前か（「Project」「Fork Thread」）。題と説明にそのまま出る */
  what: string;
  currentName: string;
  /** 保存を押したとき。**投げたら画面はそのまま**——失敗は toast で出し、
   *  ダイアログは開いたままにする（打ち直せるように、規則2） */
  onSubmit: (name: string) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="rename-dialog">
        {/* **中身は開くたびに作り直す**——閉じている間 Radix は描かないので、
            「いまの名前から始める」を効果で書き戻さずに済む（前に打ちかけた
            文字も残らない） */}
        <RenameForm what={what} currentName={currentName} onSubmit={onSubmit} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  what,
  currentName,
  onSubmit,
  onDone,
}: {
  what: string;
  currentName: string;
  onSubmit: (name: string) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await onSubmit(trimmed);
      onDone();
    } catch (err) {
      toast(`名前を変えられませんでした: ${describeFailure(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{what} の名前を変える</DialogTitle>
            <DialogDescription>この名前は banto が覚えます（どの端末から開いても同じ）。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="rename-input">名前</Label>
            <Input
              id="rename-input"
              value={name}
              autoFocus
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onDone}>
              やめる
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? "保存しています…" : "保存する"}
            </Button>
          </DialogFooter>
        </form>
  );
}
