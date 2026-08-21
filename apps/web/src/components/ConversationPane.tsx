import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';

import { ContextChart, type ContextPoint } from './ContextChart';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { Badge } from './ui/badge';
import type { ThreadSession } from '../hooks/useThreadSessions';
import type { ThreadSummary } from '../lib/types';

const STATUS_LABEL: Record<ThreadSummary['status'], { text: string; tone: 'accent' | 'good' | 'critical' | 'waiting' }> = {
  working: { text: '作業中', tone: 'accent' },
  done: { text: '完了', tone: 'good' },
  blocked: { text: '停止', tone: 'critical' },
  'waiting-on-human': { text: '判断待ち', tone: 'waiting' },
};

export function ConversationPane({
  thread,
  session,
  onSend,
}: {
  thread: ThreadSummary | null;
  session: ThreadSession;
  onSend: (text: string) => void;
}) {
  const points = useMemo<ContextPoint[]>(
    () =>
      session.items
        .map((i) => i.event)
        .filter((e): e is Extract<typeof e, { type: 'turn.usage' }> => e.type === 'turn.usage')
        .map((e) => ({ turnIndex: e.turnIndex, queryId: e.queryId, usage: e.usage })),
    [session.items],
  );

  if (!thread) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-ink-muted">
        右上の「新しい会話」で会話を始めてください。
      </div>
    );
  }

  const status = STATUS_LABEL[thread.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{thread.title}</h2>
          <p className="text-[11px] text-ink-muted">
            ターン {thread.turnCount} ・ base v{thread.baseVersion}
            {thread.forkedFrom ? ` ・ fork元あり` : ''}
          </p>
        </div>
        <Badge tone={status.tone}>{status.text}</Badge>
      </div>

      {session.items.length === 0 && thread.turnCount > 0 && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-waiting/40 bg-waiting-soft px-3 py-2 text-xs text-waiting">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>
            このスレッドはすでに {thread.turnCount} ターン進んでいますが、host に会話ログを
            読み返す口が無いため、ここより前のやり取りは表示できません。この画面を開いてから
            のぶんだけが見えています。
          </p>
        </div>
      )}

      <div className="px-4 pt-3">
        <ContextChart points={points} />
      </div>

      {session.error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-xs text-critical">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>ストリームが途中で切れました: {session.error}</p>
        </div>
      )}

      <MessageList items={session.items} running={session.running} />
      <Composer disabled={session.running} onSend={onSend} />
    </div>
  );
}
