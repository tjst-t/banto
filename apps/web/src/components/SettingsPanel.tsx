import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react';

import { ResourceViewer } from './ResourceViewer';
import { ScrollArea } from './ui/scroll-area';
import { fetchModules } from '../lib/api';
import type { ModuleSummary } from '../lib/types';

/**
 * **モジュールの台帳**（要件 C1・C8c・C12）。
 *
 * 3つを出す：
 *
 * 1. **境界を常時見せる**（要件 C8c）。`isolation` と画面の `gui.kind` を隠さない
 *    ——「落ちてもホストが生きる」「鍵が AI と同居しない」は、見えていないと守られない
 * 2. **外したら何が壊れるか**（要件 C12）。**押す前に**分かる。無効化してから
 *    「動かない」と気づくのは、この要件が避けたい形そのものである
 * 3. **モジュール自身の設定の区画**（要件 C4）。**新しい機構は使っていない**——
 *    C14 の「モジュールが URI を持ち、ホストが面で開く」をそのまま置き場だけ変えたもの
 */
export function SettingsPanel() {
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ uri: string; name: string } | null>(null);

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
    void load();
  }, [load]);

  if (opened !== null) {
    return (
      <ResourceViewer uri={opened.uri} name={opened.name} onClose={() => setOpened(null)} />
    );
  }

  if (error !== null) {
    return (
      <div className="m-3 flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-xs text-critical">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="whitespace-pre-wrap">台帳が読めません: {error}</p>
      </div>
    );
  }

  if (modules === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-ink-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        読み込み中…
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-2 p-3">
        {modules.map((m) => (
          <li
            key={m.id}
            data-module-row={m.id}
            className="rounded-md border border-border bg-surface p-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-ink">{m.id}</span>
              {/* **境界は常時表示**（要件 C8c）。折りたたまない。 */}
              <span className="font-mono text-[10px] text-ink-muted">
                {m.isolation}
                {m.gui !== null && ` ・ 画面 ${m.gui.kind}`}
                {m.handlesSecrets && ' ・ 鍵を扱う'}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-ink-secondary">{m.description}</p>

            {m.provides.length > 0 && (
              <p className="mt-1 text-[10px] text-ink-muted">役割: {m.provides.join('・')}</p>
            )}

            {/* **外したら何が壊れるか**（要件 C12）。押す前に読める。 */}
            <p
              data-impact={m.id}
              className={`mt-2 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[11px] ${
                m.impact.breakages.length === 0
                  ? 'border-border bg-paper text-ink-muted'
                  : 'border-waiting/40 bg-waiting-soft text-ink'
              }`}
            >
              {m.impact.breakages.length > 0 && (
                <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-waiting" />
              )}
              無効化すると——{m.impact.summary}
            </p>

            {m.settingsUri !== null && (
              <button
                type="button"
                data-settings-of={m.id}
                onClick={() => setOpened({ uri: m.settingsUri as string, name: `${m.id} の設定` })}
                className="mt-2 text-[11px] font-medium text-accent hover:underline"
              >
                このモジュールの設定を開く
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* できないことを、できるかのように見せない（規則2）。
          **JSX は markdown を描かない**——強調は要素で書く。 */}
      <p className="px-4 pb-4 text-[10px] leading-relaxed text-ink-muted">
        無効化する口はまだありません。ここに出しているのは
        <strong className="font-semibold text-ink-secondary">外したときに何が壊れるか</strong>
        で、実際に外すのは起動時の設定です——実行中に依存を組み替えると、
        その機構自体が「黙って壊れる」候補になります。
      </p>
    </ScrollArea>
  );
}
