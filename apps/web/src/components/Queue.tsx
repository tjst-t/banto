import { useEffect, useState } from 'react';
import { Clock3, Inbox } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
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
            <Button
              key={o.id}
              variant="secondary"
              size="sm"
              disabled={busy}
              title={o.detail}
              onClick={() => void send(o.label, o.id)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // 変換確定の Enter で送らない（要件 E8）。**入力欄はどこでも同じ約束にする。**
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(text);
          }}
          placeholder={options.length > 0 ? 'どれも選べないときは、ここに書く' : '答えを書く'}
          className="h-[var(--h-ctl-sm)] min-w-0 flex-1 rounded-ctl border border-rule bg-paper px-2 text-meta text-ink outline-none placeholder:text-ink-muted focus:border-accent disabled:opacity-50"
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || text.trim() === ''}
          onClick={() => void send(text)}
        >
          送る
        </Button>
      </div>
      {/* 断られた理由をそのまま出す（規則2）。**止まったものは紫。** */}
      {error !== null && <p className="text-note text-stopped">{error}</p>}
    </div>
  );
}

const SOURCE_LABEL: Record<PendingDecision['source'], string> = {
  thread: '会話',
  factory: 'Factory',
  observer: '機構',
};

/**
 * 待たせているほど濃くなる（要件 A7）。**発生では鳴らさず、滞留で目立たせる。**
 *
 * 濃くするのは**左罫と地**だけ。枠の色を変えると、並んだときに枠だけがちらつく。
 */
const STALE_STYLE: Record<'fresh' | 'aging' | 'stale', string> = {
  fresh: 'bg-paper-raised shadow-rest',
  aging: 'bg-attention-soft/60 shadow-[inset_2px_0_0_var(--attention)]',
  stale: 'bg-attention-soft shadow-[inset_3px_0_0_var(--attention)]',
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
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-body text-ink-muted">
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
            <li key={d.decisionId} className={`rounded-ctl p-3 ${STALE_STYLE[level]}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-note uppercase tracking-wide text-ink-muted">
                  {SOURCE_LABEL[d.source]}
                </span>
                <span className="flex items-center gap-1 text-note text-ink-secondary">
                  <Clock3 className="h-3 w-3" />
                  {elapsedLabel(d.since, now)}待ち
                </span>
              </div>
              <p className="mt-1.5 text-body text-ink">{d.question}</p>
              <Answer
                decision={d}
                onAnswer={(answer, optionId) => onAnswer(d.decisionId, answer, optionId)}
              />
              {thread && (
                <button
                  type="button"
                  onClick={() => onOpenThread(thread.id)}
                  className="mt-2 text-meta font-medium text-accent hover:underline"
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
