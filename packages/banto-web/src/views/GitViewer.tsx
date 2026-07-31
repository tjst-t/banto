/**
 * Git 閲覧（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * 一画面で「コミット一覧」「変更ファイル一覧」「ファイルの差分」が見える3面構成
 * （PO 指定のIF）。左上が変更ファイル一覧、左下がコミット履歴、右が差分。
 *
 * **すべて閲覧専用。** 決定24 のとおり commit / stage 等の変更操作は持たない——変更は
 * 職人へ委譲し（D10）、Kobo のマージキューとも責務が競合するため。
 *
 * データは workspace モジュールのデータAPIから取る（決定25）。番頭のToolは呼ばない。
 */

import { useEffect, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import { PlacePicker, usePlaceSelection } from "./PlacePicker.js";
import type { CanvasViewProps } from "./registry.js";

interface Status {
  branch: string;
  files: Array<{ status: string; path: string }>;
}
interface Log {
  commits: Array<{ hash: string; date: string; author: string; subject: string }>;
}
interface Show {
  short: string;
  date: string;
  author: string;
  subject: string;
  files: Array<{ status: string; path: string }>;
  diff: string;
}
interface Diff {
  diff: string;
}

/** いま何の差分を見ているか。作業ツリーか、あるコミットか。 */
type Selection =
  | { source: "working"; path?: string }
  | { source: "commit"; ref: string; path?: string };

function DiffBody({ diff }: { diff: string }): React.ReactElement {
  if (diff.length === 0) return <p className="fb-muted">差分なし</p>;
  return (
    <pre className="gv-diff">
      {diff.split("\n").map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "gv-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "gv-del"
                : line.startsWith("@@")
                  ? "gv-hunk"
                  : line.startsWith("diff --git")
                    ? "gv-file"
                    : undefined
          }
        >
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function GitViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialRef = typeof params["ref"] === "string" ? params["ref"] : undefined;
  const initialPath = typeof params["path"] === "string" ? params["path"] : undefined;
  const [selection, setSelection] = useState<Selection>(
    initialRef
      ? { source: "commit", ref: initialRef, ...(initialPath ? { path: initialPath } : {}) }
      : { source: "working", ...(initialPath ? { path: initialPath } : {}) }
  );
  const [limit, setLimit] = useState(30);

  // どのリポジトリを見るか（決定36e）。番頭が指定していなければ先頭に落ちる
  const selection2 = usePlaceSelection(endpoint, typeof params["place"] === "string" ? params["place"] : undefined);
  const place = selection2.place;
  const at = place ? { place } : {};
  const ready = place !== undefined;

  // リポジトリを変えたら選択を作業ツリーへ戻す（前のリポジトリのコミットは意味を持たない）
  useEffect(() => {
    setSelection({ source: "working" });
  }, [place]);

  const status = useModuleTool<Status>(endpoint, "git.status", at, ready);
  const log = useModuleTool<Log>(endpoint, "git.log", { limit, ...at }, ready);

  // コミットを選んでいるときだけ引く
  const show = useModuleTool<Show>(
    endpoint,
    "git.show",
    selection.source === "commit"
      ? { ref: selection.ref, ...(selection.path ? { path: selection.path } : {}), ...at }
      : {},
    selection.source === "commit" && ready
  );
  // 作業ツリーを見ているときだけ引く
  const workingDiff = useModuleTool<Diff>(
    endpoint,
    "git.diff",
    { ...(selection.path ? { path: selection.path } : {}), ...at },
    selection.source === "working" && ready
  );

  const changedFiles =
    selection.source === "working" ? (status.data?.files ?? []) : (show.data?.files ?? []);
  const activePane = selection.source === "commit" ? show : workingDiff;
  const diffText =
    selection.source === "commit" ? (show.data?.diff ?? "") : (workingDiff.data?.diff ?? "");

  return (
    <div className="gv3">
      <div className="gv3-side">
        {/* どのリポジトリを見るか（決定36e）。番頭も同じ引数を Tool に渡している */}
        <div className="gv3-place">
          <PlacePicker selection={selection2} title="どのリポジトリを見るか" />
        </div>
        {/* 変更ファイル一覧：作業ツリー、または選択中コミットの内訳 */}
        <section className="gv3-section">
          <h3 className="gv3-head">
            {selection.source === "working" ? "変更ファイル（未コミット）" : "このコミットの変更"}
            <span className="gv3-count">{changedFiles.length}</span>
          </h3>
          {status.error && <div className="fb-error">{status.error}</div>}
          {changedFiles.length === 0 ? (
            <p className="fb-muted gv3-empty">
              {selection.source === "working" ? "変更なし" : "—"}
            </p>
          ) : (
            <ul className="gv3-files">
              {changedFiles.map((f) => (
                <li key={f.path}>
                  <button
                    className={`gv3-file-btn ${selection.path === f.path ? "is-selected" : ""}`}
                    onClick={() => setSelection({ ...selection, path: f.path })}
                    title={f.path}
                  >
                    <code className="gv3-status">{f.status}</code>
                    <span className="gv3-path">{f.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* コミット一覧 */}
        <section className="gv3-section gv3-history">
          <h3 className="gv3-head">
            履歴
            {status.data?.branch && <code className="gv3-branch">{status.data.branch}</code>}
          </h3>
          <ul className="gv3-log">
            <li>
              <button
                className={`gv3-commit ${selection.source === "working" ? "is-selected" : ""}`}
                onClick={() => setSelection({ source: "working" })}
              >
                <code className="gv3-hash">WIP</code>
                <span className="gv3-subject">未コミットの変更</span>
              </button>
            </li>
            {log.data?.commits.map((c, i) => (
              <li key={`${c.hash}-${i}`}>
                <button
                  className={`gv3-commit ${
                    selection.source === "commit" && selection.ref === c.hash ? "is-selected" : ""
                  }`}
                  onClick={() => setSelection({ source: "commit", ref: c.hash })}
                  title={`${c.subject}\n${c.date} ${c.author}`}
                >
                  <code className="gv3-hash">{c.hash}</code>
                  <span className="gv3-subject">{c.subject}</span>
                  <span className="gv3-date">{c.date}</span>
                </button>
              </li>
            ))}
          </ul>
          {log.data && log.data.commits.length >= limit && (
            <button className="gv3-more" onClick={() => setLimit((n) => n + 30)}>
              さらに読み込む
            </button>
          )}
        </section>
      </div>

      {/* 差分 */}
      <div className="gv3-main">
        <div className="gv3-main-head">
          {selection.source === "commit" && show.data ? (
            <>
              <code className="gv3-hash">{show.data.short}</code>
              <span className="gv3-subject">{show.data.subject}</span>
              <span className="gv3-date">
                {show.data.date} · {show.data.author}
              </span>
            </>
          ) : (
            <span className="gv3-subject">未コミットの変更</span>
          )}
          {selection.path && (
            <button
              className="gv3-clear"
              onClick={() => setSelection({ ...selection, path: undefined })}
            >
              全ファイル表示
            </button>
          )}
        </div>

        {activePane.error && <div className="fb-error">読み込めません: {activePane.error}</div>}
        {activePane.loading ? <p className="fb-muted">読み込み中…</p> : <DiffBody diff={diffText} />}
      </div>
    </div>
  );
}
