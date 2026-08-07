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
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  MetaList,
  Modal,
  Scroll,
  SearchField,
  WorkView,
  TextInput,
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

interface ProjectRow {
  id: string;
  repoPath: string;
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
  const [registering, setRegistering] = useState(false);
  useTicker(15_000);

  // 終わったものも含めて全部引く。ボードは「何が終わったか」も読む場所（決定62e）
  const list = useModuleTool<{ tasks: TaskRow[] }>(endpoint, "kobo.list", {
    state: "all",
    limit: 100,
    ...(initialProject ? { projectTag: initialProject } : {}),
  });
  // 受け持ち（統治単位）。**空なら、まずここから**——タスクを積む先が無い状態
  const projects = useModuleTool<{ projects: ProjectRow[] }>(endpoint, "kobo.projects", {});
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
        <Badge tone="neutral">
          受け持ち {projects.data?.projects.length ?? 0}
        </Badge>
        <Button small variant="ghost" onClick={() => setRegistering(true)}>
          ＋ 受け持たせる
        </Button>
      </ViewBar>
      {list.loading && !list.data ? (
        <Loading label="工場に聞いています…" />
      ) : list.error ? (
        // I2: 届かないことを「何も無い」と見せない
        <ErrorNote title="工場に届きません" onRetry={list.reload}>
          {list.error}（banto-daemon が動いているか確かめてください）
        </ErrorNote>
      ) : tasks.length === 0 ? (
        (projects.data?.projects.length ?? 0) === 0 ? (
          // **受け持ちが無いと、積む先が無い。** 最初にやることをここで言う
          <EmptyState
            icon="repo"
            title="受け持っているリポジトリがありません"
            action={
              <Button variant="primary" onClick={() => setRegistering(true)}>
                受け持たせる
              </Button>
            }
          >
            工場はリポジトリ単位で受け持ちます。登録すると、そのリポジトリの仕事が
            「積む→ゲート→職人→監査→レビュー→マージ」の流れに乗ります。
          </EmptyState>
        ) : (
          <EmptyState icon="inbox" title="タスクがありません">
            番頭に仕事を頼むと、ここに並びます。
          </EmptyState>
        )
      ) : (
        <Scroll className="kb-board">
          {columns.map((column) => (
            <section
              key={column.key}
              className={`kb-col${column.rows.length === 0 ? " is-empty" : ""}`}
            >
              <header className="kb-col-head">
                <span>{column.label}</span>
                <Badge tone={column.rows.length > 0 ? column.tone ?? "neutral" : "neutral"}>
                  {column.rows.length}
                </Badge>
              </header>
              <div className="kb-col-body">
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
              </div>
            </section>
          ))}
        </Scroll>
      )}
    </ViewShell>
  );

  const registerPane = registering ? (
    <RegisterProject
      endpoint={endpoint}
      known={projects.data?.projects ?? []}
      onClose={() => setRegistering(false)}
      onDone={() => {
        setRegistering(false);
        projects.reload();
        list.reload();
      }}
    />
  ) : null;

  const task = detail.data?.task as Record<string, unknown> | undefined;
  const scope = (task?.["scope"] as { paths?: string[] } | undefined)?.paths ?? [];
  const detailPane = !selected ? null : detail.loading && !detail.data ? (
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
    <>
      {registerPane}
      {/* ボードは**横に流すカンバン**。狭い方に入れると列がほとんど見えない（PO報告） */}
      <WorkView
        main={board}
        detail={detailPane}
        onBack={() => setSelected(undefined)}
        backLabel="ボードへ"
      />
    </>
  );
}

/**
 * リポジトリを受け持たせる面。
 *
 * **PO が自分で登録できるようにする**（決定25：人はGUI、番頭は Tool。契約は1つ）。
 * ここから呼ぶのも番頭が呼ぶのも同じ `kobo.register_project` で、判断は工場側にある（D5）。
 */
function RegisterProject({
  endpoint,
  known,
  onClose,
  onDone,
}: {
  endpoint: string;
  known: ProjectRow[];
  onClose: () => void;
  onDone: () => void;
}): React.ReactElement {
  const [projectTag, setProjectTag] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await callModuleTool(endpoint, "kobo.register_project", {
        projectTag: projectTag.trim(),
        repoPath: repoPath.trim(),
      });
      onDone();
    } catch (err) {
      // I2: 押したのに何も起きなかったように見せない
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="リポジトリを受け持たせる"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            やめる
          </Button>
          <Button
            variant="primary"
            disabled={busy || projectTag.trim() === "" || repoPath.trim() === ""}
            onClick={() => void submit()}
          >
            {busy ? "登録しています…" : "受け持たせる"}
          </Button>
        </>
      }
    >
      <p className="kb-para">
        登録すると、そのリポジトリの仕事は「積む→ゲート→職人→監査→レビュー→マージ」の
        流れに乗ります。<strong>名前は後から変えられません</strong>——帳簿のイベントが
        全部この名前で残ります。
      </p>
      <label className="kb-field">
        <span>名前（統治単位）</span>
        <TextInput
          value={projectTag}
          onChange={(e) => setProjectTag(e.target.value)}
          placeholder="loamium"
        />
      </label>
      <label className="kb-field">
        <span>リポジトリの絶対パス</span>
        <TextInput
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="/home/you/ghq/github.com/you/loamium"
        />
      </label>
      {known.length > 0 && (
        <p className="kb-known">
          いま受け持っているもの：{known.map((p) => p.id).join(", ")}
        </p>
      )}
      {error && <ErrorNote title="受け持たせられません">{error}</ErrorNote>}
    </Modal>
  );
}
