"use client";

// **番頭の決め・頼みを取り消す**（v4-frontend.md §6.54、アーキ仕様 §4.5「取り消し」）。番頭の画面の記録と受信箱のカードが同じ部品を使う
import { useState } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { undoRealSupervisorAct, type RealSupervisorLogEntry, type RealSupervisorPolicy } from "@/lib/backend/client";
import { kindTitle } from "@/lib/backend/supervisors";
import { describeFailure } from "@/lib/report-failure";
import { SUPERVISOR_LABEL as L } from "@/lib/supervisor-label";

/** 取り消しの既定の文（host の `defaultUndoText` と同じ言い方）。選んだ答えは同じターンに届けた問いを全部まとめる */
export function defaultUndoText(act: RealSupervisorLogEntry, all: readonly RealSupervisorLogEntry[], policy: Pick<RealSupervisorPolicy, "catalog"> | undefined): string {
  if (act.kind === "instructed") return `${L}の頼み「${act.action ? kindTitle(act.action, policy) : ""}」は取り消して。その前に戻して`;
  const group = all.filter((e) => e.kind === "answered" && e.threadId === act.threadId && e.turnId === act.turnId && e.turnId !== undefined);
  const list = group.length > 0 ? group.sort((x, y) => (x.question ?? 0) - (y.question ?? 0)) : [act];
  const choices = list.map((e) => `「${e.label ?? ""}」${list.length > 1 && e.question !== undefined ? `（問い ${e.question}）` : ""}`).join("・");
  return `${L}の選んだ${choices}は取り消して。その前に戻して`;
}

/**
 * **取り消す**（§6.54・アーキ仕様 §4.5「取り消し」）。選んだ・頼んだものは短い文の欄を開き、送ると元の会話に人の発言として届く
 * （巻き戻しはしない）。Factory に流したものは「取りやめる」——確かめてから実行ごと取りやめる
 */
export function UndoControl({
  act,
  initialText,
  onUndone,
  startOpen = false,
}: {
  act: Pick<RealSupervisorLogEntry, "actId" | "kind">;
  /** 無ければ Factory の取りやめ（文は付けられない） */
  initialText: string | undefined;
  onUndone: () => void;
  /** 初めから文の欄を開いておく（受信箱のカードの「取り消す」——押してから記録を引くので） */
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState(initialText ?? "");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const factory = initialText === undefined;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await undoRealSupervisorAct(act.actId, factory ? undefined : text);
      setDone(result.cancelled ? "取りやめました" : "元の会話に送りました");
      setOpen(false);
      onUndone();
    } catch (err) {
      toast(`${factory ? "取りやめられませんでした" : "取り消せませんでした"}：${describeFailure(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p data-testid="supervisor-undo-done" className="text-xs text-ok">
        {done}
      </p>
    );
  }
  if (!open) {
    return (
      <div>
        <Button type="button" size="xs" variant="outline" onClick={() => setOpen(true)} data-testid="supervisor-undo">
          <RotateCcw />
          {factory ? "取りやめる" : "取り消す"}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2/40 p-2" data-testid="supervisor-undo-form">
      {factory ? (
        <p className="flex items-start gap-1.5 text-xs text-foreground">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          この実行の Factory の件を取りやめます。途中までの作業は取り込みません。
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-2">元の会話に、あなたの発言として次の文を送ります（直せます）</p>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-14 bg-card text-sm" data-testid="supervisor-undo-text" />
        </>
      )}
      <div className="flex gap-2">
        <Button type="button" size="xs" disabled={busy || (!factory && text.trim() === "")} onClick={() => void submit()} data-testid="supervisor-undo-send">
          {factory ? "取りやめる" : "送る"}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
          やめる
        </Button>
      </div>
    </div>
  );
}
