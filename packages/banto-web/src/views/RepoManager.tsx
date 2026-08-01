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
  const [branch, setBranch] = useState("");
  const [cloneTarget, setCloneTarget] = useState("");
  const [initName, setInitName] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const repositories = list.data?.repositories ?? [];
  const worktrees = list.data?.worktrees ?? [];
  const repo = repositories.find((r) => r.id === selected) ?? repositories[0];
  // 紐付けが分からなかったものも落とさない（畳み忘れに気づけなくなる）
  const mine = worktrees.filter((w) => (repo ? w.repo === repo.id : false));
  const orphans = worktrees.filter((w) => w.repo === null);

  const act = async (key: string, tool: string, args: Record<string, unknown>): Promise<void> => {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const details = await callModuleTool<Record<string, unknown>>(endpoint, tool, args);
      list.reload();
      setBranch("");
      setCloneTarget("");
      setInitName("");
      setNotice(summarize(tool, details));
      // 取り込んだ・作ったものをそのまま選んだ状態にする（次にやることが続く）
      const added = details["repository"] as { id?: string } | null | undefined;
      if (added?.id) setSelected(added.id);
    } catch (err) {
      // I2: 押したのに何も起きなかったように見せない
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="rm">
      <div className="rm-side">
        <div className="st-head">
          <span className="st-title">リポジトリ</span>
          <span className="gv3-count">{repositories.length}</span>
          <button className="gv3-clear" onClick={() => list.reload()}>
            取り直す
          </button>
        </div>
        <input
          className="rm-search"
          placeholder="名前・パスで絞る"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        {list.error && <div className="fb-error">{list.error}</div>}
        <ul className="rm-list">
          {repositories.map((r) => {
            const count = worktrees.filter((w) => w.repo === r.id).length;
            return (
              <li key={r.id}>
                <button
                  className={r.id === repo?.id ? "rm-item rm-item-on" : "rm-item"}
                  onClick={() => setSelected(r.id)}
                >
                  <span className="rm-name">{r.label}</span>
                  {count > 0 && <span className="gv3-count">{count}</span>}
                  <span className="rm-path">{r.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {repositories.length === 0 && !list.loading && (
          <p className="fb-muted st-empty">
            ghq が知っているリポジトリがありません（未導入か、まだ clone していない）
          </p>
        )}

        <div className="rm-add">
          <h3 className="pp-heading">リポジトリを増やす</h3>
          <div className="rm-form rm-form-stack">
            <input
              placeholder="取ってくる（URL か user/project）"
              value={cloneTarget}
              onChange={(e) => setCloneTarget(e.target.value)}
              spellCheck={false}
            />
            <button
              disabled={busy === "clone" || cloneTarget.trim().length === 0}
              onClick={() => act("clone", "repo.clone", { repository: cloneTarget.trim() })}
            >
              {busy === "clone" ? "取得中…" : "取ってくる"}
            </button>
          </div>
          <div className="rm-form rm-form-stack">
            <input
              placeholder="新しく作る（user/project）"
              value={initName}
              onChange={(e) => setInitName(e.target.value)}
              spellCheck={false}
            />
            <button
              disabled={busy === "init" || initName.trim().length === 0}
              onClick={() => act("init", "repo.init", { name: initName.trim() })}
            >
              {busy === "init" ? "作成中…" : "作る"}
            </button>
          </div>
          {error && <div className="fb-error">{error}</div>}
          {notice && <div className="rm-notice">{notice}</div>}
        </div>
      </div>

      <div className="rm-main">
        {!repo ? (
          <p className="fb-muted st-empty">{list.loading ? "読み込み中…" : "リポジトリを選ぶと中身が出ます"}</p>
        ) : (
          <>
            <h3 className="rm-title">{repo.id}</h3>
            <div className="rm-path rm-path-main">{repo.path}</div>

            <section className="pp-section">
              <h3 className="pp-heading">ワークツリー</h3>
              {mine.length === 0 ? (
                <p className="fb-muted st-empty">このリポジトリのワークツリーはありません</p>
              ) : (
                <ul className="pp-list">
                  {mine.map((w) => (
                    <li key={w.id} className="pp-item">
                      <div className="pp-place">{w.branch}</div>
                      <div className="rm-path">{w.path}</div>
                      <div className="pp-actions">
                        <button
                          className="pp-deny"
                          disabled={busy === w.id}
                          onClick={() => act(w.id, "repo.worktree.remove", { worktree: w.id })}
                        >
                          削除
                        </button>
                        <span className="fb-muted">
                          消えるのは作業ディレクトリだけ。コミットとブランチは残ります
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="pp-section">
              <h3 className="pp-heading">ワークツリーを作る</h3>
              <div className="rm-form">
                <input
                  placeholder="ブランチ名（例: feature/x）"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  spellCheck={false}
                />
                <label className="wv-toggle" title="既存のブランチを使うなら外す">
                  <input
                    type="checkbox"
                    checked={createBranch}
                    onChange={(e) => setCreateBranch(e.target.checked)}
                  />
                  新しいブランチを切る
                </label>
                <button
                  className="pp-approve"
                  disabled={busy === "add" || branch.trim().length === 0}
                  onClick={() =>
                    act("add", "repo.worktree.add", {
                      repo: repo.id,
                      branch: branch.trim(),
                      createBranch,
                    })
                  }
                >
                  作る
                </button>
              </div>
              <p className="fb-muted">
                置き場所は gwq の設定に従います（ここでは指定しません）。作ったワークツリーは
                そのまま「場所」として選べるようになります
              </p>
            </section>

            {orphans.length > 0 && (
              <section className="pp-section">
                <h3 className="pp-heading">どのリポジトリのものか分からないワークツリー</h3>
                <ul className="pp-list">
                  {orphans.map((w) => (
                    <li key={w.id} className="pp-item">
                      <div className="pp-place">{w.branch}</div>
                      <div className="rm-path">{w.path}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
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
  return created?.path
    ? `ワークツリーを作りました: ${created.path}`
    : "ワークツリーを作りました";
}
