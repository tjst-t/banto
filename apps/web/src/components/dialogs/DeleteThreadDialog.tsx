import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { deleteThread, fetchBase } from '../../lib/api';
import type { BaseEntry } from '../../lib/types';

/**
 * スレッド削除の確認（決定30）。
 *
 * **未マージのフォークは host 側が自動でマージしてから削除する**——ここでは
 * 何も選ばせない（人が選ぶのは「共有baseへ何を持ち出すか」だけ）。
 *
 * このスレッド**自身**が追記した、無効化されていない行だけを候補に出す
 * （継承した行は他スレッドの持ち物なので、ここでは対象にしない）。
 * **既定はすべて未選択**——広く共有してよいかは行ごとに人が判断する
 * （決定30：AIの書き込みも「不明ならローカル」を既定にしたのと同じ考え）。
 */
export function DeleteThreadDialog({
  open,
  onOpenChange,
  threadId,
  threadTitle,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string | null;
  threadTitle: string;
  onDeleted: () => void;
}) {
  const [entries, setEntries] = useState<BaseEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (threadId === null) return;
    try {
      const base = await fetchBase(threadId);
      setEntries(base.entries.filter((e) => e.own && !e.invalidated));
      setSelected(new Set());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threadId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const toggle = (baseVersion: number): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(baseVersion)) next.delete(baseVersion);
      else next.add(baseVersion);
      return next;
    });
  };

  const confirm = async (): Promise<void> => {
    if (threadId === null) return;
    setBusy(true);
    setError(null);
    try {
      await deleteThread({ threadId, shareToSharedBase: [...selected] });
      onOpenChange(false);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="max-w-lg">
        <div className="border-b border-rule-faint px-6 pb-3 pt-6">
          <DialogTitle className="text-2xl font-semibold tracking-tight text-ink">
            「{threadTitle}」を削除
          </DialogTitle>
          <p className="mt-0.5 text-sm text-ink-secondary">
            会話の記録は残ります（ログからは消えません）が、一覧には出なくなります。
            未マージのフォークがあれば、先に自動でマージされます。
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {error !== null && (
            <div className="mb-4 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          )}

          {entries === null ? (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              読み込み中…
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-ink-muted">このスレッド自身の決まったことはありません。</p>
          ) : (
            <>
              <p className="mb-2 text-sm font-semibold text-ink">
                共有baseへ持ち出す行を選ぶ（任意）
              </p>
              <p className="mb-3 text-xs text-ink-secondary">
                このプロジェクト固有の内容ではなく、一般的に成り立つ事実だけを選んでください。
                選ばなかった行はこのスレッドと一緒に見えなくなります（ログには残ります）。
              </p>
              <ul className="flex flex-col gap-1.5">
                {entries.map((e) => (
                  <li key={e.baseVersion}>
                    <label className="flex items-start gap-2 rounded-md bg-paper-raised p-2 text-sm text-ink shadow-rest">
                      <input
                        type="checkbox"
                        checked={selected.has(e.baseVersion)}
                        onChange={() => toggle(e.baseVersion)}
                        className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]"
                      />
                      <span>{e.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-rule-faint px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            やめる
          </Button>
          <Button variant="accent" onClick={() => void confirm()} disabled={busy || entries === null}>
            削除する
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
