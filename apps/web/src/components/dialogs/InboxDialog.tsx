import { useEffect, useState } from 'react';
import { Clock3, Inbox } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import { DecisionCard } from '../DecisionCard';
import { elapsedLabel } from '../../lib/time';
import type { PendingDecision, ThreadSummary } from '../../lib/types';

const SOURCE_LABEL: Record<PendingDecision['source'], string> = {
  thread: '会話',
  factory: 'Factory',
  observer: '機構',
};

/**
 * 受信箱（要件 A5・A6）。出所・プロジェクトを問わず、判断待ちを1本の列にする
 * ——3本の列を作れば見に行く先が3つになり、目的に逆行する。
 *
 * 判断待ちカード自体は会話最後尾のものと**同じ見た目**（`DecisionCard`）を使う
 * ——ここだけ違う姿だと、同じ判断待ちが別物に見える（規則3）。
 */
export function InboxDialog({
  open,
  onOpenChange,
  queue,
  threads,
  onAnswer,
  onOpenThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: readonly PendingDecision[];
  threads: readonly ThreadSummary[];
  onAnswer: (decisionId: string, answer: string, optionId?: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="max-w-3xl">
        <div className="border-b border-rule-faint px-6 pb-3 pt-6">
          <DialogTitle className="text-2xl font-semibold tracking-tight text-ink">
            受信箱
          </DialogTitle>
          <p className="mt-0.5 text-sm text-ink-secondary">
            出所を問わず1つの列にしてある（要件 A6）
          </p>
        </div>

        {queue.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-md text-ink-muted">
            <Inbox className="h-6 w-6" />
            待っているものはありません
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-6">
              {queue.map((d) => {
                const thread = d.threadId !== null ? threads.find((t) => t.id === d.threadId) : undefined;
                return (
                  <DecisionCard
                    key={d.decisionId}
                    question={d.question}
                    options={d.options}
                    onAnswer={(answer, optionId) => onAnswer(d.decisionId, answer, optionId)}
                    context={
                      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                        <span className="font-mono uppercase tracking-wide">
                          {SOURCE_LABEL[d.source]}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock3 className="h-3 w-3" />
                          {elapsedLabel(d.since, now)}待ち
                        </span>
                        {thread !== undefined && (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenThread(thread.id);
                              onOpenChange(false);
                            }}
                            className="font-medium text-accent hover:underline"
                          >
                            「{thread.title}」を開く →
                          </button>
                        )}
                      </div>
                    }
                  />
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
