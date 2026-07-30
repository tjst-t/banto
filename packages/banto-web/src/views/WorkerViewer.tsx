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
  /** running / waiting / exited / closed（決定29b・決定30） */
  state: "running" | "waiting" | "exited" | "closed";
  spawnedAt: string;
  /** 答えを待っている質問（waiting のとき） */
  question?: string;
  /** 畳んだ理由（closed のとき。決定30e） */
  closeReason?: "done" | "idle" | "stopped";
  closedAt?: string;
}

/** 状態の表示名。alive だけでは「待ちっぱなし」が見えない（決定29b）。 */
function stateLabel(w: Worker): string {
  if (w.state === "waiting") return "質問待ち";
  if (w.state === "closed") {
    // 決定30e: なぜ終わったのかまで見せる。idle が並ぶのは面倒を見ていない兆候
    return w.closeReason === "idle"
      ? "放置で終了"
      : w.closeReason === "stopped"
        ? "強制停止"
        : "完了";
  }
  return w.alive ? "稼働中" : "終了";
}
interface WorkerList {
  workers: Worker[];
  /** 絞り込みに当てはまる総数（ページ数の計算に使う） */
  total: number;
  /** うち畳んだ職人の数。隠していることを言うために使う */
  closedTotal: number;
  limit: number;
  offset: number;
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

/** 1ページに出す職人の数。 */
const PAGE_SIZE = 20;

export function WorkerViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialSessionId =
    typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
  const [selected, setSelected] = useState<string | undefined>(initialSessionId);
  const [autoRefresh, setAutoRefresh] = useState(true);
  /** 畳んだ職人を出すか。**既定は出さない**——いま動いているものが埋もれるため。 */
  const [showClosed, setShowClosed] = useState(false);
  const [page, setPage] = useState(0);
  /** 入力中の文字。打つたびに問い合わせないよう、確定した query とは分けて持つ */
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");

  // 絞り込みもページ送りも Worker Pool 側で行う（提案 worker-list-pagination の A案）。
  // 履歴が増えても、UIが全件を受け取らずに済む
  const list = useModuleTool<WorkerList>(endpoint, "worker.list", {
    includeClosed: showClosed,
    query,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const attach = useModuleTool<Attach>(
    endpoint,
    "worker.attach",
    { sessionId: selected ?? "", tailLines: 200 },
    selected !== undefined
  );

  // 並び順もページ送りも Worker Pool 側の結果をそのまま描く（D3・D5）
  const workers = list.data?.workers ?? [];
  const total = list.data?.total ?? 0;
  const closedCount = list.data?.closedTotal ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);

  // 絞り込みを変えたら先頭のページへ戻す（空ページに取り残されないように）
  useEffect(() => {
    setPage(0);
  }, [showClosed, query]);

  // 何も選ばれていなければ、動いている職人を自動で選ぶ（見たいのは大抵それ）
  useEffect(() => {
    if (selected || workers.length === 0) return;
    setSelected((workers.find((w) => w.alive) ?? workers[0])!.sessionId);
  }, [workers, selected]);

  // 稼働中は出力が伸びるので定期的に取り直す。止まっている職人では回さない
  // 絞り込みで一覧から外れても、選んだ職人の中身は見せ続ける
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
          <span className="gv3-count">{total}</span>
          {/* 決定30c: 畳んだ職人も記録は残る。既定では隠し、見たいときだけ出す */}
          <label className="wv-toggle" title="畳んだ職人も一覧に出す">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            完了を含む
            {closedCount > 0 && !showClosed && (
              <span className="wv-hidden">（{closedCount}）</span>
            )}
          </label>
        </h3>
        {/* 絞り込み。打つたびに問い合わせず、Enter か虫眼鏡で確定する */}
        <div className="wv-search">
          <input
            type="search"
            value={draft}
            placeholder="taskId・指示の内容などで絞る"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setQuery(draft);
              if (e.key === "Escape") {
                setDraft("");
                setQuery("");
              }
            }}
          />
          <button onClick={() => setQuery(draft)} title="絞り込む">
            🔍
          </button>
        </div>

        {list.error && <div className="fb-error">読み込めません: {list.error}</div>}
        {workers.length === 0 ? (
          <p className="fb-muted gv3-empty">
            {list.loading
              ? "読み込み中…"
              : query
                ? `「${query}」に当てはまる職人はいません`
                : closedCount > 0
                  ? `動いている職人はいません（完了 ${closedCount} 件は「完了を含む」で見られます）`
                  : "動いている職人はいません"}
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
                  <span className={`wv-dot is-${w.state}`} />
                  <span className="wv-body">
                    <span className="wv-task">{w.taskId}</span>
                    <span className="wv-meta">
                      {w.projectTag} · pid {w.pid} · {stateLabel(w)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {pageCount > 1 && (
          <div className="wv-pager">
            <button disabled={current === 0} onClick={() => setPage(current - 1)}>
              ‹
            </button>
            <span>
              {current + 1} / {pageCount}
            </span>
            <button disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
              ›
            </button>
          </div>
        )}
      </div>

      <div className="wv-main">
        <div className="gv3-main-head">
          {selectedWorker ? (
            <>
              <span className="gv3-subject">{selectedWorker.taskId}</span>
              <span className="gv3-date">
                {stateLabel(selectedWorker)} · pid {selectedWorker.pid}
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

        {/* 決定29b: 待っている職人は、何を待っているかまで見せないと動かしようがない */}
        {selectedWorker?.state === "waiting" && selectedWorker.question && (
          <p className="wv-question">
            番頭の答え待ち: {selectedWorker.question}
          </p>
        )}

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
