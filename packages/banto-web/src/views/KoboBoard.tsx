/**
 * 工場のボード＝タスクの状態機械のビューア（ADR-0013 決定56、task-0049）。
 *
 * **「いま何が動いていて、何で止まっているか」が一目で分かる**ことが目的。
 * かんばんの Now / Next / Later は状態の**集約ビュー**であって別の状態ではない
 * （spec-daemon-core §1）——だから列は状態から機械的に作り、独自の分類を持たない。
 *
 * データは kobo モジュールのデータAPIから取る（決定25）。番頭のToolは呼ばない。
 * **閲覧専用。** 承認はレビュー面（`KoboReview`）の仕事で、ここからは進めない——
 * 一覧を見ながら押せると、経緯を読まずに通すことになる（決定57 の一次受けが形骸化する）。
 */

import { useEffect, useMemo, useState } from "react";
import "./kobo.css";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  MetaList,
  Scroll,
  SearchField,
  SplitView,
  ViewBar,
  ViewShell,
  formatRelative,
  formatTime,
  useTicker,
  type Tone,
} from "./ui.js";

interface TaskRow {
  taskId: string;
  projectTag: string;
  status: string;
  title: string;
}

interface HistoryRow {
  type: string;
  at: string;
  detail: string;
}

interface TaskDetail {
  task: Record<string, unknown>;
  reviewStage?: string;
  envUrl?: string;
  history: HistoryRow[];
}

/**
 * 状態の並び。**工場の流れの順**に置く（左から右へ進む）。
 *
 * 列にまとめるのは「見るとき人が知りたい粒度」であって、状態そのものは畳まない
 * ——詳細には生の状態を出す。
 */
const COLUMNS: ReadonlyArray<{ key: string; label: string; states: string[]; tone?: Tone }> = [
  { key: "waiting", label: "待ち", states: ["queued"], tone: "neutral" },
  { key: "next", label: "着手できる", states: ["ready"], tone: "accent" },
  { key: "now", label: "動いている", states: ["planning", "implementing", "auditing"], tone: "ok" },
  { key: "review", label: "判断待ち", states: ["review-ready", "in-review"], tone: "warn" },
  { key: "merging", label: "マージ", states: ["approved", "merging"], tone: "accent" },
  { key: "stuck", label: "止まっている", states: ["paused", "failed"], tone: "danger" },
  { key: "done", label: "終わった", states: ["merged", "evaluating", "closed", "superseded"] },
];

const STATUS_LABEL: Record<string, string> = {
  queued: "待ち",
  ready: "着手できる",
  planning: "計画",
  implementing: "実装",
  auditing: "監査",
  "review-ready": "判断待ち",
  "in-review": "レビュー中",
  approved: "承認済み",
  merging: "マージ中",
  merged: "マージ済み",
  evaluating: "評価",
  closed: "完了",
  paused: "保留",
  failed: "失敗",
  superseded: "置き換え",
};

function toneOf(status: string): Tone {
  return COLUMNS.find((c) => c.states.includes(status))?.tone ?? "neutral";
}

export function KoboBoard({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialProject = typeof params["projectTag"] === "string" ? params["projectTag"] : undefined;
  const initialTask = typeof params["taskId"] === "string" ? params["taskId"] : undefined;

  const [selected, setSelected] = useState<{ projectTag: string; taskId: string } | undefined>(
    initialProject && initialTask ? { projectTag: initialProject, taskId: initialTask } : undefined
  );
  const [query, setQuery] = useState("");
  useTicker(15_000);

  // 終わったものも含めて全部引く。ボードは「何が終わったか」も読む場所（決定62e）
  const list = useModuleTool<{ tasks: TaskRow[] }>(endpoint, "kobo.list", {
    state: "all",
    limit: 100,
    ...(initialProject ? { projectTag: initialProject } : {}),
  });
  const detail = useModuleTool<TaskDetail>(
    endpoint,
    "kobo.task",
    selected ? { projectTag: selected.projectTag, taskId: selected.taskId } : undefined
  );

  // **見ている間は取り直す。** 工場は勝手に進むので、開きっぱなしのボードが止まって
  // 見えると「何も動いていない」と誤読する（決定56 の工場は非同期に動く）
  const reloadList = list.reload;
  useEffect(() => {
    const timer = setInterval(() => reloadList(), 8000);
    return () => clearInterval(timer);
  }, [reloadList]);

  const tasks = useMemo(() => {
    const rows = list.data?.tasks ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((t) =>
      [t.taskId, t.title, t.status, t.projectTag].join(" ").toLowerCase().includes(needle)
    );
  }, [list.data, query]);

  const columns = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        rows: tasks.filter((t) => column.states.includes(t.status)),
      })),
    [tasks]
  );

  const board = (
    <ViewShell>
      <ViewBar>
        <SearchField value={query} onChange={setQuery} placeholder="タスクを絞る" />
        <Badge tone="neutral">{tasks.length} 件</Badge>
      </ViewBar>
      {list.loading && !list.data ? (
        <Loading label="工場に聞いています…" />
      ) : list.error ? (
        // I2: 届かないことを「何も無い」と見せない
        <ErrorNote title="工場に届きません" onRetry={list.reload}>
          {list.error}（banto-daemon が動いているか確かめてください）
        </ErrorNote>
      ) : tasks.length === 0 ? (
        <EmptyState icon="inbox" title="タスクがありません">
          番頭に仕事を頼むと、ここに並びます。
        </EmptyState>
      ) : (
        <Scroll className="kb-board">
          {columns.map((column) => (
            <section key={column.key} className="kb-col">
              <header className="kb-col-head">
                <span>{column.label}</span>
                <Badge tone={column.rows.length > 0 ? column.tone ?? "neutral" : "neutral"}>
                  {column.rows.length}
                </Badge>
              </header>
              {column.rows.length === 0 ? (
                <p className="kb-col-empty">—</p>
              ) : (
                column.rows.map((task) => (
                  <Card
                    key={`${task.projectTag}/${task.taskId}`}
                    tone={column.tone}
                    selected={
                      selected?.taskId === task.taskId && selected?.projectTag === task.projectTag
                    }
                    onClick={() =>
                      setSelected({ projectTag: task.projectTag, taskId: task.taskId })
                    }
                  >
                    <div className="kb-card-title">{task.title || task.taskId}</div>
                    <div className="kb-card-meta">
                      <span className="is-mono">{task.taskId}</span>
                      <span>{STATUS_LABEL[task.status] ?? task.status}</span>
                    </div>
                  </Card>
                ))
              )}
            </section>
          ))}
        </Scroll>
      )}
    </ViewShell>
  );

  const task = detail.data?.task as Record<string, unknown> | undefined;
  const scope = (task?.["scope"] as { paths?: string[] } | undefined)?.paths ?? [];
  const detailPane = !selected ? (
    <EmptyState icon="canvas" title="タスクを選ぶ">
      経緯（何が起きてきたか）が読めます。
    </EmptyState>
  ) : detail.loading && !detail.data ? (
    <Loading label="経緯を読んでいます…" />
  ) : detail.error ? (
    <ErrorNote title="読めません" onRetry={detail.reload}>
      {detail.error}
    </ErrorNote>
  ) : (
    <ViewShell>
      <ViewBar>
        <strong>{String(task?.["title"] ?? selected.taskId)}</strong>
        <Badge tone={toneOf(String(task?.["status"] ?? ""))}>
          {STATUS_LABEL[String(task?.["status"] ?? "")] ?? String(task?.["status"] ?? "")}
        </Badge>
      </ViewBar>
      <Scroll>
        <MetaList
          items={[
            { label: "ID", value: selected.taskId, mono: true },
            { label: "プロジェクト", value: selected.projectTag },
            { label: "種別", value: String(task?.["kind"] ?? "—") },
            {
              label: "レビュー",
              value:
                detail.data?.reviewStage === "po"
                  ? "PO の判断が要る"
                  : detail.data?.reviewStage === "auto"
                    ? "自動（人も番頭も見ない）"
                    : "番頭が一次受け",
            },
            {
              label: "変更の範囲",
              value: scope.length > 0 ? scope.join(", ") : "—",
              mono: true,
            },
            ...(detail.data?.envUrl
              ? [
                  {
                    label: "触れる場所",
                    value: (
                      <a href={detail.data.envUrl} target="_blank" rel="noreferrer">
                        {detail.data.envUrl}
                      </a>
                    ),
                  },
                ]
              : []),
            ...(typeof task?.["originRef"] === "string"
              ? [{ label: "経緯", value: String(task["originRef"]) }]
              : []),
          ]}
        />
        <h3 className="kb-h">これまで</h3>
        <ol className="kb-history">
          {(detail.data?.history ?? []).map((row, index) => (
            <li key={`${row.at}-${index}`}>
              <span className="kb-history-at" title={formatTime(row.at)}>
                {formatRelative(row.at)}
              </span>
              <span className="kb-history-type">{row.type}</span>
              {row.detail && <span className="kb-history-detail">{row.detail}</span>}
            </li>
          ))}
        </ol>
      </Scroll>
    </ViewShell>
  );

  return (
    <SplitView
      size="lg"
      list={board}
      detail={detailPane}
      showDetail={selected !== undefined}
      onBack={() => setSelected(undefined)}
      backLabel="ボードへ"
    />
  );
}
