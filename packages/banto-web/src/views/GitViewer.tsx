/**
 * Git 閲覧（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * 状態・差分・履歴を切り替えて見る。すべて読み取り専用——変更操作は持たない（決定24）。
 * データは workspace モジュールのデータAPIから取る（決定25）。
 */

import { useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

type Tab = "status" | "diff" | "log";

interface Status {
  branch: string;
  files: Array<{ status: string; path: string }>;
}
interface Diff {
  diff: string;
}
interface Log {
  commits: Array<{ hash: string; date: string; author: string; subject: string }>;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "status", label: "状態" },
  { id: "diff", label: "差分" },
  { id: "log", label: "履歴" },
];

export function GitViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initial = TABS.some((t) => t.id === params["tab"]) ? (params["tab"] as Tab) : "status";
  const [tab, setTab] = useState<Tab>(initial);

  const status = useModuleTool<Status>(endpoint, "git.status");
  const diff = useModuleTool<Diff>(endpoint, "git.diff");
  const log = useModuleTool<Log>(endpoint, "git.log", { limit: 30 });
  const active = tab === "status" ? status : tab === "diff" ? diff : log;

  return (
    <div className="gv">
      <div className="gv-bar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`gv-tab ${tab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {status.data?.branch && <code className="gv-branch">{status.data.branch}</code>}
      </div>

      {active.error && <div className="fb-error">読み込めません: {active.error}</div>}
      {active.loading && <p className="fb-muted">読み込み中…</p>}

      {tab === "status" && status.data && (
        status.data.files.length === 0 ? (
          <p className="fb-muted">変更なし</p>
        ) : (
          <table className="gv-table">
            <thead>
              <tr><th>状態</th><th>ファイル</th></tr>
            </thead>
            <tbody>
              {status.data.files.map((f) => (
                <tr key={f.path}>
                  <td><code>{f.status}</code></td>
                  <td><code>{f.path}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "diff" && diff.data && (
        diff.data.diff.length === 0 ? (
          <p className="fb-muted">差分なし</p>
        ) : (
          <pre className="gv-diff">
            {diff.data.diff.split("\n").map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith("+") && !line.startsWith("+++") ? "gv-add"
                  : line.startsWith("-") && !line.startsWith("---") ? "gv-del"
                  : line.startsWith("@@") ? "gv-hunk"
                  : undefined
                }
              >
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
        )
      )}

      {tab === "log" && log.data && (
        <ul className="gv-log">
          {log.data.commits.map((c, i) => (
            <li key={`${c.hash}-${i}`}>
              <code className="gv-hash">{c.hash}</code>
              <span className="gv-subject">{c.subject}</span>
              <span className="gv-meta">{c.date} · {c.author}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
