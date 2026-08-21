import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CirclePlay, GitBranch, Loader2 } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import type { RunSummary } from '../lib/types';

/**
 * Factory の面（要件 B1・B2）。
 *
 * **段は出さない。** 段は世界を見て毎回決まるもので（仕様 §5.3）、保存されていない。
 * 画面のために保存すると、それが第二の真実になる（規則3）。ここに出せるのは
 * **ログに在る事実だけ**——依頼・ブランチ・テスト結果・失敗。
 *
 * **「進める」は押したときだけ動く。** 時計で回すと、画面を閉じている間に
 * Claude の枠を使い続けることになる。誰が動かしたかが押した本人に分かる形にしてある。
 */
export function Runs({
  runs,
  onRequest,
  onAdvance,
  onOpenThread,
}: {
  runs: RunSummary[];
  onRequest: (request: string) => Promise<void>;
  onAdvance: () => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'request' | 'advance' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = async (kind: 'request' | 'advance', run: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await run();
    } catch (cause) {
      // 握りつぶさない（規則2）。何が起きたかを画面に出す。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex flex-col gap-2 border-b border-rule p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const value = text.trim();
          if (value === '') return;
          void guard('request', async () => {
            await onRequest(value);
            setText('');
          });
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="依頼を書く（例：README に使い方を1節足す）"
          className="w-full resize-none rounded-ctl border border-rule bg-paper px-2.5 py-2 text-body text-ink outline-none placeholder:text-ink-muted focus:border-rule-strong"
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" type="submit" disabled={busy !== null || text.trim() === ''}>
            {busy === 'request' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            依頼する
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy !== null || runs.length === 0}
            onClick={() => void guard('advance', onAdvance)}
            title="押したときだけ進みます（Claude の枠を使うため、自動では動きません）"
          >
            {busy === 'advance' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CirclePlay className="h-3.5 w-3.5" />
            )}
            進める
          </Button>
        </div>
        <p className="text-note text-ink-muted">
          投げるだけでは進みません。「進める」を押したときだけ走ります。
        </p>
      </form>

      {error && (
        <div className="flex items-start gap-2 border-b border-rule bg-stopped-soft px-3 py-2 text-meta text-ink shadow-[inset_3px_0_0_var(--stopped)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
          <span className="break-all">{error}</span>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {runs.length === 0 && (
            <p className="py-6 text-center text-body text-ink-muted">依頼はまだありません。</p>
          )}
          {runs.map((run) => {
            const last = run.testedCommits[run.testedCommits.length - 1];
            return (
              <button
                key={run.runId}
                type="button"
                onClick={() => onOpenThread(run.threadId)}
                className="rounded-ctl border border-rule bg-paper-raised px-3 py-2 text-left transition-colors hover:border-rule-strong"
              >
                <p className="line-clamp-2 text-body text-ink">{run.request}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-note text-ink-muted">
                  <span className="flex items-center gap-1 font-mono">
                    <GitBranch className="h-3 w-3" />
                    {run.branch}
                  </span>
                  {run.failed ? (
                    <Badge tone="stopped">失敗（人の判断待ち）</Badge>
                  ) : last === undefined ? (
                    <Badge tone="neutral">未検証</Badge>
                  ) : last.passed ? (
                    <Badge tone="done">
                      <CheckCircle2 className="mr-0.5 inline h-3 w-3" />
                      テスト通過
                    </Badge>
                  ) : (
                    <Badge tone="stopped">テスト失敗</Badge>
                  )}
                  {/* **sha を出す。** 結果はこの commit に対するもので、載せ直せば無効になる。 */}
                  {last && <span className="font-mono">{last.commit.slice(0, 7)}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
