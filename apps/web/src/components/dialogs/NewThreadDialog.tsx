import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { createThread, fetchWorkspaceCandidates } from '../../lib/api';
import type { WorkspaceCandidate } from '../../lib/types';
import { elapsedLabel } from '../../lib/time';

/**
 * 新しい会話をはじめる（決定32）。
 *
 * 対象のリポジトリは任意——空のままでもよい（リポジトリに紐づかない会話も
 * 普通にある）。役割 `workspace-suggestions` を持つモジュールがあれば、
 * 開いた時に一度だけ候補を読みに行く（`/api/state` とは別の口。決定32）。
 */
export function NewThreadDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (threadId: string) => void;
}) {
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [candidates, setCandidates] = useState<WorkspaceCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCandidates(null);
      return;
    }
    setWorkspaceRoot('');
    setError(null);
    void fetchWorkspaceCandidates()
      .then(setCandidates)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [open]);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const root = workspaceRoot.trim();
      const res = await createThread({
        title: '新しい会話',
        ...(root === '' ? {} : { workspaceRoot: root }),
      });
      onOpenChange(false);
      onCreated(res.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="max-w-md">
        <div className="border-b border-rule-faint px-6 pb-3 pt-6">
          <DialogTitle className="text-2xl font-semibold tracking-tight text-ink">新しい会話</DialogTitle>
          <p className="mt-0.5 text-sm text-ink-secondary">対象のリポジトリを指定できます（任意）。</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {error !== null && (
            <div className="mb-4 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          )}

          <input
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRoot(e.target.value)}
            placeholder="対象のリポジトリ（任意。空でもよい）"
            className="h-[var(--h-ctl-sm)] w-full rounded-md border border-rule bg-paper px-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent"
          />

          {/* 場所の候補（決定32）。役割 workspace-suggestions を持つモジュールが出す
              ——直接入力の代わりに押して選べる。無ければ何も出さない。 */}
          {candidates !== null && candidates.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {candidates.map((c) => (
                <li key={c.path}>
                  <button
                    type="button"
                    data-workspace-candidate={c.path}
                    onClick={() => setWorkspaceRoot(c.path)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs hover:bg-paper-sunken ${
                      workspaceRoot === c.path
                        ? 'border-accent bg-accent-soft text-accent'
                        : 'border-rule bg-paper text-ink-secondary'
                    }`}
                  >
                    <span className="truncate">{c.label}</span>
                    <span className="shrink-0 text-ink-muted">
                      {c.inUse && '使用中・'}
                      {elapsedLabel(c.lastModified, Date.now())}前
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-rule-faint px-6 py-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            やめる
          </Button>
          <Button variant="accent" onClick={() => void confirm()} disabled={busy}>
            はじめる
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
