import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import { fetchModules } from '../../lib/api';
import type { ModuleSummary } from '../../lib/types';

/**
 * 設定（要件 C1・C8c・C12・C4）。
 *
 * 4つを出す：
 *
 * 1. **共有base**（決定30）。全スレッド共通のbase——会話をしないスレッドなので
 *    「開いているもの」には出ない。サイドバー固定部を使うほどの機能ではないので、
 *    ここに置く
 * 2. **境界を常時見せる**（要件 C8c）。`isolation` と画面の `gui.kind` を隠さない
 *    ——「落ちてもホストが生きる」「鍵が AI と同居しない」は、見えていないと守られない
 * 3. **外したら何が壊れるか**（要件 C12）。**押す前に**分かる
 * 4. **モジュール自身の設定**（要件 C4）。押すと作業パネルで開く
 *    ——設定ダイアログの中にもう1枚別の面を作らない（規則3：置き場を増やさない）
 */
export function SettingsDialog({
  open,
  onOpenChange,
  onOpenResource,
  sharedBaseThreadId,
  onOpenBase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenResource: (uri: string, name: string) => void;
  /** 決定30：無ければまだ何も共有されていないだけで、区画自体は出す。 */
  sharedBaseThreadId: string | undefined;
  onOpenBase: (threadId: string, title: string) => void;
}) {
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setModules(await fetchModules());
      setError(null);
    } catch (cause) {
      // 握りつぶさない（規則2）。台帳が読めないことを画面に出す。
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent widthClassName="max-w-2xl">
        <div className="border-b border-rule-faint px-6 pb-3 pt-6">
          <DialogTitle className="text-2xl font-semibold tracking-tight text-ink">設定</DialogTitle>
          <p className="mt-0.5 text-sm text-ink-secondary">モジュールの台帳</p>
        </div>

        <div className="border-b border-rule-faint px-6 py-3">
          <p className="text-sm font-semibold text-ink">共有base</p>
          <p className="mt-0.5 text-xs text-ink-secondary">
            会話をしない、全スレッド共通のbase。プロジェクトを問わず成り立つ事実だけを置く場所
          </p>
          <button
            type="button"
            data-open-shared-base
            disabled={sharedBaseThreadId === undefined}
            onClick={() => {
              if (sharedBaseThreadId === undefined) return;
              onOpenBase(sharedBaseThreadId, '共有base');
              onOpenChange(false);
            }}
            className="mt-2 text-xs font-medium text-accent hover:underline disabled:text-ink-muted disabled:no-underline"
          >
            共有baseを開く
          </button>
        </div>

        {error !== null ? (
          <div className="m-4 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
            <p className="whitespace-pre-wrap">台帳が読めません: {error}</p>
          </div>
        ) : modules === null ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            読み込み中…
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-2 p-6">
              {modules.map((m) => (
                <li key={m.id} data-module-row={m.id} className="rounded-md bg-paper-raised p-3 shadow-rest">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-ink">{m.id}</span>
                    {/* **境界は常時表示**（要件 C8c）。折りたたまない。 */}
                    <span className="font-mono text-xs text-ink-muted">
                      {m.isolation}
                      {m.gui !== null && ` ・ 画面 ${m.gui.kind}`}
                      {m.handlesSecrets && ' ・ 鍵を扱う'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-secondary">{m.description}</p>

                  {m.provides.length > 0 && (
                    <p className="mt-1 text-xs text-ink-muted">役割: {m.provides.join('・')}</p>
                  )}

                  {/* **外したら何が壊れるか**（要件 C12）。押す前に読める。 */}
                  <p
                    data-impact={m.id}
                    className={`mt-2 flex items-start gap-1.5 rounded-sm px-2 py-1.5 text-xs ${
                      m.impact.breakages.length === 0
                        ? 'bg-paper text-ink-muted'
                        : 'bg-attention-soft text-ink shadow-[inset_2px_0_0_var(--attention)]'
                    }`}
                  >
                    {m.impact.breakages.length > 0 && (
                      <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-attention" />
                    )}
                    無効化すると——{m.impact.summary}
                  </p>

                  {m.settingsUri !== null && (
                    <button
                      type="button"
                      data-settings-of={m.id}
                      onClick={() => {
                        onOpenResource(m.settingsUri as string, `${m.id} の設定`);
                        onOpenChange(false);
                      }}
                      className="mt-2 text-xs font-medium text-accent hover:underline"
                    >
                      このモジュールの設定を開く
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {/* できないことを、できるかのように見せない（規則2）。 */}
            <p className="px-6 pb-6 text-xs leading-relaxed text-ink-muted">
              無効化する口はまだありません。ここに出しているのは
              <strong className="font-semibold text-ink-secondary">外したときに何が壊れるか</strong>
              で、実際に外すのは起動時の設定です——実行中に依存を組み替えると、
              その機構自体が「黙って壊れる」候補になります。
            </p>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
