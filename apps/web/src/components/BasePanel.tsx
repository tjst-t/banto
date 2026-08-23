import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, GitFork, Loader2, RotateCcw, Undo2 } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { Button } from './ui/button';
import { appendBase, fetchBase, invalidateBase, reactivateBase } from '../lib/api';
import type { BaseEntry, BaseResponse } from '../lib/types';

/** 1画面に出す行数。**サーバ側でページングしない**——`appendBase` のゲートが
 * 1スレッドあたり `DEFAULT_BASE_LIMIT_CHARACTERS`（既定2万文字）で頭打ちにする
 * ので、行数もその範囲に収まる。ページングは画面側だけで足りる（規則10）。 */
const PAGE_SIZE = 20;

/**
 * **決まったこと**（base）を、そのスレッドについて見せて足す（要件 R2・R4・R6・R8）。
 *
 * ここまで base は会話の年表に「追記した」という点としてしか出ていなかった。
 * **いま何が決まっているのかを読む手段が画面に無かった**——足すたびに
 * 効き続けるものが、足した瞬間にしか見えないのは、いちばん静かな壊れ方である。
 *
 * ## 画面に出すと決めたこと
 *
 * 1. **継承した行と、自分で足した行を分ける**（要件 R4）。混ぜると
 *    「どこから来た決まりごとか」が消える。分け方は host が解く（規則3）
 * 2. **残りを常に見せる**（要件 R8）。**拒否されて初めてゲートの存在を知る**のを避ける
 * 3. **断られたら理由をそのまま出す**（規則2・決定4）。**黙って新しい会話へ
 *    切り替えない**——切り替えは人が決めること
 * 4. **訂正は無効化で行う**（PO裁定 2026-08-22）。上書きではなく、自分の行だけ
 *    無効化・有効化を切り替えられる——削除ではないので、いつでも戻せる
 * 5. **既定では有効な行だけを見せる**。無効化した行は増える一方なので、
 *    見たいときだけチェックボックスで呼び出す
 * 6. **検索・ページングは画面側だけで行う**（PO裁定 2026-08-22）。base は
 *    文字数の上限で頭打ちなので、サーバ側の対応するページング API は要らない
 */
export function BasePanel({ threadId, onChanged }: { threadId: string; onChanged: () => void }) {
  const [base, setBase] = useState<BaseResponse | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [showInvalidated, setShowInvalidated] = useState(false);
  const [page, setPage] = useState(1);

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

  // スレッドを切り替えたら、絞り込み・ページも仕切り直す。
  useEffect(() => {
    setSearch('');
    setShowInvalidated(false);
    setPage(1);
  }, [threadId]);

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

  /** 無効化⇄有効化の切り替え。**自分が追記した行だけ**（host がもう一度強制する）。 */
  const toggle = async (entry: BaseEntry) => {
    setBusy(true);
    setError(null);
    try {
      const next = entry.invalidated
        ? await reactivateBase({ threadId, baseVersion: entry.baseVersion })
        : await invalidateBase({ threadId, baseVersion: entry.baseVersion });
      setBase(next);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => {
    if (base === null) return [];
    const q = search.trim();
    return base.entries.filter(
      (e) => (showInvalidated || !e.invalidated) && (q === '' || e.text.includes(q)),
    );
  }, [base, search, showInvalidated]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageItems = visible.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);
  const invalidatedCount = base?.entries.filter((e) => e.invalidated).length ?? 0;
  const inheritedCount = base?.entries.filter((e) => !e.own).length ?? 0;

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
            第 {base.baseVersion} 版 ・ {base.entries.length} 行
            {inheritedCount > 0 && (
              <span className="ml-1 text-ink-muted">（うち {inheritedCount} 行は fork 元から）</span>
            )}
            {invalidatedCount > 0 && (
              <span className="ml-1 text-ink-muted">（無効化 {invalidatedCount} 行）</span>
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

      <div className="flex items-center gap-2 border-b border-rule-faint px-4 py-2">
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="決まったことを検索"
          className="h-[var(--h-ctl-sm)] min-w-0 flex-1 rounded-md border border-rule bg-paper px-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent"
        />
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-secondary">
          <input
            type="checkbox"
            checked={showInvalidated}
            onChange={(e) => {
              setShowInvalidated(e.target.checked);
              setPage(1);
            }}
            className="h-3.5 w-3.5 accent-[var(--accent)]"
          />
          無効化済みも表示
        </label>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-ink-muted">
            {base.entries.length === 0
              ? 'まだ何も決まっていません。ここに足したものは、以後のターンすべてに効きます。'
              : search.trim() !== ''
                ? `「${search}」に一致する行がありません。`
                : '表示できる行がありません。'}
          </p>
        ) : (
          <ol className="flex flex-col gap-1.5 p-3">
            {pageItems.map((entry) => (
              <li
                key={entry.baseVersion}
                className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${
                  entry.invalidated
                    ? 'bg-paper text-ink-muted shadow-[inset_2px_0_0_var(--rule)]'
                    : entry.own
                      ? 'bg-paper-raised text-ink shadow-rest'
                      : 'bg-paper text-ink-secondary shadow-[inset_2px_0_0_var(--rule-strong)]'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <span className="mr-2 font-mono text-xs text-ink-muted">v{entry.baseVersion}</span>
                  {!entry.own && (
                    <GitFork className="mr-1 inline h-3 w-3 align-[-1px] text-ink-muted" />
                  )}
                  {entry.invalidated && (
                    <span className="mr-1 rounded-sm bg-paper-sunken px-1 py-0.5 font-mono text-xs text-ink-muted">
                      無効化済み
                    </span>
                  )}
                  <span className={`whitespace-pre-wrap ${entry.invalidated ? 'line-through decoration-ink-muted' : ''}`}>
                    {entry.text}
                  </span>
                </div>
                {/* **自分の行だけ切り替えられる**（host が強制するのでここは表示の都合）。 */}
                {entry.own && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void toggle(entry)}
                    title={entry.invalidated ? '有効化する' : '無効化する'}
                    className="shrink-0 rounded-sm p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink disabled:opacity-50"
                  >
                    {entry.invalidated ? (
                      <RotateCcw className="h-3.5 w-3.5" />
                    ) : (
                      <Undo2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 border-t border-rule-faint px-3 py-1.5 text-xs text-ink-secondary">
          <button
            type="button"
            disabled={pageClamped <= 1}
            onClick={() => setPage(pageClamped - 1)}
            className="rounded-sm p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span>
            {pageClamped} / {totalPages} ページ
          </span>
          <button
            type="button"
            disabled={pageClamped >= totalPages}
            onClick={() => setPage(pageClamped + 1)}
            className="rounded-sm p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink disabled:opacity-30"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
