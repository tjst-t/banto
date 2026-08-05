/**
 * 記憶ビューア（studio モジュール提供・ADR-0010 決定25）。
 *
 * 番頭が覚えている事実・好み・習慣を見せる。番頭に記憶があること（D11）が banto の核なので、
 * POが「何を覚えている？」を確かめられる場所が要る。
 *
 * **閲覧専用。** 削除は追記で表す設計（task-0023・D3）に属するので、ここからは行わない。
 */

import { useMemo, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorNote,
  Loading,
  Scroll,
  SearchField,
  Toggle,
  ViewBar,
  ViewShell,
  ViewTitle,
  formatRelative,
  formatTime,
  useTicker,
  type Tone,
} from "./ui.js";

interface MemoryRecord {
  id: string;
  kind: "preference" | "habit" | "fact";
  text: string;
  createdAt: string;
  refs?: string[];
  supersedes?: string;
}
interface MemoryList {
  records: MemoryRecord[];
}

const KINDS: ReadonlyArray<{ key: "" | MemoryRecord["kind"]; label: string; tone: Tone }> = [
  { key: "", label: "すべて", tone: "neutral" },
  { key: "fact", label: "事実", tone: "accent" },
  { key: "preference", label: "好み", tone: "ok" },
  { key: "habit", label: "習慣", tone: "warn" },
];

function toneOf(kind: string): Tone {
  return KINDS.find((k) => k.key === kind)?.tone ?? "neutral";
}
function labelOf(kind: string): string {
  return KINDS.find((k) => k.key === kind)?.label ?? kind;
}

export function MemoryViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialKind = typeof params["kind"] === "string" ? params["kind"] : "";
  const [kind, setKind] = useState(initialKind);
  /** 訂正済みも見るか。既定は今有効な記憶だけ（履歴を見たいときだけ出す） */
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  /** 手元にある一覧を絞るだけなので、打つたびに効かせる。 */
  const [filter, setFilter] = useState("");
  const now = useTicker(60_000);

  const list = useModuleTool<MemoryList>(endpoint, "studio.memory", {
    ...(kind ? { kind } : {}),
    includeSuperseded,
  });
  const records = list.data?.records ?? [];

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return records;
    return records.filter((r) => r.text.toLowerCase().includes(q) || (r.refs ?? []).join(" ").toLowerCase().includes(q));
  }, [records, filter]);

  return (
    <ViewShell className="st">
      <ViewBar>
        <ViewTitle icon="🧠" count={shown.length}>
          記憶
        </ViewTitle>
        <span className="cv-spacer" />
        <Button small variant="ghost" onClick={() => list.reload()} title="取り直す">
          ⟳
        </Button>
      </ViewBar>
      <ViewBar>
        {KINDS.map((k) => (
          <Chip key={k.key} on={kind === k.key} onClick={() => setKind(k.key)}>
            {k.label}
          </Chip>
        ))}
        <span className="cv-spacer" />
        <Toggle
          checked={includeSuperseded}
          onChange={setIncludeSuperseded}
          title="訂正で置き換えられた古い記憶も一覧に出す"
        >
          訂正前の記憶も表示
        </Toggle>
      </ViewBar>
      <ViewBar>
        <SearchField value={filter} onChange={setFilter} placeholder="覚えている内容で絞る" />
      </ViewBar>

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}

      <Scroll>
        {list.loading && !list.data ? (
          <Loading rows={4} />
        ) : shown.length === 0 ? (
          <EmptyState icon="🧠" title={filter ? "当てはまる記憶はありません" : "まだ何も覚えていません"}>
            {filter
              ? "絞り込みを外すと全部出ます。"
              : "話しているうちに、番頭が覚えたことがここに並びます。"}
          </EmptyState>
        ) : (
          <div className="cv-cards">
            {shown.map((r) => (
              <Card key={r.id}>
                <div className="st-card-head">
                  <Badge tone={toneOf(r.kind)}>{labelOf(r.kind)}</Badge>
                  {/* 訂正で置き換えた記憶があることを示す（何を直したのか辿れるように） */}
                  {r.supersedes && (
                    <Badge tone="warn" title={`置き換えた記憶: ${r.supersedes}`}>
                      訂正
                    </Badge>
                  )}
                  <span className="cv-spacer" />
                  <span className="cv-muted" title={formatTime(r.createdAt)}>
                    {formatRelative(r.createdAt, now) || formatTime(r.createdAt)}
                  </span>
                </div>
                <div className="st-text">{r.text}</div>
                {r.refs && r.refs.length > 0 && <div className="st-refs">{r.refs.join(" · ")}</div>}
              </Card>
            ))}
          </div>
        )}
      </Scroll>
    </ViewShell>
  );
}
