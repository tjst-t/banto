/**
 * Git 閲覧（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * 一画面で「変更ファイル」「コミット履歴」「差分」が見える（PO 指定のIF）。
 * 左に一覧（未コミットの変更＋履歴）、右に差分。狭いときは一覧→差分のドリルダウン（§8）。
 *
 * **すべて閲覧専用。** 決定24 のとおり commit / stage 等の変更操作は持たない——変更は
 * 職人へ委譲し（D10）、Kobo のマージキューとも責務が競合するため。
 *
 * データは workspace モジュールのデータAPIから取る（決定25）。番頭のToolは呼ばない。
 */

import { useEffect, useMemo, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import { PlacePicker, usePlaceSelection } from "./PlacePicker.js";
import type { CanvasViewProps } from "./registry.js";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorNote,
  Loading,
  Scroll,
  SplitView,
  ViewBar,
  ViewShell,
} from "./ui.js";

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

/** git status の2文字コードを読める言葉に。分からないものはそのまま出す（I2）。 */
const STATUS_LABEL: Record<string, string> = {
  M: "変更",
  A: "追加",
  D: "削除",
  R: "改名",
  C: "複製",
  U: "衝突",
  "??": "未追跡",
};

function statusTone(status: string): string {
  if (status.startsWith("A") || status === "??") return "is-new";
  if (status.startsWith("D")) return "is-del";
  return "";
}

/** 差分の増減行数。全体像を数字で1つ持たせる（本文を追わずに規模が分かる）。 */
function diffStat(diff: string): { add: number; del: number; files: number } {
  let add = 0;
  let del = 0;
  let files = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) files++;
    else if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del, files };
}

function DiffBody({
  diff,
  scope,
}: {
  diff: string;
  /** 空だったときの言い分けを変えるため。作業ツリーとコミットでは意味が違う。 */
  scope: "working" | "commit";
}): React.ReactElement {
  const lines = useMemo(() => diff.split("\n"), [diff]);
  if (diff.length === 0) {
    return (
      <EmptyState icon="＝" title="差分はありません">
        {scope === "working"
          ? "作業ツリーに未コミットの変更はありません。"
          : "このコミットは差分を持ちません（マージコミットは既定で中身を出しません）。"}
      </EmptyState>
    );
  }
  return (
    <pre className="gv-diff">
      {lines.map((line, i) => (
        <span
          key={i}
          className={
            "gv-diff-line " +
            (line.startsWith("+") && !line.startsWith("+++")
              ? "gv-add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "gv-del"
                : line.startsWith("@@")
                  ? "gv-hunk"
                  : line.startsWith("diff --git")
                    ? "gv-file"
                    : "")
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
  /** 狭いときに差分側を見ているか。**番頭が ref/path を指定して開いたら差分から見せる。** */
  const [showDiff, setShowDiff] = useState(initialRef !== undefined || initialPath !== undefined);

  // どのリポジトリを見るか（決定36e）。番頭が指定していなければ先頭に落ちる
  const placeSelection = usePlaceSelection(
    endpoint,
    typeof params["place"] === "string" ? params["place"] : undefined
  );
  const place = placeSelection.place;
  const at = place ? { place } : {};
  const ready = place !== undefined;

  // リポジトリを変えたら選択を作業ツリーへ戻す（前のリポジトリのコミットは意味を持たない）
  useEffect(() => {
    setSelection({ source: "working" });
    setShowDiff(false);
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
    selection.source === "working" ? status.data?.files ?? [] : show.data?.files ?? [];
  const activePane = selection.source === "commit" ? show : workingDiff;
  const diffText =
    selection.source === "commit" ? show.data?.diff ?? "" : workingDiff.data?.diff ?? "";
  const stat = useMemo(() => diffStat(diffText), [diffText]);

  const pick = (next: Selection): void => {
    setSelection(next);
    setShowDiff(true);
  };

  const listPane = (
    <>
      {/* 未コミットの変更。**いちばん上に置く**——「いま何をいじっているか」が最初に要る */}
      <section className="gv-side-section is-changes">
        <div className="cv-sechead">
          <h3 className="cv-sechead-title">
            {selection.source === "working" ? "未コミットの変更" : "このコミットの変更"}
            <span className="cv-count">{changedFiles.length}</span>
          </h3>
          {selection.path && (
            <div className="cv-sechead-actions">
              <Button small variant="ghost" onClick={() => pick({ ...selection, path: undefined })}>
                絞り込みを外す
              </Button>
            </div>
          )}
        </div>
        {status.error && <ErrorNote onRetry={status.reload}>{status.error}</ErrorNote>}
        <div className="gv-side-scroll">
          {changedFiles.length === 0 ? (
            <p className="cv-muted" style={{ padding: "4px 14px 12px" }}>
              {selection.source === "working"
                ? status.loading
                  ? "読み込んでいます…"
                  : "変更はありません"
                : "—"}
            </p>
          ) : (
            <ul className="cv-list">
              {changedFiles.map((f) => (
                <li key={f.path}>
                  <button
                    className={`cv-row ${selection.path === f.path ? "is-selected" : ""}`}
                    onClick={() => pick({ ...selection, path: f.path })}
                    title={`${STATUS_LABEL[f.status] ?? f.status} — ${f.path}`}
                  >
                    <code className={`gv-status ${statusTone(f.status)}`}>{f.status}</code>
                    <span className="gv-path">{f.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* コミット履歴 */}
      <section className="gv-side-section is-log">
        <div className="cv-sechead">
          <h3 className="cv-sechead-title">履歴</h3>
          <div className="cv-sechead-actions">
            {status.data?.branch && <Badge tone="accent">{status.data.branch}</Badge>}
          </div>
        </div>
        <div className="gv-side-scroll">
          <ul className="cv-list">
            <li>
              <button
                className={`cv-row ${selection.source === "working" ? "is-selected" : ""}`}
                onClick={() => pick({ source: "working" })}
              >
                <code className="gv-hash">WIP</code>
                <span className="cv-row-main">
                  <span className="cv-row-name">未コミットの変更</span>
                </span>
              </button>
            </li>
            {log.data?.commits.map((c, i) => (
              <li key={`${c.hash}-${i}`}>
                <button
                  className={`cv-row ${
                    selection.source === "commit" && selection.ref === c.hash ? "is-selected" : ""
                  }`}
                  onClick={() => pick({ source: "commit", ref: c.hash })}
                  title={`${c.subject}\n${c.date} ${c.author}`}
                >
                  <code className="gv-hash">{c.hash}</code>
                  <span className="cv-row-main">
                    <span className="cv-row-name">{c.subject}</span>
                    <span className="cv-row-sub">
                      {c.date} · {c.author}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {log.loading && !log.data && <Loading rows={4} />}
          {log.error && <ErrorNote onRetry={log.reload}>{log.error}</ErrorNote>}
          {log.data && log.data.commits.length >= limit && (
            <div style={{ padding: "4px 10px 12px" }}>
              <Button small variant="ghost" onClick={() => setLimit((n) => n + 30)}>
                さらに読み込む
              </Button>
            </div>
          )}
        </div>
      </section>
    </>
  );

  const detailPane = (
    <>
      <div className="cv-head">
        {selection.source === "commit" && show.data ? (
          <>
            <code className="gv-hash">{show.data.short}</code>
            <span className="cv-head-title">{show.data.subject}</span>
            <span className="cv-head-sub">
              {show.data.date} · {show.data.author}
            </span>
          </>
        ) : (
          <span className="cv-head-title">未コミットの変更</span>
        )}
        {selection.path && <Badge tone="accent" title={selection.path}>1ファイルに絞り込み中</Badge>}
        <span className="cv-spacer" />
        {diffText.length > 0 && (
          <>
            <span className="gv-stat" title={`${stat.files} ファイル`}>
              <span className="gv-stat-add">+{stat.add}</span>
              <span className="gv-stat-del">−{stat.del}</span>
            </span>
            <CopyButton text={diffText} label="差分をコピー" />
          </>
        )}
        {selection.path && (
          <Button small variant="ghost" onClick={() => setSelection({ ...selection, path: undefined })}>
            全ファイル
          </Button>
        )}
      </div>

      {activePane.error && <ErrorNote onRetry={activePane.reload}>{activePane.error}</ErrorNote>}
      {activePane.loading && diffText.length === 0 ? (
        <Loading rows={6} />
      ) : (
        <DiffBody diff={diffText} scope={selection.source} />
      )}
    </>
  );

  return (
    <ViewShell className="gv">
      <ViewBar>
        <PlacePicker selection={placeSelection} title="どのリポジトリを見るか" />
        <span className="cv-spacer" />
        <Button
          small
          variant="ghost"
          title="いまの状態を取り直す"
          onClick={() => {
            status.reload();
            log.reload();
            activePane.reload();
          }}
        >
          ⟳ 取り直す
        </Button>
      </ViewBar>
      <SplitView
        size="lg"
        list={listPane}
        detail={detailPane}
        showDetail={showDiff}
        onBack={() => setShowDiff(false)}
        backLabel="変更と履歴"
      />
    </ViewShell>
  );
}
