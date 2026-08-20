import { useEffect, useState } from 'react';
import { Clock3, Inbox } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { elapsedLabel, stalenessLevel } from '../lib/time';
import type { PendingDecision, ThreadSummary } from '../lib/types';

const SOURCE_LABEL: Record<PendingDecision['source'], string> = {
  thread: '会話',
  factory: 'Factory',
  observer: '機構',
};

const STALE_STYLE: Record<'fresh' | 'aging' | 'stale', string> = {
  fresh: 'border-border bg-surface',
  aging: 'border-waiting/40 bg-waiting-soft/60',
  stale: 'border-waiting bg-waiting-soft',
};

/**
 * 「いま自分を待っているもの」。出所は問わず1つの列にする（要件 A6）——
 * 会話・Factory・機構の警報を別タブに分けない。目立たせるのは発生ではなく
 * 滞留（要件 A7）：長く待っているものほど濃く出す。
 */
export function Queue({
  queue,
  threads,
  onOpenThread,
}: {
  queue: PendingDecision[];
  threads: ThreadSummary[];
  onOpenThread: (threadId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (queue.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-ink-muted">
        <Inbox className="h-6 w-6" />
        待っているものはありません
      </div>
    );
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <ul className="flex flex-col gap-2 p-3">
        {queue.map((d) => {
          const level = stalenessLevel(d.since, now);
          const thread = d.threadId ? threads.find((t) => t.id === d.threadId) : undefined;
          return (
            <li key={d.decisionId} className={`rounded-md border p-3 ${STALE_STYLE[level]}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">
                  {SOURCE_LABEL[d.source]}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-ink-secondary">
                  <Clock3 className="h-3 w-3" />
                  {elapsedLabel(d.since, now)}待ち
                </span>
              </div>
              <p className="mt-1.5 text-sm text-ink">{d.question}</p>
              {thread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(thread.id)}
                  className="mt-2 text-xs font-medium text-accent hover:underline"
                >
                  「{thread.title}」を開く
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </ScrollArea>
  );
}
