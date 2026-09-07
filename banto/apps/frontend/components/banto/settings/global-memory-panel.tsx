"use client";

// Global Memory（アーキ仕様§2.2、決定・2026-09-05）。banto全体で覚えておくこと
// ——人の名前・呼ばれ方・Projectに紐づかない好み。Project Memoryと同じ規律
// （追記のみ・無効化イベント・上限で拒否）で、置き場だけが違う。
// **Phase 0 では人が書くだけ**——AIから書くtoolは開けていない（§2.2）。
import { useEffect, useState } from "react";
import { Globe, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  appendRealGlobalMemory,
  invalidateRealGlobalMemory,
  listRealGlobalMemory,
  type RealProjectMemory,
} from "@/lib/backend/client";
import { cn } from "@/lib/utils";

export function GlobalMemoryPanel() {
  const [memory, setMemory] = useState<RealProjectMemory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setMemory(await listRealGlobalMemory());
    } catch (err) {
      toast(`Global Memory の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh()はlistRealGlobalMemoryのawait後にsetStateする（外部データの初回取得）
    refresh();
  }, []);

  async function handleAppend() {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      await appendRealGlobalMemory(text);
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
      await invalidateRealGlobalMemory(seq);
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
        <Globe className="size-4 text-ink-3" />
        Global Memory
      </h1>
      <p className="mb-3 text-xs text-ink-3">
        どの Project にも紐づかない、banto 全体の記憶。あなたの名前や呼ばれ方、
        どの Project でも同じように扱ってほしいこと。すべての Project のすべての会話に渡る
        ——特定の Project の「決まったこと」は、その Project の Memory に置く。
        走行中の Thread には次のターンから届く。
      </p>

      <div className="mb-3 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAppend();
          }}
          placeholder="覚えておいてほしいことを足す"
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
                  aria-label="この記憶を取り消す"
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
