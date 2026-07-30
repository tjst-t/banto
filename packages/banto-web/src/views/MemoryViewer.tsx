/**
 * 記憶ビューア（studio モジュール提供・ADR-0010 決定25）。
 *
 * 番頭が覚えている好み・習慣を見せる。番頭に記憶があること（D11）が banto の核なので、
 * POが「何を覚えている？」を確かめられる場所が要る。
 *
 * **閲覧専用。** 削除は追記で表す設計（task-0023・D3）に属するので、ここからは行わない。
 */

import { useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

interface MemoryRecord {
  id: string;
  kind: "preference" | "habit";
  text: string;
  createdAt: string;
  refs?: string[];
  supersedes?: string;
}
interface MemoryList {
  records: MemoryRecord[];
}

const KIND_LABEL: Record<string, string> = { preference: "好み", habit: "習慣" };

export function MemoryViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialKind = typeof params["kind"] === "string" ? params["kind"] : "";
  const [kind, setKind] = useState(initialKind);
  /** 訂正済みも見るか。既定は今有効な記憶だけ（履歴を見たいときだけ出す） */
  const [includeSuperseded, setIncludeSuperseded] = useState(false);

  const list = useModuleTool<MemoryList>(endpoint, "studio.memory", {
    ...(kind ? { kind } : {}),
    includeSuperseded,
  });
  const records = list.data?.records ?? [];

  return (
    <div className="st">
      <div className="st-head">
        <span className="st-title">記憶</span>
        <span className="gv3-count">{records.length}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">好み・習慣</option>
          <option value="preference">好みだけ</option>
          <option value="habit">習慣だけ</option>
        </select>
        <label className="wv-toggle" title="訂正で置き換えられた古い記憶も一覧に出す">
          <input
            type="checkbox"
            checked={includeSuperseded}
            onChange={(e) => setIncludeSuperseded(e.target.checked)}
          />
          訂正済みを含む
        </label>
        <button className="gv3-clear" onClick={() => list.reload()}>
          取り直す
        </button>
      </div>

      {list.error && <div className="fb-error">読み込めません: {list.error}</div>}

      {records.length === 0 ? (
        <p className="fb-muted st-empty">
          {list.loading ? "読み込み中…" : "まだ何も覚えていません"}
        </p>
      ) : (
        <ul className="st-list">
          {records.map((r) => (
            <li key={r.id} className="st-item">
              <div className="st-item-head">
                <span className={`st-kind is-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
                <span className="st-date">{r.createdAt.slice(0, 16).replace("T", " ")}</span>
                {/* 訂正で置き換えた記憶があることを示す（何を直したのか辿れるように） */}
                {r.supersedes && <span className="st-badge">訂正</span>}
              </div>
              <div className="st-text">{r.text}</div>
              {r.refs && r.refs.length > 0 && (
                <div className="st-refs">{r.refs.join(" · ")}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
