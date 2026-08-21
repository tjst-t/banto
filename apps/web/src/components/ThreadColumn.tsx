import { useState } from 'react';
import { X } from 'lucide-react';

import { BasePanel } from './BasePanel';
import { ConversationPane } from './ConversationPane';
import { Badge } from './ui/badge';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import type { ThreadSession } from '../hooks/useThreadSessions';
import type { ThreadSummary } from '../lib/types';

type Pane = 'conversation' | 'base';

const STATUS_LABEL: Record<
  ThreadSummary['status'],
  { text: string; tone: 'accent' | 'good' | 'critical' | 'waiting' }
> = {
  working: { text: '作業中', tone: 'accent' },
  done: { text: '完了', tone: 'good' },
  blocked: { text: '停止', tone: 'critical' },
  'waiting-on-human': { text: '判断待ち', tone: 'waiting' },
};

/**
 * **開いている会話1本ぶんの列**（要件 A2・A3）。
 *
 * 会話を1本しか開けない画面では、**同時に走っている複数の試みを見比べられない**
 * ——要件 A2（1プロジェクトに複数の会話が同時）と A3（分岐して並ぶ）は、
 * どちらも「並んでいるものを見る」ことが要点なので、1本ずつ切り替える画面では満たせない。
 *
 * 中は2枚：**いま話していること**（会話）と、**いま決まっていること**（base）。
 * 決まっていることは会話の年表に点としてしか出ていなかったので、ここで面にする。
 */
export function ThreadColumn({
  thread,
  session,
  onSend,
  onClose,
  onBaseChanged,
  closable,
}: {
  thread: ThreadSummary;
  session: ThreadSession;
  onSend: (text: string) => void;
  onClose: () => void;
  onBaseChanged: () => void;
  closable: boolean;
}) {
  const [pane, setPane] = useState<Pane>('conversation');
  const status = STATUS_LABEL[thread.status];

  return (
    <section
      // 画面の試験が列を数えるための印。**見た目には効かない。**
      data-thread-column={thread.id}
      className="flex min-h-0 min-w-0 flex-col border-border [&:not(:first-child)]:border-l"
    >
      {/* **どの会話の列かを、どの面でも出す。** 面を切り替えたときに
          見出しが消えると、並べたとたんにどれがどれだか分からなくなる。 */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{thread.title}</h2>
          <p className="text-[11px] text-ink-muted">
            ターン {thread.turnCount} ・ base v{thread.baseVersion}
            {thread.forkedFrom !== null ? ' ・ 分岐' : ''}
          </p>
        </div>
        <Badge tone={status.tone}>{status.text}</Badge>
      </div>

      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
        <Tabs value={pane} onValueChange={(v) => setPane(v as Pane)}>
          <TabsList>
            <TabsTrigger value="conversation">会話</TabsTrigger>
            <TabsTrigger value="base">決まったこと v{thread.baseVersion}</TabsTrigger>
          </TabsList>
        </Tabs>
        {closable && (
          <button
            type="button"
            onClick={onClose}
            title="この会話を閉じる（消えるのは表示だけ）"
            className="ml-auto rounded p-1 text-ink-muted hover:bg-paper hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {pane === 'conversation' ? (
        <ConversationPane thread={thread} session={session} onSend={onSend} />
      ) : (
        <BasePanel threadId={thread.id} onChanged={onBaseChanged} />
      )}
    </section>
  );
}
