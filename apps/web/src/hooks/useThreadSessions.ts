import { useCallback, useState } from 'react';

import { streamPrompt } from '../lib/api';
import type { StreamEvent } from '../lib/types';

export type TimelineItem =
  | { readonly kind: 'user'; readonly id: string; readonly text: string; readonly at: string }
  | { readonly kind: 'stream'; readonly id: string; readonly event: StreamEvent };

export interface ThreadSession {
  readonly items: TimelineItem[];
  readonly running: boolean;
  readonly error: string | null;
}

const EMPTY_SESSION: ThreadSession = { items: [], running: false, error: null };

/**
 * この画面が開いている間に届いたイベントだけを覚える、送信中の会話の見え方。
 *
 * **これは「真実の写し」ではない**——host にはスレッドの会話ログを読み返す口が
 * 無いので（/api/state はサマリだけ）、ここに置くのはその場で流れた分の一時的な
 * バッファであって、他から導ける値ではない。ページを開き直すと消える。
 */
export function useThreadSessions() {
  const [sessions, setSessions] = useState<Record<string, ThreadSession>>({});

  const sessionFor = useCallback(
    (threadId: string): ThreadSession => sessions[threadId] ?? EMPTY_SESSION,
    [sessions],
  );

  const send = useCallback(async (threadId: string, text: string, onSettled?: () => void) => {
    const userItem: TimelineItem = {
      kind: 'user',
      id: crypto.randomUUID(),
      text,
      at: new Date().toISOString(),
    };
    setSessions((prev) => {
      const current = prev[threadId] ?? EMPTY_SESSION;
      return {
        ...prev,
        [threadId]: { items: [...current.items, userItem], running: true, error: null },
      };
    });

    try {
      for await (const event of streamPrompt(threadId, text)) {
        setSessions((prev) => {
          const current = prev[threadId] ?? EMPTY_SESSION;
          const item: TimelineItem = { kind: 'stream', id: crypto.randomUUID(), event };
          return { ...prev, [threadId]: { ...current, items: [...current.items, item] } };
        });
      }
      setSessions((prev) => {
        const current = prev[threadId] ?? EMPTY_SESSION;
        return { ...prev, [threadId]: { ...current, running: false } };
      });
    } catch (cause) {
      // 握りつぶさない。ストリームが途中で切れても画面に理由を出す（規則2）。
      const message = cause instanceof Error ? cause.message : String(cause);
      setSessions((prev) => {
        const current = prev[threadId] ?? EMPTY_SESSION;
        return { ...prev, [threadId]: { ...current, running: false, error: message } };
      });
    } finally {
      onSettled?.();
    }
  }, []);

  return { sessionFor, send };
}
