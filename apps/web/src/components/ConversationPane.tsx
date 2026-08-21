import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';

import { ContextChart, type ContextPoint } from './ContextChart';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import type { ThreadSession } from '../hooks/useThreadSessions';
import type { ThreadSummary } from '../lib/types';

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
