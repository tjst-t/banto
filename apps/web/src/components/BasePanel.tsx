import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, GitFork, Loader2 } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { appendBase, fetchBase } from '../lib/api';
import type { BaseResponse } from '../lib/types';

/**
 * **決まったこと**（base）を、そのスレッドについて見せて足す（要件 R2・R4・R6・R8）。
 *
 * ここまで base は会話の年表に「追記した」という点としてしか出ていなかった。
 * **いま何が決まっているのかを読む手段が画面に無かった**——足すたびに
 * 効き続けるものが、足した瞬間にしか見えないのは、いちばん静かな壊れ方である。
 *
 * ## 3つ、画面に出すと決めたこと
 *
 * 1. **継承した行と、自分で足した行を分ける**（要件 R4）。混ぜると
 *    「どこから来た決まりごとか」が消える。分け方は host が解く（規則3）
 * 2. **残りを常に見せる**（要件 R8）。**拒否されて初めてゲートの存在を知る**のを避ける
 * 3. **断られたら理由をそのまま出す**（規則2・決定4）。**黙って新しい会話へ
 *    切り替えない**——切り替えは人が決めること
 */
export function BasePanel({ threadId, onChanged }: { threadId: string; onChanged: () => void }) {
  const [base, setBase] = useState<BaseResponse | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBase(await fetchBase(threadId));
      setError(null);
    } catch (cause) {
      // 握りつぶさない（規則2）。読めなかったことを画面に出す。
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      setBase(await appendBase({ threadId, text: text.trim() }));
      setText('');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (base === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-ink-muted">
        {error === null ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            読み込み中…
          </>
        ) : (
          <span className="text-stopped">読めませんでした: {error}</span>
        )}
      </div>
    );
  }

  const ratio = base.limit === 0 ? 0 : base.characters / base.limit;
  const tone = ratio >= 1 ? 'bg-stopped' : ratio >= 0.8 ? 'bg-attention' : 'bg-accent';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-rule px-4 py-2.5">
        <div className="flex items-baseline justify-between gap-2 text-xs text-ink-secondary">
          <span>
            第 {base.baseVersion} 版 ・ {base.lines.length} 行
            {base.inherited > 0 && (
              <span className="ml-1 text-ink-muted">（うち {base.inherited} 行は fork 元から）</span>
            )}
          </span>
          {/* **残りを常に見せる**（要件 R8）。拒否されて初めて知る、を避ける。 */}
          <span className={ratio >= 0.8 ? 'text-attention' : 'text-ink-muted'}>
            {base.characters.toLocaleString()} / {base.limit.toLocaleString()} 文字
          </span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-sm bg-paper-sunken">
          <div
            className={`h-full ${tone}`}
            style={{ width: `${Math.min(100, ratio * 100).toFixed(1)}%` }}
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {base.lines.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-muted">
            まだ何も決まっていません。ここに足したものは、以後のターンすべてに効きます。
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5 p-3">
            {base.lines.map((line, i) => (
              <li
                key={`${i}-${line.slice(0, 24)}`}
                className={`rounded-md px-3 py-2 text-sm ${
                  i < base.inherited
                    ? 'bg-paper text-ink-secondary shadow-[inset_2px_0_0_var(--rule-strong)]'
                    : 'bg-paper-raised text-ink shadow-rest'
                }`}
              >
                <span className="mr-2 font-mono text-xs text-ink-muted">v{i + 1}</span>
                {i < base.inherited && (
                  <GitFork className="mr-1 inline h-3 w-3 align-[-1px] text-ink-muted" />
                )}
                <span className="whitespace-pre-wrap">{line}</span>
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>

      {error !== null && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-xs text-ink shadow-[inset_2px_0_0_var(--stopped)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
          {/* **断られた理由をそのまま出す。** 自動で会話を切り替えない（決定4）。 */}
          <p className="whitespace-pre-wrap">{error}</p>
        </div>
      )}

      <div className="flex gap-1.5 border-t border-rule p-3">
        <input
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send();
          }}
          placeholder="決まったことを1行で足す"
          className="h-[var(--h-ctl-sm)] min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent disabled:opacity-50"
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || text.trim() === ''}
          onClick={() => void send()}
        >
          足す
        </Button>
      </div>
    </div>
  );
}
