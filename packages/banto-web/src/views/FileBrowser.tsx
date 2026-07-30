/**
 * ファイル／ディレクトリ表示（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * データは自分を提供しているモジュール（workspace）のデータAPIから取る。番頭のToolは
 * 呼ばない——同じTool契約だが経路が違う（決定25）。到達先は props の endpoint。
 */

import { useState } from "react";
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
  truncated?: boolean;
}

export function FileBrowser({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialPath = typeof params["path"] === "string" ? params["path"] : ".";
  const [dir, setDir] = useState(initialPath);
  const [file, setFile] = useState<string>();

  const listing = useModuleTool<Listing>(endpoint, "file.list", { path: dir });
  const content = useModuleTool<FileContent>(endpoint, "file.read", { path: file ?? "" });

  const join = (name: string): string => (dir === "." ? name : `${dir}/${name}`);
  const parentOf = (p: string): string => {
    const i = p.lastIndexOf("/");
    return i === -1 ? "." : p.slice(0, i);
  };

  return (
    <div className="fb">
      <div className="fb-bar">
        <button className="fb-up" disabled={dir === "."} onClick={() => { setDir(parentOf(dir)); setFile(undefined); }}>
          ↑ 上へ
        </button>
        <code className="fb-path">{listing.data?.path ?? dir}</code>
        {listing.data && <span className="fb-count">{listing.data.total} 件</span>}
      </div>

      {listing.error && <div className="fb-error">読み込めません: {listing.error}</div>}

      <div className="fb-body">
        <ul className="fb-list">
          {listing.loading && <li className="fb-muted">読み込み中…</li>}
          {listing.data?.entries.map((entry) => (
            <li key={entry.name}>
              <button
                className={`fb-entry ${entry.type === "dir" ? "is-dir" : ""} ${
                  file === join(entry.name) ? "is-selected" : ""
                }`}
                onClick={() => {
                  if (entry.type === "dir") {
                    setDir(join(entry.name));
                    setFile(undefined);
                  } else {
                    setFile(join(entry.name));
                  }
                }}
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
                {content.data?.truncated && <span className="fb-muted"> （一部のみ）</span>}
              </div>
              <pre className="fb-code">{content.data?.content}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
