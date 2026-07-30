/**
 * 職人（worker）ビューア＝セッションビューア（基本GUIセット・ADR-0010 決定18・25）。
 *
 * 左に職人の一覧、右にその職人のセッション出力。稼働中でも覗ける——`worker.attach` は
 * セッションJSONLの末尾を読むだけでプロセスに割り込まない。
 *
 * データは worker-pool モジュールのデータAPIから取る（決定25）。番頭のToolは呼ばない。
 * **閲覧専用**。職人の起動・停止は番頭の判断に属するので、ここからは行わない（D5）。
 */

import { useEffect, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";

interface Worker {
  projectTag: string;
  taskId: string;
  pid: number;
  sessionId: string;
  sessionPath: string;
  worktree: string;
  alive: boolean;
  spawnedAt: string;
}
interface WorkerList {
  workers: Worker[];
}
interface Attach {
  sessionId: string;
  lines: string[];
  truncated: boolean;
}

/** セッションJSONLの1行を、読める形に落とす。解釈できない行は生のまま出す。 */
interface Rendered {
  kind: "user" | "assistant" | "thinking" | "tool" | "meta" | "raw";
  label?: string;
  text: string;
}

function renderLine(line: string): Rendered[] {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // I2: 解釈できない行を捨てない。生で見せる
    return [{ kind: "raw", text: line }];
  }

  const e = entry as {
    type?: string;
    message?: {
      role?: string;
      content?: unknown;
    };
    provider?: string;
    modelId?: string;
  };

  if (e.type === "session") return [{ kind: "meta", text: "— セッション開始 —" }];
  if (e.type === "model_change") {
    return [{ kind: "meta", text: `モデル: ${e.provider ?? "?"}/${e.modelId ?? "?"}` }];
  }
  if (e.type !== "message" || !e.message) return [];

  const role = e.message.role ?? "?";
  const content = e.message.content;

  if (typeof content === "string") {
    return [{ kind: role === "user" ? "user" : "assistant", text: content }];
  }
  if (!Array.isArray(content)) return [];

  const out: Rendered[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    const type = String(block["type"] ?? "");
    if (type === "text" && typeof block["text"] === "string") {
      out.push({ kind: role === "user" ? "user" : "assistant", text: block["text"] });
    } else if (type === "thinking" && typeof block["thinking"] === "string") {
      out.push({ kind: "thinking", text: block["thinking"] });
    } else if (type === "toolCall") {
      const name = String(block["name"] ?? "?");
      out.push({
        kind: "tool",
        label: name,
        text: JSON.stringify(block["arguments"] ?? block["args"] ?? {}),
      });
    } else if (type === "toolResult") {
      out.push({ kind: "tool", label: "→ 結果", text: JSON.stringify(block["output"] ?? "") });
    }
  }
  return out;
}

export function WorkerViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialSessionId =
    typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
  const [selected, setSelected] = useState<string | undefined>(initialSessionId);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const list = useModuleTool<WorkerList>(endpoint, "worker.list", {});
  const attach = useModuleTool<Attach>(
    endpoint,
    "worker.attach",
    { sessionId: selected ?? "", tailLines: 200 },
    selected !== undefined
  );

  const workers = list.data?.workers ?? [];

  // 何も選ばれていなければ、動いている職人を自動で選ぶ（見たいのは大抵それ）
  useEffect(() => {
    if (selected || workers.length === 0) return;
    setSelected((workers.find((w) => w.alive) ?? workers[0])!.sessionId);
  }, [workers, selected]);

  // 稼働中は出力が伸びるので定期的に取り直す。止まっている職人では回さない
  const selectedWorker = workers.find((w) => w.sessionId === selected);
  useEffect(() => {
    if (!autoRefresh || !selectedWorker?.alive) return;
    const timer = setInterval(() => {
      attach.reload();
      list.reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [autoRefresh, selectedWorker?.alive, attach, list]);

  const rendered = (attach.data?.lines ?? []).flatMap(renderLine);

  return (
    <div className="wv">
      <div className="wv-side">
        <h3 className="gv3-head">
          職人
          <span className="gv3-count">{workers.length}</span>
        </h3>
        {list.error && <div className="fb-error">読み込めません: {list.error}</div>}
        {workers.length === 0 ? (
          <p className="fb-muted gv3-empty">
            {list.loading ? "読み込み中…" : "動いている職人はいません"}
          </p>
        ) : (
          <ul className="wv-list">
            {workers.map((w) => (
              <li key={w.sessionId}>
                <button
                  className={`wv-item ${w.sessionId === selected ? "is-selected" : ""}`}
                  onClick={() => setSelected(w.sessionId)}
                  title={`${w.worktree}\npid ${w.pid} · ${w.spawnedAt}`}
                >
                  <span className={`wv-dot ${w.alive ? "is-alive" : ""}`} />
                  <span className="wv-body">
                    <span className="wv-task">{w.taskId}</span>
                    <span className="wv-meta">
                      {w.projectTag} · pid {w.pid} · {w.alive ? "稼働中" : "終了"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="wv-main">
        <div className="gv3-main-head">
          {selectedWorker ? (
            <>
              <span className="gv3-subject">{selectedWorker.taskId}</span>
              <span className="gv3-date">
                {selectedWorker.alive ? "稼働中" : "終了"} · pid {selectedWorker.pid}
              </span>
            </>
          ) : (
            <span className="gv3-subject">職人を選ぶと出力が見えます</span>
          )}
          {selectedWorker?.alive && (
            <label className="wv-auto">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              自動更新
            </label>
          )}
          {selected && (
            <button className="gv3-clear" onClick={() => attach.reload()}>
              取り直す
            </button>
          )}
        </div>

        {attach.error && <div className="fb-error">読み込めません: {attach.error}</div>}

        {!selected ? (
          <p className="fb-muted">左の一覧から選んでください</p>
        ) : rendered.length === 0 ? (
          <p className="fb-muted">{attach.loading ? "読み込み中…" : "まだ出力がありません"}</p>
        ) : (
          <div className="wv-log">
            {attach.data?.truncated && (
              <p className="fb-muted wv-note">… 末尾のみ表示（それ以前は省略）</p>
            )}
            {rendered.map((r, i) => (
              <div key={i} className={`wv-entry is-${r.kind}`}>
                {r.label && <span className="wv-entry-label">{r.label}</span>}
                <span className="wv-entry-text">{r.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
