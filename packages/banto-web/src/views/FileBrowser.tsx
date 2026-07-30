/**
 * ファイル／ディレクトリ表示（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * データは自分を提供しているモジュール（workspace）のデータAPIから取る。番頭のToolは
 * 呼ばない——同じTool契約だが経路が違う（決定25）。到達先は props の endpoint。
 *
 * `params.path` はディレクトリでもファイルでもよい。どちらかを先に file.stat で確かめて、
 * ファイルなら親ディレクトリを開いてそのファイルを選択した状態で始める。
 * `params.line`（と `endLine`）を渡すとその行まで自動スクロールして強調する——
 * file.grep で見つけた箇所をそのまま見せられるように。
 */

import { useEffect, useRef, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

interface Entry {
  name: string;
  type: "dir" | "file";
  size?: number;
}
interface Listing {
  path: string;
  total: number;
  truncated: boolean;
  entries: Entry[];
}
interface FileContent {
  path: string;
  binary: boolean;
  size: number;
  content?: string;
  totalLines?: number;
  shownLines?: number;
  truncated?: boolean;
}
interface StatInfo {
  path: string;
  type: "dir" | "file";
  size: number;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}

/**
 * ファイル内容を行番号つきで描き、指定範囲を強調して自動スクロールする。
 * 番頭が「この行を見て」と言えるようにするための面（PO要望）。
 */
function CodeBody({
  content,
  from,
  to,
}: {
  content: string;
  from?: number;
  to?: number;
}): React.ReactElement {
  const targetRef = useRef<HTMLSpanElement>(null);
  const lines = content.split("\n");
  const start = from ?? 0;
  const end = to ?? from ?? 0;

  useEffect(() => {
    // 強調行が画面外にあるときだけ寄せる。中央に置くと前後の文脈が見える
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [from, to, content]);

  const width = String(lines.length).length;

  return (
    <pre className="fb-code">
      {lines.map((line, i) => {
        const lineNo = i + 1;
        const highlighted = lineNo >= start && lineNo <= end;
        return (
          <span
            key={i}
            className={`fb-line ${highlighted ? "is-highlight" : ""}`}
            ref={lineNo === start ? targetRef : undefined}
          >
            <span className="fb-lineno">{String(lineNo).padStart(width, " ")}</span>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function FileBrowser({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialPath = typeof params["path"] === "string" ? params["path"] : ".";
  const initialLine = typeof params["line"] === "number" ? params["line"] : undefined;
  const initialEndLine = typeof params["endLine"] === "number" ? params["endLine"] : undefined;

  // 渡されたパスがディレクトリかファイルかを先に確かめる
  const stat = useModuleTool<StatInfo>(endpoint, "file.stat", { path: initialPath });
  const [nav, setNav] = useState<{ dir: string; file?: string }>();

  useEffect(() => {
    if (nav || !stat.data) return;
    setNav(
      stat.data.type === "dir"
        ? { dir: stat.data.path }
        : { dir: parentOf(stat.data.path), file: stat.data.path }
    );
  }, [stat.data, nav]);

  // stat が失敗（存在しない等）したらルートから始める。理由は下のバナーで出す
  useEffect(() => {
    if (!nav && stat.error) setNav({ dir: "." });
  }, [stat.error, nav]);

  const dir = nav?.dir ?? ".";
  const file = nav?.file;
  // 強調は「番頭が指定したファイルを見ているとき」だけ。別のファイルを選んだら外す
  const highlightFrom = file === initialPath ? initialLine : undefined;
  const highlightTo = file === initialPath ? (initialEndLine ?? initialLine) : undefined;

  const listing = useModuleTool<Listing>(endpoint, "file.list", { path: dir }, nav !== undefined);
  const content = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    {
      path: file ?? "",
      // 強調したい行が既定の打ち切り範囲より後ろにあると出せないので、届く分だけ広げる
      ...(highlightTo !== undefined ? { maxLines: Math.max(400, highlightTo + 40) } : {}),
    },
    file !== undefined
  );

  const join = (name: string): string => (dir === "." ? name : `${dir}/${name}`);

  return (
    <div className="fb">
      <div className="fb-bar">
        <button
          className="fb-up"
          disabled={dir === "."}
          onClick={() => setNav({ dir: parentOf(dir) })}
        >
          ↑ 上へ
        </button>
        <code className="fb-path">{listing.data?.path ?? dir}</code>
        {listing.data && <span className="fb-count">{listing.data.total} 件</span>}
      </div>

      {/* I2: 指定パスが解決できなかったことを黙って隠さない */}
      {stat.error && (
        <div className="fb-error">
          「{initialPath}」を開けなかったためルートを表示しています: {stat.error}
        </div>
      )}
      {listing.error && <div className="fb-error">読み込めません: {listing.error}</div>}

      <div className="fb-body">
        <ul className="fb-list">
          {(listing.loading || nav === undefined) && <li className="fb-muted">読み込み中…</li>}
          {listing.data?.entries.map((entry) => (
            <li key={entry.name}>
              <button
                className={`fb-entry ${entry.type === "dir" ? "is-dir" : ""} ${
                  file === join(entry.name) ? "is-selected" : ""
                }`}
                onClick={() =>
                  setNav(
                    entry.type === "dir" ? { dir: join(entry.name) } : { dir, file: join(entry.name) }
                  )
                }
              >
                <span className="fb-icon">{entry.type === "dir" ? "📁" : "📄"}</span>
                {entry.name}
                {entry.size !== undefined && <span className="fb-size">{entry.size}</span>}
              </button>
            </li>
          ))}
          {listing.data?.truncated && <li className="fb-muted">… 上限を超えたため一部のみ表示</li>}
        </ul>

        <div className="fb-preview">
          {!file ? (
            <p className="fb-muted">ファイルを選ぶと中身が出ます</p>
          ) : content.error ? (
            <div className="fb-error">読み込めません: {content.error}</div>
          ) : content.loading ? (
            <p className="fb-muted">読み込み中…</p>
          ) : content.data?.binary ? (
            <p className="fb-muted">バイナリのため表示できません（{content.data.size} bytes）</p>
          ) : (
            <>
              <div className="fb-preview-head">
                <code>{content.data?.path}</code>
                {content.data?.truncated && (
                  <span className="fb-muted">
                    {" "}
                    （{content.data.shownLines} / {content.data.totalLines} 行のみ表示）
                  </span>
                )}
              </div>
              <CodeBody
                content={content.data?.content ?? ""}
                {...(highlightFrom !== undefined ? { from: highlightFrom } : {})}
                {...(highlightTo !== undefined ? { to: highlightTo } : {})}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
