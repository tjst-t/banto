import { useEffect, useState } from 'react';
import { Clock3, Inbox } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { elapsedLabel, stalenessLevel } from '../lib/time';
import type { PendingDecision, ThreadSummary } from '../lib/types';

/**
 * 1件に答える口。**選択肢を押すか、自由に書くか。**
 *
 * 選択肢が在るときも書く欄を閉じないのは、**どれも選べないのが普通に起きる**から
 * （立てた側は答えの形を全部は知らない）。押した／書いた答えは、その判断が属する
 * 会話に返る——ここで「押されたときに効く口」を別に作らない。
 */
function Answer({
  decision,
  onAnswer,
}: {
  decision: PendingDecision;
  onAnswer: (answer: string, optionId?: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (answer: string, optionId?: string) => {
    if (answer.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer, optionId);
      setText('');
    } catch (cause) {
      // 握りつぶさない（規則2）。断られた理由をそのまま出す。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const options = decision.options ?? [];

  return (
    <div className="mt-2 flex flex-col gap-2">
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={busy}
              title={o.detail}
              onClick={() => void send(o.label, o.id)}
              className="rounded border border-border bg-surface px-2 py-1 text-xs font-medium text-ink hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(text);
          }}
          placeholder={options.length > 0 ? 'どれも選べないときは、ここに書く' : '答えを書く'}
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-muted disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || text.trim() === ''}
          onClick={() => void send(text)}
          className="rounded border border-border px-2 py-1 text-xs text-ink-secondary hover:border-accent hover:text-accent disabled:opacity-40"
        >
          送る
        </button>
      </div>
      {error !== null && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

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
  onAnswer,
}: {
  queue: PendingDecision[];
  threads: ThreadSummary[];
  onOpenThread: (threadId: string) => void;
  onAnswer: (decisionId: string, answer: string, optionId?: string) => Promise<void>;
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
              <Answer
                decision={d}
                onAnswer={(answer, optionId) => onAnswer(d.decisionId, answer, optionId)}
              />
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
