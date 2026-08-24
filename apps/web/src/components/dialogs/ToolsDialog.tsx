import { useEffect, useState } from 'react';
import { AlertTriangle, Wrench } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import { fetchModules } from '../../lib/api';
import type { ModuleSummary } from '../../lib/types';

/**
 * ツール（要件C3・決定33）。**人が、AIの`show`を待たずに直接開ける入口。**
 *
 * `launcherUri`を持つモジュールだけを出す——持たないモジュール（AI向けの道具しか
 * 持たない・画面を持たない等）はここには出ない。設定ダイアログの台帳とは別物
 * （あちらは「何が繋がっているか・外したら何が壊れるか」、こちらは「何を開けるか」）。
 */
export function ToolsDialog({
  open,
  onOpenChange,
  onOpenLauncher,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenLauncher: (uri: string, title: string) => void;
}) {
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    void fetchModules()
      .then(setModules)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [open]);

  const launchers = (modules ?? []).filter((m) => m.launcherUri !== null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="max-w-md">
        <div className="border-b border-rule-faint px-6 pb-3 pt-6">
          <DialogTitle className="text-2xl font-semibold tracking-tight text-ink">ツール</DialogTitle>
          <p className="mt-0.5 text-sm text-ink-secondary">モジュールが持ち込む画面を、直接開けます。</p>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-6">
            {error !== null && (
              <div className="mb-4 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
                <p className="whitespace-pre-wrap">{error}</p>
              </div>
            )}

            {modules !== null && launchers.length === 0 && error === null && (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-md text-ink-muted">
                <Wrench className="h-6 w-6" />
                直接開けるモジュールの画面はまだありません
              </div>
            )}

            {launchers.length > 0 && (
              <ul className="flex flex-col gap-2">
                {launchers.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      data-tool={m.id}
                      onClick={() => {
                        onOpenLauncher(m.launcherUri as string, m.id);
                        onOpenChange(false);
                      }}
                      className="w-full rounded-md bg-paper-raised px-4 py-3 text-left shadow-rest hover:shadow-pop"
                    >
                      <h3 className="text-md font-medium text-ink">{m.id}</h3>
                      <p className="mt-0.5 truncate text-sm text-ink-secondary">{m.description}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
