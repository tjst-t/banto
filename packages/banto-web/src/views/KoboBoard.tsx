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
  Select,
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
  /** 起こした職人（`agent_spawned` にだけ付く）。ここから職人ビューアへ飛ぶ。 */
  sessionId?: string;
  type: string;
  at: string;
  detail: string;
}

interface ProjectRow {
  id: string;
  repoPath: string;
}

/** 落ちた理由（`kobo.task` が failed のときだけ返す・task-0081） */
interface TaskFailure {
  reason?: string;
  gateReasons: string[];
  logs: Array<{ acId: string; dir: string; tail: string }>;
  reopenCount: number;
}

interface TaskDetail {
  task: Record<string, unknown>;
  reviewStage?: string;
  envUrl?: string;
  history: HistoryRow[];
  failure?: TaskFailure;
}

/**
 * 状態の並び。**工場の流れの順**に置く（左から右へ進む）。
 *
 * 列にまとめるのは「見るとき人が知りたい粒度」であって、状態そのものは畳まない
 * ——詳細には生の状態を出す。
 */
/**
 * **あなたを待っているもの**（帳場の主）。
 *
 * 判断待ちが先、止まっているが後——どちらも PO の手が要るが、
 * 「決める」の方が「直す」より軽くて速い。軽い方から片付く順に並べる。
 */
const MINE: ReadonlyArray<{ key: string; label: string; states: string[]; kind: "mine" | "stuck" }> = [
  { key: "judge", label: "決めてほしい", states: ["review-ready", "in-review"], kind: "mine" },
  { key: "stuck", label: "止まっている", states: ["failed", "paused"], kind: "stuck" },
];

/** **流れ**（従）。番頭と職人が回している工程。読み飛ばして良い */
const FLOW: ReadonlyArray<{ key: string; label: string; states: string[] }> = [
  { key: "waiting", label: "待ち", states: ["queued"] },
  { key: "next", label: "着手できる", states: ["ready"] },
  { key: "now", label: "動いている", states: ["planning", "implementing", "auditing"] },
  { key: "merging", label: "マージ", states: ["approved", "merging"] },
  { key: "done", label: "片が付いた", states: ["merged", "evaluating", "closed", "superseded"] },
];

/** 面の検体と経緯の色分けが同じ表を見るように、全部の列をまとめて持つ */
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

export function KoboBoard({
  params,
  endpoint,
  openCanvas,
}: CanvasViewProps): React.ReactElement {
  const initialProject = typeof params["projectTag"] === "string" ? params["projectTag"] : undefined;
  const initialTask = typeof params["taskId"] === "string" ? params["taskId"] : undefined;

  const [selected, setSelected] = useState<{ projectTag: string; taskId: string } | undefined>(
    initialProject && initialTask ? { projectTag: initialProject, taskId: initialTask } : undefined
  );
  const [query, setQuery] = useState("");
  const [registering, setRegistering] = useState(false);
  /** 落ちた札を直すときの入力と手応え（I2：押したのに何も起きない、を作らない） */
  const [fixReason, setFixReason] = useState("");
  const [fixBusy, setFixBusy] = useState(false);
  const [fixError, setFixError] = useState<string | undefined>(undefined);
  const [fixDone, setFixDone] = useState<string | undefined>(undefined);
  useTicker(15_000);

  /** 受け持ちで絞る（PO要望 2026-08-07）。空文字＝全部。 */
  const [project, setProject] = useState<string>(initialProject ?? "");
  /**
   * 片が付いたものも出すか（prop-0001 第1段・既定は出さない）。
   *
   * **終わったタスクは消えないので、放っておくと 100 件の枠を埋めて動いているものを
   * 押し出す**（実機で 340 件中 100 件しか出ない状態になっていた）。既定を
   * 「まだ見る必要があるもの」にして、枠を動いているタスクに使う。
   * **何も捨てていない**——見るときは切り替えれば出る。
   */
  const [showDone, setShowDone] = useState(false);
  const list = useModuleTool<{ tasks: TaskRow[]; total?: number; truncated?: boolean }>(endpoint, "kobo.list", {
    // **既定は渡さない。** 線引きは Kobo が持つ（D5）——ここで state を指定すると
    // 面ごとに違う既定を持つことになり、番頭と PO が違うものを見る
    ...(showDone ? { state: "all" } : {}),
    limit: 100,
    ...(project ? { projectTag: project } : {}),
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

  /** 帳場の主：あなたを待っているもの */
  const mine = useMemo(
    () => MINE.map((g) => ({ ...g, rows: tasks.filter((t) => g.states.includes(t.status)) })),
    [tasks]
  );
  const mineCount = mine.reduce((n, g) => n + g.rows.length, 0);
  /** 帳場の従：番頭と職人が回している工程 */
  const flow = useMemo(
    () => FLOW.map((g) => ({ ...g, rows: tasks.filter((t) => g.states.includes(t.status)) })),
    [tasks]
  );

  /** 落ちた札を動かし直す。**理由は必須**（帳簿に残り、職人にも渡る） */
  const fixTask = async (
    tool: "kobo.reopen" | "kobo.abandon",
    mode?: "rework" | "reverify"
  ): Promise<void> => {
    if (!selected || !fixReason.trim()) return;
    setFixBusy(true);
    setFixError(undefined);
    try {
      await callModuleTool(endpoint, tool, {
        projectTag: selected.projectTag,
        taskId: selected.taskId,
        reason: fixReason.trim(),
        ...(mode ? { mode } : {}),
      });
      setFixDone(
        tool === "kobo.abandon"
          ? "畳みました"
          : mode === "rework"
            ? "職人に直させています"
            : "関所をもう一度回しています"
      );
      setFixReason("");
      list.reload();
      detail.reload();
    } catch (err) {
      // I2: 押したのに何も起きなかったように見せない
      setFixError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixBusy(false);
    }
  };

  const board = (
    <ViewShell>
      <ViewBar>
        <SearchField value={query} onChange={setQuery} placeholder="タスクを絞る" />
        {(projects.data?.projects.length ?? 0) > 0 && (
          <Select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            aria-label="受け持ちで絞る"
          >
            <option value="">受け持ち：すべて</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </Select>
        )}
        {/* 既定は「まだ見る必要があるもの」。片が付いたものはここで出す（prop-0001 第1段） */}
        <Button
          small
          variant={showDone ? "primary" : "ghost"}
          onClick={() => setShowDone((v) => !v)}
          aria-pressed={showDone}
        >
          {showDone ? "片が付いたものも表示中" : "片が付いたものも見る"}
        </Button>
        {/* I2: 切ったことを黙らせない。終わったタスクは積み上がる一方なので、いずれ必ず当たる */}
        <Badge tone={list.data?.truncated ? "warn" : "neutral"}>
          {list.data?.truncated
            ? `${tasks.length} / ${list.data.total} 件`
            : `${tasks.length} 件`}
        </Badge>
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
        <Scroll>
          <div className="kb-counter">
            {/* ── 主：あなたを待っている ───────────────────────────────── */}
            <section className="kb-zone">
              <header className="kb-zone-head">
                <h2>あなたを待っている</h2>
                <span className="kb-zone-sub">
                  {mineCount === 0 ? "いまはありません" : `${mineCount} 件`}
                </span>
              </header>
              {mineCount === 0 ? (
                // **空は「何もない」ではなく「手が空いている」。** 次にできることを言う
                <p className="kb-col-empty">
                  番頭と職人が回しています。積むものがあれば会話で頼んでください。
                </p>
              ) : (
                <div className="kb-slips">
                  {mine.map((group) =>
                    group.rows.length === 0 ? null : (
                      <div key={group.key}>
                        <p className="kb-group-label">{group.label}</p>
                        <div className="kb-slips">
                          {group.rows.map((task) => (
                            <button
                              type="button"
                              key={`${task.projectTag}/${task.taskId}`}
                              className={
                                `kb-slip is-${group.kind}` +
                                (selected?.taskId === task.taskId &&
                                selected?.projectTag === task.projectTag
                                  ? " is-selected"
                                  : "")
                              }
                              onClick={() =>
                                setSelected({ projectTag: task.projectTag, taskId: task.taskId })
                              }
                            >
                              <div className="kb-slip-title">{task.title || task.taskId}</div>
                              <div className="kb-slip-meta">
                                <span className="is-mono">{task.taskId}</span>
                                <span>{task.projectTag}</span>
                                <span>{STATUS_LABEL[task.status] ?? task.status}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </div>
              )}
            </section>

            {/* ── 従：流れ ─────────────────────────────────────────────── */}
            <section className="kb-zone is-quiet">
              <header className="kb-zone-head">
                <h2>流れ</h2>
                <span className="kb-zone-sub">番頭と職人が回している</span>
              </header>
              <div>
                {flow.map((stage) => (
                  <div
                    key={stage.key}
                    className={`kb-stage${stage.rows.length === 0 ? " is-empty" : ""}`}
                  >
                    <div className="kb-stage-head">
                      <span className="kb-stage-name">{stage.label}</span>
                      <span className="kb-stage-n">{stage.rows.length}</span>
                    </div>
                    {stage.rows.map((task) => (
                      <button
                        type="button"
                        key={`${task.projectTag}/${task.taskId}`}
                        className="kb-stage-item"
                        title={task.title || task.taskId}
                        onClick={() =>
                          setSelected({ projectTag: task.projectTag, taskId: task.taskId })
                        }
                      >
                        {task.title || task.taskId}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </section>
          </div>
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
              <span className="kb-history-detail">
                {row.detail}
                {/* **担当の職人へ飛べる**（PO要望 2026-08-07）。
                    セッションを知っているのは帳簿だけなので、そこから渡ってきた分だけ出す */}
                {row.sessionId && (
                  <button
                    type="button"
                    className="kb-goto-worker"
                    onClick={() =>
                      openCanvas("worker.viewer", { sessionId: row.sessionId })
                    }
                    title={`職人 ${row.sessionId} を開く`}
                  >
                    職人を見る
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>

        {/* ── 落ちているなら、理由と直す道具を出す（task-0081/0082）──────────
            **番号だけでは直せない。** 検証ログの末尾まで出す */}
        {detail.data?.failure && (
          <>
            <h3 className="kb-h">なぜ落ちたか</h3>
            <div className="kb-why">
              {detail.data.failure.reason && (
                <p className="kb-why-reason">{detail.data.failure.reason}</p>
              )}
              {detail.data.failure.logs
                .filter((l) => l.tail && l.tail !== "(ログが読めません)")
                .map((l) => (
                  <div key={l.acId}>
                    <div className="kb-why-ac">{l.acId}</div>
                    <pre className="kb-why-log">{l.tail}</pre>
                  </div>
                ))}
              {detail.data.failure.reopenCount > 0 && (
                // P6：同じところを何度も叩いていないか
                <p className="kb-why-again">
                  すでに {detail.data.failure.reopenCount} 回 戻しています。
                  同じところで落ち続けているなら、直し方ではなく前提を疑ってください。
                </p>
              )}
            </div>

            <h3 className="kb-h">どうしますか</h3>
            <p className="kb-para">
              <strong>タスクは切り直しません。</strong>
              中身の問題なら職人に直させ、検証環境の問題なら中身を触らず関所だけ回し直します。
              契約（受け入れ基準や検証コマンド）そのものが間違っていたときは、
              定義ファイルを直して番頭に <code>kobo.amend</code> を頼んでください。
            </p>
            <div className="kb-actions">
              <TextInput
                placeholder="何が悪くて、どう直すのか（職人に渡り、帳簿にも残ります）"
                value={fixReason}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFixReason(e.target.value)}
                aria-label="直す理由"
              />
              <Button
                variant="primary"
                disabled={fixBusy || !fixReason.trim()}
                onClick={() => void fixTask("kobo.reopen", "rework")}
              >
                中身を直させる
              </Button>
              <Button
                disabled={fixBusy || !fixReason.trim()}
                onClick={() => void fixTask("kobo.reopen", "reverify")}
              >
                検証だけやり直す
              </Button>
              <Button
                variant="danger"
                disabled={fixBusy || !fixReason.trim()}
                onClick={() => void fixTask("kobo.abandon")}
              >
                畳む
              </Button>
            </div>
            {fixDone && <p className="kb-para">{fixDone}</p>}
            {fixError && (
              <ErrorNote title="通りませんでした">{fixError}</ErrorNote>
            )}
          </>
        )}
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
