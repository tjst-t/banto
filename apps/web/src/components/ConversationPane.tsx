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
  onOpen,
}: {
  thread: ThreadSummary | null;
  session: ThreadSession;
  onSend: (text: string) => void;
  onOpen: (uri: string, name: string) => void;
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
      <div className="flex flex-1 items-center justify-center p-8 text-center text-body text-ink-muted">
        右上の「新しい会話」で会話を始めてください。
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {session.items.length === 0 && thread.turnCount > 0 && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-ctl bg-caution-soft px-3 py-2 text-meta text-ink shadow-[inset_2px_0_0_var(--caution)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" />
          <p>
            このスレッドはすでに {thread.turnCount} ターン進んでいますが、host に会話ログを
            読み返す口が無いため、ここより前のやり取りは表示できません。この画面を開いてから
            のぶんだけが見えています。
          </p>
        </div>
      )}

      {/* **観測は横目で見るもの**（要件 F1・F3）。会話の場所を取らない細い帯にしてある。
          読む幅に揃えるので、下の会話と目線が横にずれない。 */}
      <div className="mx-auto w-full max-w-[var(--w-read)] shrink-0 border-b border-rule px-5 py-1.5">
        <ContextChart points={points} />
      </div>

      {session.error && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-ctl bg-stopped-soft px-3 py-2 text-meta text-ink shadow-[inset_2px_0_0_var(--stopped)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
          <p>ストリームが途中で切れました: {session.error}</p>
        </div>
      )}

      <MessageList items={session.items} running={session.running} onOpen={onOpen} />
      <Composer disabled={session.running} onSend={onSend} />
    </div>
  );
}
