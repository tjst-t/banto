/**
 * リポジトリとワークツリーの管理画面（repo-manager モジュール提供・ADR-0010 決定36）。
 *
 * 扱うのは**Git リポジトリとワークツリー**であって、店（プロジェクト）の登録簿ではない
 * （決定36a）。ここでできるのは「どこで作業するか」の用意だけで、commit / push などの
 * 履歴の変更は無い（決定37）。
 *
 * **独自の登録簿を映しているのではない。** `ghq` の配置と `gwq list` から毎回導出した
 * ものをそのまま出している（決定36b・D3）。だから外で `ghq get` してもここに出る。
 */

import { useState } from "react";
import { callModuleTool, useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Loading,
  Note,
  Scroll,
  SearchField,
  SectionHead,
  SplitView,
  TextInput,
  Toggle,
  ViewBar,
  ViewShell,
  ViewTitle,
  useAction,
} from "./ui.js";

interface Repository {
  id: string;
  label: string;
  path: string;
}
interface Worktree extends Repository {
  branch: string;
  repo: string | null;
  repoPath: string | null;
}
interface RepoList {
  repositories: Repository[];
  worktrees: Worktree[];
}

export function RepoManager({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialRepo = typeof params["repo"] === "string" ? params["repo"] : undefined;
  const [query, setQuery] = useState("");
  const list = useModuleTool<RepoList>(endpoint, "repo.list", query ? { query } : {});
  const [selected, setSelected] = useState<string | undefined>(initialRepo);
  const [showDetail, setShowDetail] = useState(initialRepo !== undefined);
  const [branch, setBranch] = useState("");
  const [cloneTarget, setCloneTarget] = useState("");
  const [initName, setInitName] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const action = useAction();

  const repositories = list.data?.repositories ?? [];
  const worktrees = list.data?.worktrees ?? [];
  const repo = repositories.find((r) => r.id === selected) ?? repositories[0];
  // 紐付けが分からなかったものも落とさない（畳み忘れに気づけなくなる）
  const mine = worktrees.filter((w) => (repo ? w.repo === repo.id : false));
  const orphans = worktrees.filter((w) => w.repo === null);

  const act = (key: string, tool: string, args: Record<string, unknown>): void => {
    void action.run(
      key,
      () => callModuleTool<Record<string, unknown>>(endpoint, tool, args),
      (result) => {
        const details = result as Record<string, unknown>;
        list.reload();
        setBranch("");
        setCloneTarget("");
        setInitName("");
        // 取り込んだ・作ったものをそのまま選んだ状態にする（次にやることが続く）
        const added = details["repository"] as { id?: string } | null | undefined;
        if (added?.id) {
          setSelected(added.id);
          setShowDetail(true);
        }
        return summarize(tool, details);
      }
    );
  };

  const listPane = (
    <>
      <ViewBar>
        <ViewTitle icon="🗂" count={repositories.length}>
          リポジトリ
        </ViewTitle>
        <span className="cv-spacer" />
        <Button small variant="ghost" onClick={() => list.reload()} title="取り直す">
          ⟳
        </Button>
      </ViewBar>
      <ViewBar>
        <SearchField value={query} onChange={setQuery} placeholder="名前・パスで絞る" />
      </ViewBar>

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}

      <Scroll pad={false}>
        {list.loading && !list.data ? (
          <Loading rows={5} />
        ) : repositories.length === 0 ? (
          <EmptyState icon="🗂" title={query ? "当てはまるリポジトリがありません" : "リポジトリがありません"}>
            {query
              ? "絞り込みを外すと全部出ます。"
              : "ghq が知っているリポジトリがありません（未導入か、まだ clone していない）。下から取ってこられます。"}
          </EmptyState>
        ) : (
          <ul className="cv-list">
            {repositories.map((r) => {
              const count = worktrees.filter((w) => w.repo === r.id).length;
              return (
                <li key={r.id}>
                  <button
                    className={`cv-row ${r.id === repo?.id ? "is-selected" : ""}`}
                    onClick={() => {
                      setSelected(r.id);
                      setShowDetail(true);
                    }}
                    title={r.path}
                  >
                    <span className="cv-row-main">
                      <span className="cv-row-name">{r.label}</span>
                      <span className="rm-path">{r.path}</span>
                    </span>
                    {count > 0 && <span className="cv-count" title={`ワークツリー ${count} 件`}>{count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>

      {/* 増やす操作は一覧の下。**取ってくると作るを分けて置く**——押し間違えると外へ出る */}
      <div className="rm-add">
        <SectionHead>リポジトリを増やす</SectionHead>
        <div className="rm-form">
          <TextInput
            placeholder="取ってくる（URL か user/project）"
            value={cloneTarget}
            onChange={(e) => setCloneTarget(e.target.value)}
          />
          <Button
            disabled={action.busy === "clone" || cloneTarget.trim().length === 0}
            onClick={() => act("clone", "repo.clone", { repository: cloneTarget.trim() })}
          >
            {action.busy === "clone" ? "取得中…" : "取ってくる"}
          </Button>
        </div>
        <div className="rm-form">
          <TextInput
            placeholder="新しく作る（user/project）"
            value={initName}
            onChange={(e) => setInitName(e.target.value)}
          />
          <Button
            disabled={action.busy === "init" || initName.trim().length === 0}
            onClick={() => act("init", "repo.init", { name: initName.trim() })}
          >
            {action.busy === "init" ? "作成中…" : "作る"}
          </Button>
        </div>
        {action.error && <ErrorNote onRetry={action.clearError}>{action.error}</ErrorNote>}
        {action.notice && <Note tone="ok" icon="✓">{action.notice}</Note>}
      </div>
    </>
  );

  const detailPane = !repo ? (
    <EmptyState icon="🗂" title="リポジトリを選ぶと中身が出ます">
      ワークツリーの用意・削除ができます（履歴を変える操作はありません）。
    </EmptyState>
  ) : (
    <>
      <div className="cv-head">
        <span className="cv-head-title">{repo.id}</span>
        <span className="cv-spacer" />
        <Badge>{mine.length} ワークツリー</Badge>
      </div>
      <Scroll>
        <div className="rm-path" style={{ marginBottom: 14 }}>
          {repo.path}
        </div>

        <SectionHead count={mine.length}>ワークツリー</SectionHead>
        {mine.length === 0 ? (
          <p className="cv-muted" style={{ padding: "0 2px 10px" }}>
            このリポジトリのワークツリーはありません。
          </p>
        ) : (
          <>
            <div className="cv-cards">
              {mine.map((w) => (
                <Card key={w.id}>
                  <div className="st-card-head">
                    <Badge tone="accent">{w.branch}</Badge>
                    <span className="cv-spacer" />
                    <Button
                      small
                      variant="danger"
                      disabled={action.busy === w.id}
                      onClick={() => act(w.id, "repo.worktree.remove", { worktree: w.id })}
                    >
                      {action.busy === w.id ? "…" : "削除"}
                    </Button>
                  </div>
                  <div className="rm-path">{w.path}</div>
                </Card>
              ))}
            </div>
            {/* 1件ごとに同じ但し書きを繰り返さない。効くのは一覧全体に対して同じ */}
            <p className="cv-muted" style={{ margin: "8px 2px 0" }}>
              削除で消えるのは作業ディレクトリだけ。コミットとブランチは残ります。
            </p>
          </>
        )}

        <SectionHead>ワークツリーを作る</SectionHead>
        <Card>
          <div className="rm-form">
            <TextInput
              placeholder="ブランチ名（例: feature/x）"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            />
            <Button
              variant="primary"
              disabled={action.busy === "add" || branch.trim().length === 0}
              onClick={() =>
                act("add", "repo.worktree.add", {
                  repo: repo.id,
                  branch: branch.trim(),
                  createBranch,
                })
              }
            >
              {action.busy === "add" ? "作成中…" : "作る"}
            </Button>
          </div>
          <div style={{ marginTop: 9 }}>
            <Toggle checked={createBranch} onChange={setCreateBranch} title="既存のブランチを使うなら外す">
              新しいブランチを切る
            </Toggle>
          </div>
          <p className="cv-muted" style={{ margin: "9px 0 0", lineHeight: 1.7 }}>
            置き場所は gwq の設定に従います（ここでは指定しません）。作ったワークツリーは、
            そのまま「場所」として選べるようになります。
          </p>
        </Card>

        {orphans.length > 0 && (
          <>
            <SectionHead count={orphans.length}>どのリポジトリのものか分からないワークツリー</SectionHead>
            <div className="cv-cards">
              {orphans.map((w) => (
                <Card key={w.id} tone="warn">
                  <div className="st-card-head">
                    <Badge tone="warn">{w.branch}</Badge>
                  </div>
                  <div className="rm-path">{w.path}</div>
                </Card>
              ))}
            </div>
          </>
        )}
      </Scroll>
    </>
  );

  return (
    <ViewShell className="rm">
      <SplitView
        size="md"
        list={listPane}
        detail={detailPane}
        showDetail={showDetail}
        onBack={() => setShowDetail(false)}
        backLabel="リポジトリ一覧"
      />
    </ViewShell>
  );
}

/** 実行した結果の一言。何が起きたか分からないまま一覧だけ変わるのを避ける。 */
function summarize(tool: string, details: Record<string, unknown>): string {
  if (tool === "repo.clone" || tool === "repo.init") {
    const repo = details["repository"] as { id?: string } | null | undefined;
    if (!repo) return "既に手元にありました（増えていません）";
    return tool === "repo.clone" ? `取り込みました: ${repo.id}` : `作りました: ${repo.id}`;
  }
  if (tool === "repo.worktree.remove") {
    const w = details["worktree"] as { branch?: string } | undefined;
    return `ワークツリーを削除しました${w?.branch ? `（${w.branch}）` : ""}`;
  }
  const created = details["worktree"] as { path?: string } | null | undefined;
  return created?.path ? `ワークツリーを作りました: ${created.path}` : "ワークツリーを作りました";
}
