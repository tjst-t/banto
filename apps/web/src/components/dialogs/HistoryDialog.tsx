import { History } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import type { ThreadSummary } from '../../lib/types';

/**
 * 履歴（要件 A8）。**終わったスレッドは消えない、読み返せる。**
 *
 * ここに出せるのは`status === 'done'`のスレッドだけ——無いものを作文しない（規則2）。
 */
export function HistoryDialog({
  open,
  onOpenChange,
  threads,
  onOpenThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: readonly ThreadSummary[];
  onOpenThread: (threadId: string) => void;
}) {
  const done = threads.filter((t) => t.status === 'done');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="max-w-2xl">
        <div className="border-b border-rule-faint px-6 pb-3 pt-6">
          <DialogTitle className="text-2xl font-semibold tracking-tight text-ink">履歴</DialogTitle>
          <p className="mt-0.5 text-sm text-ink-secondary">
            終わったスレッド。中身は残っていて、いつでも読み返せます。
          </p>
        </div>

        {done.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-md text-ink-muted">
            <History className="h-6 w-6" />
            終わったスレッドはまだありません
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-2 p-6">
              {done.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpenThread(t.id);
                      onOpenChange(false);
                    }}
                    data-history-thread={t.id}
                    className="w-full rounded-md bg-paper-raised px-4 py-3 text-left shadow-rest hover:shadow-pop"
                  >
                    <div className="flex items-center gap-2 text-xs text-ink-muted">
                      <span>ターン {t.turnCount}</span>
                    </div>
                    <h3 className="mt-0.5 text-md font-medium text-ink">{t.title}</h3>
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
