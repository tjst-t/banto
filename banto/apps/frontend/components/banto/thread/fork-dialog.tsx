"use client";

// **Fork を作る前に名前を聞く**（決定・2026-10-02、ユーザー要望。v4-frontend.md §6.32）。
//
// 入口は2つで、口は1つ（規則3）：
// - 会話のヘッダの「Fork を開く」——名前と**始め方**（会話を引き継ぐ／まっさらで始める）を聞く
// - 発言の下の「ここから Fork」——名前だけ。その発言の時点から分けるのが目的なので、会話は必ず引き継ぐ
//
// 名前は空でもよい（今までどおり連番になる）。作るのは呼び出し側（host へ title・fresh を渡す）。
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
import { cn } from "@/lib/utils";

export type ForkStart = "continue" | "fresh";

export type ForkDialogRequest = {
  /** 親の Thread */
  parentThreadId: string;
  /** 発言の下から分けるとき、その発言の seq（無ければ「いまの続き」から） */
  fromSeq?: number;
  /** 始め方を選ばせるか（ヘッダの入口だけ true） */
  chooseStart: boolean;
};

export function ForkDialog({
  request,
  onOpenChange,
  onSubmit,
}: {
  /** null なら閉じている */
  request: ForkDialogRequest | null;
  onOpenChange: (open: boolean) => void;
  /** 作るを押したとき。**投げたらダイアログは開いたまま**（打ち直せるように、規則2） */
  onSubmit: (input: { title: string; start: ForkStart }) => Promise<void>;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="fork-dialog">
        {/* 中身は開くたびに作り直す——前に打ちかけた名前・選んだ始め方を残さない */}
        {request ? (
          <ForkForm chooseStart={request.chooseStart} onSubmit={onSubmit} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const START_OPTIONS: { value: ForkStart; label: string; hint: string }[] = [
  { value: "continue", label: "会話を引き継ぐ", hint: "ここまでの会話の続きから始めます" },
  { value: "fresh", label: "まっさらで始める", hint: "会話は引き継がず、Clear した状態から始めます（Memory は効きます）" },
];

function ForkForm({
  chooseStart,
  onSubmit,
  onDone,
}: {
  chooseStart: boolean;
  onSubmit: (input: { title: string; start: ForkStart }) => Promise<void>;
  onDone: () => void;
}) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState<ForkStart>("continue");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit({ title: title.trim(), start: chooseStart ? start : "continue" });
      onDone();
    } catch (err) {
      toast(`Fork を作れませんでした: ${describeFailure(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Fork を作る</DialogTitle>
        <DialogDescription>
          {chooseStart
            ? "名前と始め方を選んでください。名前は空のままなら「Fork 1」のような連番になります。"
            : "この発言の時点から、会話を引き継いで分けます。名前は空のままなら「Fork 1」のような連番になります。"}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 py-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="fork-title-input">名前</Label>
          <Input
            id="fork-title-input"
            value={title}
            autoFocus
            maxLength={120}
            placeholder="例：ログインの不具合を調べる"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        {chooseStart ? (
          <div className="flex flex-col gap-2">
            <span id="fork-start-label" className="text-sm font-medium">
              始め方
            </span>
            <div role="radiogroup" aria-labelledby="fork-start-label" className="flex flex-col gap-2">
              {START_OPTIONS.map((option) => {
                const selected = start === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`fork-start-${option.value}`}
                    onClick={() => setStart(option.value)}
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-foreground" : "border-muted-foreground",
                      )}
                    >
                      {selected ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          やめる
        </Button>
        <Button type="submit" disabled={saving} data-testid="fork-dialog-submit">
          {saving ? "作っています…" : "作る"}
        </Button>
      </DialogFooter>
    </form>
  );
}
