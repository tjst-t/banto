import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowUp, Folder, FolderOpen } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { createThread, fetchBrowse, fetchWorkspaceCandidates } from '../../lib/api';
import type { BrowseResponse, WorkspaceCandidate } from '../../lib/types';
import { elapsedLabel } from '../../lib/time';

/**
 * 新しい会話をはじめる（決定32）。
 *
 * 対象のディレクトリは任意——空のままでもよい（ディレクトリに紐づかない会話も
 * 普通にある）。役割 `workspace-suggestions` を持つモジュールがあれば、
 * 開いた時に一度だけ候補を読みに行く（`/api/state` とは別の口。決定32）。
 *
 * **候補が無くても、自由記入だけでは何を入れればよいか伝わらない**
 * （PO指摘 2026-08-25：「空のフォームに何を入れればいいのかわからない」）。
 * 説明文で「banto のファイル領域を根とした相対パス」であることを明示し、
 * `/api/browse` で辿れるフォルダ選択（`FolderBrowser`）を自由記入と並べて添えた。
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
  const [title, setTitle] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [candidates, setCandidates] = useState<WorkspaceCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setCandidates(null);
      setBrowserOpen(false);
      return;
    }
    setTitle('');
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
        title: title.trim() === '' ? '新しい会話' : title.trim(),
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
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {error !== null && (
            <div className="mb-4 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          )}

          <label className="mb-1 block text-xs font-medium text-ink-secondary" htmlFor="new-thread-title">
            タイトル
          </label>
          <input
            id="new-thread-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="新しい会話"
            className="mb-4 h-[var(--h-ctl-sm)] w-full rounded-md border border-rule bg-paper px-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent"
          />

          <label className="mb-1 block text-xs font-medium text-ink-secondary" htmlFor="new-thread-workspace-root">
            対象のディレクトリ（任意）
          </label>
          <p className="mb-1.5 text-xs text-ink-muted">
            この会話が読み書きする範囲。banto のファイル領域を根とした相対パスで指定します——空なら根全体が対象になります。
          </p>
          <div className="flex gap-1.5">
            <input
              id="new-thread-workspace-root"
              value={workspaceRoot}
              onChange={(e) => setWorkspaceRoot(e.target.value)}
              placeholder="例: my-repo（空でもよい）"
              className="h-[var(--h-ctl-sm)] w-0 flex-1 rounded-md border border-rule bg-paper px-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent"
            />
            <Popover open={browserOpen} onOpenChange={setBrowserOpen}>
              <PopoverTrigger asChild>
                <Button type="button" variant="secondary" size="sm" className="shrink-0">
                  <FolderOpen className="h-3.5 w-3.5" />
                  参照…
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end">
                <FolderBrowser
                  onPick={(picked) => {
                    setWorkspaceRoot(picked);
                    setBrowserOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>

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

/**
 * `/api/browse` を1段ずつ辿るフォルダ選択（PO指摘 2026-08-25）。
 * **候補を出すモジュールが無くても、パスをブラウザ的に選べる**——
 * 自由記入の代わりではなく、隣に添えるだけ（決定32の候補一覧と同じ扱い）。
 */
function FolderBrowser({ onPick }: { onPick: (path: string) => void }) {
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((dirPath?: string) => {
    void fetchBrowse(dirPath)
      .then(setData)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  // 開いたら根から辿り直す——起点をどこにするかで悩ませない。
  useEffect(() => {
    load();
  }, [load]);

  if (error !== null) {
    return <p className="w-64 p-2 text-sm text-stopped">{error}</p>;
  }
  if (data === null) {
    return <p className="w-64 p-2 text-sm text-ink-muted">読み込み中…</p>;
  }
  if (data.root === null) {
    return (
      <p className="w-64 p-2 text-sm text-ink-muted">
        この banto にはフォルダ選択の根が設定されていません。直接入力してください。
      </p>
    );
  }

  return (
    <div className="flex w-72 flex-col gap-1.5">
      <p className="truncate px-1 text-xs text-ink-muted" title={data.path}>
        {data.path === '.' ? '（根）' : data.path}
      </p>
      <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
        {data.parent !== null && (
          <button
            type="button"
            onClick={() => load(data.parent ?? undefined)}
            className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm text-ink-secondary hover:bg-paper-sunken"
          >
            <ArrowUp className="h-3.5 w-3.5 shrink-0" />
            上へ
          </button>
        )}
        {data.entries.length === 0 ? (
          <p className="px-2 py-1 text-xs text-ink-muted">サブフォルダがありません。</p>
        ) : (
          data.entries.map((e) => (
            <button
              key={e.path}
              type="button"
              data-browse-entry={e.path}
              onClick={() => load(e.path)}
              className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm text-ink hover:bg-paper-sunken"
            >
              <Folder className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
              <span className="truncate">{e.name}</span>
            </button>
          ))
        )}
      </div>
      <Button
        type="button"
        variant="accent"
        size="sm"
        data-browse-pick
        onClick={() => onPick(data.path === '.' ? '' : data.path)}
      >
        ここを選ぶ
      </Button>
    </div>
  );
}
