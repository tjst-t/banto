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
  readonly stage: string;
}

function runUri(runId: string): string {
  return `banto://factory/run/${encodeURIComponent(runId)}`;
}

/**
 * **Factory を可視化するGUI**（決定33・PO指摘 2026-08-25）。人がAIの`show`を
 * 待たずに直接開ける入口（要件C3・`launcher`）——`banto://factory/runs`から
 * `modules/factory`が畳んだ一覧をそのまま描くだけで、進捗の計算はここに無い（規則3）。
 */
export function FactoryRunsView({ text, onNavigate }: ModuleViewProps) {
  const runs: RunView[] = (() => {
    try {
      return JSON.parse(text) as RunView[];
    } catch {
      return [];
    }
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-module-view="factory/RunsView">
      <div className="border-b border-rule px-3 py-1.5">
        <p className="text-sm font-semibold text-ink">Factory</p>
        <p className="text-xs text-ink-muted">{runs.length} 件の Run</p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {runs.length === 0 ? (
          <p className="p-3 text-sm text-ink-muted">まだ Run が無い。会話から依頼すると、ここに出る。</p>
        ) : (
          <ul className="flex flex-col p-1">
            {runs.map((r) => (
              <li key={r.runId}>
                <button
                  type="button"
                  data-factory-run={r.runId}
                  onClick={() => onNavigate(runUri(r.runId), r.request)}
                  className="flex w-full flex-col gap-1 rounded-sm px-2 py-2 text-left hover:bg-paper-sunken"
                >
                  <div className="flex items-center gap-2">
                    <Badge tone={stageTone(r.stage)}>{stageLabel(r.stage)}</Badge>
                    <span className="truncate font-mono text-xs text-ink-muted">{r.branch}</span>
                  </div>
                  <p className="truncate text-sm text-ink">{r.request}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
