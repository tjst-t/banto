import { useCallback, useRef, useState } from 'react';

import { fetchEvents, streamPrompt } from '../lib/api';
import type { StreamEvent } from '../lib/types';

/**
 * 画面の中でだけ使う一意な id。
 *
 * **`crypto.randomUUID` を直接呼ばない。** これは secure context（HTTPS か localhost）
 * でしか存在せず、素の HTTP でドメインを開くと `undefined` になって落ちる。
 * 開発は localhost（secure context）なので、そこでは絶対に露見しない
 * ——実際に露見したのは本物のドメインで開いたときだった（教訓1）。
 */
function localId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface TimelineItem {
  readonly id: string;
  readonly event: StreamEvent;
}

export interface ThreadSession {
  readonly items: TimelineItem[];
  readonly running: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_SESSION: ThreadSession = { items: [], running: false, loading: false, error: null };

/**
 * 会話の見え方。**真実はイベントログにあり、ここはその写しではない。**
 *
 * 開いたときに `/api/events` から読み直し、送信中は流れてくるものを継ぎ足す。
 * どちらも**サーバが積んだのと同じイベント**なので、履歴と実況で形が変わらない
 * （規則3：画面用の別形式を作らない）。
 *
 * **人の発言をここで作らない。** サーバが `message.recorded` として先に流すので、
 * 画面側でも作ると同じ発言が2つ並ぶ——それが「写しを持つと、いつか食い違う」の
 * いちばん小さい実例になる。
 */
export function useThreadSessions() {
  const [sessions, setSessions] = useState<Record<string, ThreadSession>>({});
  /** 読み込み済みのスレッド。**開くたびに取り直さない**が、覚えるのはこれだけ。 */
  const loaded = useRef<Set<string>>(new Set());

  const sessionFor = useCallback(
    (threadId: string): ThreadSession => sessions[threadId] ?? EMPTY_SESSION,
    [sessions],
  );

  const patch = useCallback((threadId: string, next: Partial<ThreadSession>) => {
    setSessions((prev) => ({ ...prev, [threadId]: { ...(prev[threadId] ?? EMPTY_SESSION), ...next } }));
  }, []);

  /** 過去を読み直す（要件 A8）。**開き直しても会話が残る**のはこれがあるから。 */
  const loadHistory = useCallback(
    async (threadId: string, force = false) => {
      if (!force && loaded.current.has(threadId)) return;
      loaded.current.add(threadId);
      patch(threadId, { loading: true, error: null });
      try {
        const events = await fetchEvents(threadId);
        patch(threadId, {
          items: events.map((event) => ({ id: localId(), event })),
          loading: false,
        });
      } catch (cause) {
        // 握りつぶさない（規則2）。読めなかったことを画面に出す。
        loaded.current.delete(threadId);
        patch(threadId, {
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [patch],
  );

  const send = useCallback(
    async (threadId: string, text: string, onSettled?: () => void) => {
      patch(threadId, { running: true, error: null });
      try {
        for await (const event of streamPrompt(threadId, text)) {
          setSessions((prev) => {
            const current = prev[threadId] ?? EMPTY_SESSION;
            return {
              ...prev,
              [threadId]: { ...current, items: [...current.items, { id: localId(), event }] },
            };
          });
        }
        patch(threadId, { running: false });
      } catch (cause) {
        // 握りつぶさない。ストリームが途中で切れても画面に理由を出す（規則2）。
        patch(threadId, {
          running: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        onSettled?.();
      }
    },
    [patch],
  );

  return { sessionFor, send, loadHistory };
}
