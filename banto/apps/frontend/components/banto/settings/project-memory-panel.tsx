"use client";

// Memory（G1〜G3・G5、Stage 3）。Base Threadのremember_decision toolが
// 記録した決定事項と、人が手で足したものを1つのリストで見せる——出所を
// 分ける必要はない（どちらも同じappendMemoryを通る、真実は一箇所）。
// Fork Threadへの引き継ぎはfold.tsの分岐時点コピーで担保済み——ここは
// Base Threadの現在値を見るだけ。invalidateは無効化（取り消し線）、
// 物理削除ではない（規則3）。
import { useEffect, useState } from "react";
import { BookMarked, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appendRealMemory, getRealThread, invalidateRealMemory, type RealThreadMemory } from "@/lib/backend/client";
import { cn } from "@/lib/utils";

export function ProjectMemoryPanel({ threadId }: { threadId: string }) {
  const [memory, setMemory] = useState<RealThreadMemory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const thread = await getRealThread(threadId);
      setMemory(thread.memory);
    } catch (err) {
      toast(`Memory の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh()はgetRealThreadのawait後にsetStateする（外部データの初回取得、theme-toggle.tsxと同じ形）
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  async function handleAppend() {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await appendRealMemory(threadId, text);
      setDraft("");
      await refresh();
    } catch (err) {
      toast(`記録に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleInvalidate(seq: number) {
    setBusy(true);
    try {
      await invalidateRealMemory(threadId, seq);
      await refresh();
    } catch (err) {
      toast(`取り消しに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="mb-0.5 flex items-center gap-2 text-lg font-semibold text-foreground">
        <BookMarked className="size-4 text-ink-3" />
        Memory
      </h1>
      <p className="mb-3 text-xs text-ink-3">
        決まったこと（設計判断・決定事項）。AIが remember_decision tool で自動的に残すものと、
        ここから人が直接足すものが同じ一覧に並ぶ。Fork Thread には分岐時点のものが引き継がれる
        ——以降の変更はそのFork自身のものになる。
      </p>

      <div className="mb-3 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAppend();
          }}
          placeholder="決まったことを直接足す"
          className="h-8 text-xs"
          disabled={busy}
        />
        <Button type="button" size="sm" onClick={handleAppend} disabled={busy || !draft.trim()}>
          足す
        </Button>
      </div>

      {memory === null ? (
        <p className="text-xs text-ink-3">読み込み中…</p>
      ) : memory.length === 0 ? (
        <p className="text-xs text-ink-3">まだ無い</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {memory.map((m) => (
            <li
              key={m.seq}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-1.5"
            >
              <span className={cn("text-xs text-ink-2", m.invalidated && "text-ink-3 line-through")}>{m.text}</span>
              {!m.invalidated ? (
                <button
                  type="button"
                  onClick={() => handleInvalidate(m.seq)}
                  disabled={busy}
                  className="shrink-0 rounded p-1 text-ink-3 hover:bg-accent hover:text-destructive"
                  aria-label="この決定事項を取り消す"
                >
                  <Trash2 className="size-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
