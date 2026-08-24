import { ArrowLeft } from 'lucide-react';

import { Badge } from '../components/ui/badge';
import { ScrollArea } from '../components/ui/scroll-area';
import { stageLabel, stageTone } from './factoryStage';
import type { ModuleViewProps } from './registry';

interface RunView {
  readonly runId: string;
  readonly threadId: string;
  readonly branch: string;
  readonly request: string;
  readonly failed: boolean;
  readonly testedCommits: { readonly commit: string; readonly passed: boolean }[];
  readonly stage: string;
}

const RUNS_URI = 'banto://factory/runs';

/**
 * Factory の Run 1件（決定33）。AI の `request_run` が返す `uri` を `show` すると
 * ここが開く（決定19と同じ経路）——人がサイドバーの「ツール」から一覧
 * （`FactoryRunsView`）を経由して開いたときも、同じ面を通る（要件C2）。
 */
export function FactoryRunView({ text, onNavigate }: ModuleViewProps) {
  let run: RunView | null;
  try {
    run = JSON.parse(text) as RunView;
  } catch {
    run = null;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-module-view="factory/RunView">
      <div className="border-b border-rule px-3 py-1.5">
        <button
          type="button"
          onClick={() => onNavigate(RUNS_URI, 'Factory')}
          className="flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3 w-3" />
          一覧へ
        </button>
      </div>

      {run === null ? (
        <p className="p-3 text-sm text-ink-muted">読めない形——Run が見つからないか、形が壊れている。</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3 p-3">
            <div className="flex items-center gap-2">
              <Badge tone={stageTone(run.stage)}>{stageLabel(run.stage)}</Badge>
              {run.failed && <Badge tone="stopped">失敗が記録されている</Badge>}
            </div>

            <p className="whitespace-pre-wrap text-sm text-ink">{run.request}</p>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-ink-muted">branch</dt>
              <dd className="font-mono text-ink-secondary">{run.branch}</dd>
              <dt className="text-ink-muted">runId</dt>
              <dd className="font-mono text-ink-secondary">{run.runId}</dd>
            </dl>

            {run.testedCommits.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-ink-secondary">テスト結果</p>
                <ul className="flex flex-col gap-1">
                  {run.testedCommits.map((t) => (
                    <li key={t.commit} className="flex items-center gap-2 text-xs">
                      <Badge tone={t.passed ? 'done' : 'stopped'}>{t.passed ? '通った' : '落ちた'}</Badge>
                      <span className="font-mono text-ink-muted">{t.commit.slice(0, 12)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
