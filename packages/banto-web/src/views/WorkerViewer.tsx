/**
 * 職人（worker）ビューア＝セッションビューア（基本GUIセット・ADR-0010 決定18・25）。
 *
 * 左に職人の一覧、右にその職人のセッション出力。稼働中でも覗ける——`worker.attach` は
 * セッションJSONLの末尾を読むだけでプロセスに割り込まない。
 *
 * データは worker-pool モジュールのデータAPIから取る（決定25）。番頭のToolは呼ばない。
 * **閲覧専用**。職人の起動・停止は番頭の判断に属するので、ここからは行わない（D5）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import type { CanvasViewProps } from "./registry.js";
import { PlainText, ReasoningRow, StreamingMarkdown, ToolRow, formatPayload } from "../messages.js";
import { Icon } from "../icons.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorNote,
  Loading,
  Scroll,
  SearchField,
  SplitView,
  StatusDot,
  Toggle,
  ViewBar,
  ViewShell,
  formatRelative,
  formatTime,
  useTicker,
  type Tone,
} from "./ui.js";

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

interface WorkerList {
  workers: Worker[];
  total: number;
  closedTotal: number;
  limit: number;
  offset: number;
}
interface Attach {
  sessionId: string;
  lines: string[];
  truncated: boolean;
}

/**
 * 状態の見せ方。alive だけでは「待ちっぱなし」が見えない（決定29b）。
 * 畳んだ理由まで出す（決定30e）——idle が並ぶのは面倒を見ていない兆候。
 */
function stateOf(w: Worker): { label: string; tone: Tone; pulse: boolean } {
  if (w.state === "waiting") return { label: "質問待ち", tone: "warn", pulse: true };
  if (w.state === "running") return { label: "稼働中", tone: "ok", pulse: true };
  if (w.state === "closed") {
    if (w.closeReason === "idle") return { label: "放置で終了", tone: "warn", pulse: false };
    if (w.closeReason === "stopped") return { label: "強制停止", tone: "danger", pulse: false };
    return { label: "完了", tone: "neutral", pulse: false };
  }
  return { label: w.alive ? "稼働中" : "終了", tone: w.alive ? "ok" : "danger", pulse: false };
}

/**
 * セッションJSONL を、チャットと同じ形の並びに落とす。
 *
 * 職人のやり取りは「発話・思考・ツール呼び出し」という点で番頭との会話と同じ構造をしている。
 * **同じものは同じ見た目で出す**——ここでは並びに直すだけで、描くのは `messages.tsx`。
 */
interface WorkerEntry {
  kind: "user" | "assistant" | "thinking" | "tool" | "meta" | "raw";
  text: string;
  /** ツールのとき */
  name?: string;
  input?: unknown;
  output?: unknown;
  state?: "running" | "ok" | "failed";
  /** 結果を後から差し込むための照合キー。 */
  callId?: string;
}

function parseSession(lines: string[]): WorkerEntry[] {
  const out: WorkerEntry[] = [];
  /** toolCall の位置。結果は別のメッセージで後から届くので、id で戻って差し込む。 */
  const byCallId = new Map<string, number>();

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // I2: 解釈できない行を捨てない。生で見せる
      out.push({ kind: "raw", text: line });
      continue;
    }

    const e = entry as {
      type?: string;
      provider?: string;
      modelId?: string;
      message?: {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        toolName?: string;
        isError?: boolean;
      };
    };

    if (e.type === "session") {
      out.push({ kind: "meta", text: "セッション開始" });
      continue;
    }
    if (e.type === "model_change") {
      out.push({ kind: "meta", text: `モデル: ${e.provider ?? "?"}/${e.modelId ?? "?"}` });
      continue;
    }
    if (e.type !== "message" || !e.message) continue;

    const message = e.message;
    const role = message.role ?? "?";
    const content = message.content;

    // ツールの結果は別メッセージで来る。呼び出しの行に差し込む（並べると読み筋が切れる）
    if (role === "toolResult") {
      const text = collectText(content);
      const at = message.toolCallId ? byCallId.get(message.toolCallId) : undefined;
      const state = message.isError === true ? "failed" : "ok";
      if (at !== undefined) {
        out[at] = { ...out[at]!, output: text, state };
      } else {
        out.push({ kind: "tool", text: "", name: message.toolName ?? "結果", output: text, state });
      }
      continue;
    }

    if (typeof content === "string") {
      out.push({ kind: role === "user" ? "user" : "assistant", text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content as Array<Record<string, unknown>>) {
      const type = String(block["type"] ?? "");
      if (type === "text" && typeof block["text"] === "string") {
        out.push({ kind: role === "user" ? "user" : "assistant", text: block["text"] });
      } else if (type === "thinking" && typeof block["thinking"] === "string") {
        out.push({ kind: "thinking", text: block["thinking"] });
      } else if (type === "toolCall") {
        const callId = typeof block["id"] === "string" ? block["id"] : undefined;
        out.push({
          kind: "tool",
          text: "",
          name: String(block["name"] ?? "?"),
          input: block["arguments"] ?? block["args"] ?? {},
          // 結果が届いていない＝まだ走っている（末尾の1件で普通に起きる）
          state: "running",
          ...(callId ? { callId } : {}),
        });
        if (callId) byCallId.set(callId, out.length - 1);
      }
    }
  }
  return out;
}

/** content（文字列 or ブロック配列）から読める文字を集める。 */
function collectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return formatPayload(content);
  return (content as Array<Record<string, unknown>>)
    .map((b) => (typeof b["text"] === "string" ? b["text"] : formatPayload(b)))
    .join("\n");
}

/** 1ページに出す職人の数。 */
const PAGE_SIZE = 20;
/** 稼働中の職人を見ているときの取り直し間隔。 */
const REFRESH_MS = 3000;

export function WorkerViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialSessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
  const [selected, setSelected] = useState<string | undefined>(initialSessionId);
  const [showLog, setShowLog] = useState(initialSessionId !== undefined);
  const [autoRefresh, setAutoRefresh] = useState(true);
  /** 畳んだ職人を出すか。**既定は出さない**——いま動いているものが埋もれるため。 */
  const [showClosed, setShowClosed] = useState(false);
  const [page, setPage] = useState(0);
  /** 入力中の文字。打つたびに問い合わせないよう、確定した query とは分けて持つ */
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const now = useTicker(30_000);

  // 絞り込みもページ送りも Worker Pool 側で行う。履歴が増えても全件を受け取らずに済む
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
  const waiting = workers.filter((w) => w.state === "waiting");

  // 絞り込みを変えたら先頭のページへ戻す（空ページに取り残されないように）
  useEffect(() => {
    setPage(0);
  }, [showClosed, query]);

  // 何も選ばれていなければ、動いている職人を自動で選ぶ（見たいのは大抵それ）
  useEffect(() => {
    if (selected || workers.length === 0) return;
    setSelected((workers.find((w) => w.alive) ?? workers[0])!.sessionId);
  }, [workers, selected]);

  // 絞り込みで一覧から外れても、選んだ職人の中身は見せ続ける
  const selectedWorker = workers.find((w) => w.sessionId === selected);
  const alive = selectedWorker?.alive === true;

  /**
   * 稼働中は出力が伸びるので定期的に取り直す。止まっている職人では回さない。
   * 依存に置くのは**安定した reload だけ**——フックの返り値そのものを置くと、
   * 毎描画で参照が変わって間隔が張り直され、いつまでも発火しない。
   */
  const reloadAttach = attach.reload;
  const reloadList = list.reload;
  useEffect(() => {
    if (!autoRefresh || !alive) return;
    const timer = setInterval(() => {
      reloadAttach();
      reloadList();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, alive, reloadAttach, reloadList]);

  const rendered = useMemo(() => parseSession(attach.data?.lines ?? []), [attach.data]);

  /** 出力の末尾を追う。**上を読んでいる最中は追わない**——読んでいる場所から飛ばされる。 */
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (!el || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rendered]);
  useEffect(() => {
    // 別の職人へ移ったら、末尾から読み始める
    atBottom.current = true;
  }, [selected]);

  const listPane = (
    <>
      <ViewBar>
        <SearchField
          value={draft}
          onChange={setDraft}
          onSubmit={setQuery}
          placeholder="taskId・指示の内容で絞る（Enter）"
        />
      </ViewBar>
      <ViewBar>
        <Toggle checked={showClosed} onChange={setShowClosed} title="畳んだ職人も一覧に出す">
          終わった職人も表示{closedCount > 0 && !showClosed ? `（${closedCount}）` : ""}
        </Toggle>
        <span className="cv-spacer" />
        <Button small variant="ghost" onClick={() => list.reload()} title="一覧を取り直す">
          ⟳
        </Button>
      </ViewBar>

      {/* 決定29b: 待っている職人は、番頭が答えるまで止まったまま。一覧の先頭で気づかせる */}
      {waiting.length > 0 && !showLog && (
        <div className="cv-note is-warn">
          {waiting.length} 人が番頭の答えを待っています。
        </div>
      )}

      {list.error && <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>}

      <Scroll pad={false}>
        {list.loading && !list.data ? (
          <Loading rows={5} />
        ) : workers.length === 0 ? (
          <EmptyState
            icon="worker"
            title={query ? `「${query}」に当てはまる職人はいません` : "動いている職人はいません"}
          >
            {closedCount > 0 && !showClosed
              ? `終わった職人が ${closedCount} 人います。「終わった職人も表示」で見られます。`
              : "番頭に仕事を頼むと、ここに職人が並びます。"}
          </EmptyState>
        ) : (
          <ul className="cv-list">
            {workers.map((w) => {
              const state = stateOf(w);
              return (
                <li key={w.sessionId}>
                  <button
                    className={`cv-row ${w.sessionId === selected ? "is-selected" : ""}`}
                    onClick={() => {
                      setSelected(w.sessionId);
                      setShowLog(true);
                    }}
                    title={`${w.worktree}\npid ${w.pid} · ${formatTime(w.spawnedAt)}`}
                  >
                    <StatusDot tone={state.tone} pulse={state.pulse} title={state.label} />
                    <span className="cv-row-main">
                      <span className="cv-row-name">{w.taskId}</span>
                      <span className="cv-row-sub">
                        {state.label} · {w.projectTag} · {formatRelative(w.spawnedAt, now) || "—"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>

      {pageCount > 1 && (
        <div className="wv-pager">
          <Button small variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>
            ‹ 前
          </Button>
          <span>
            {current + 1} / {pageCount}
          </span>
          <Button
            small
            variant="ghost"
            disabled={current >= pageCount - 1}
            onClick={() => setPage(current + 1)}
          >
            次 <Icon name="chevron-right" size={13} />
          </Button>
        </div>
      )}
    </>
  );

  const state = selectedWorker ? stateOf(selectedWorker) : undefined;
  const detailPane = !selectedWorker ? (
    <EmptyState icon="worker" title="職人を選ぶと出力が見えます">
      稼働中でも覗けます（読むだけで、職人の邪魔はしません）。
    </EmptyState>
  ) : (
    <>
      <div className="cv-head">
        <span className="cv-head-title">{selectedWorker.taskId}</span>
        {state && (
          <Badge tone={state.tone}>
            {state.label}
          </Badge>
        )}
        <span className="cv-head-sub">
          pid {selectedWorker.pid} · {formatRelative(selectedWorker.spawnedAt, now)}に開始
        </span>
        <span className="cv-spacer" />
        {alive && (
          <Toggle checked={autoRefresh} onChange={setAutoRefresh} title="3秒ごとに出力を取り直す">
            自動更新
          </Toggle>
        )}
        <Button small variant="ghost" onClick={() => attach.reload()} title="出力を取り直す">
          ⟳
        </Button>
      </div>

      {/* 決定29b: 待っている職人は、何を待っているかまで見せないと動かしようがない */}
      {selectedWorker.state === "waiting" && selectedWorker.question && (
        <p className="wv-question">
          <strong>番頭の答え待ち</strong>
          <br />
          {selectedWorker.question}
        </p>
      )}

      {attach.error && <ErrorNote onRetry={attach.reload}>{attach.error}</ErrorNote>}

      {rendered.length === 0 ? (
        attach.loading ? (
          <Loading rows={5} />
        ) : (
          <EmptyState icon="worker" title="まだ出力がありません">
            職人が動き出すと、ここにやり取りが流れます。
          </EmptyState>
        )
      ) : (
        <div
          className="chat-scroll wv-log"
          ref={logRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {/* チャット欄と同じ器（.chat-scroll-content）に同じ部品を並べる */}
          <div className="chat-scroll-content">
            {attach.data?.truncated && (
              <p className="wv-note">… 末尾のみ表示（それ以前は省略）</p>
            )}
            {rendered.map((r, i) => {
              if (r.kind === "tool") {
                return (
                  <ToolRow
                    key={i}
                    name={r.name ?? "?"}
                    state={r.state ?? "running"}
                    input={r.input}
                    output={r.output}
                  />
                );
              }
              if (r.kind === "thinking") {
                // 済んだ記録なので畳んで始める（読みたいときに開く）
                return <ReasoningRow key={i} text={r.text} isStreaming={false} defaultOpen={false} />;
              }
              if (r.kind === "user") {
                // 職人への指示は**生成された Markdown**（タスク定義そのもの）。
                // 素で出すと `## 実装タスク` `**タイトル**:` が記号のまま並ぶ（PO報告 2026-08-11）
                return (
                  <div key={i} className="msg msg--po markdown">
                    <StreamingMarkdown text={r.text} />
                  </div>
                );
              }
              if (r.kind === "assistant") {
                return (
                  <div key={i} className="msg msg--banto markdown">
                    <StreamingMarkdown text={r.text} />
                  </div>
                );
              }
              if (r.kind === "meta") {
                return (
                  <div key={i} className="wv-entry is-meta">
                    {r.text}
                  </div>
                );
              }
              return (
                <div key={i} className="wv-entry is-raw">
                  {/* 解釈できなかった行。素のまま出しつつ、URL とパスだけ押せる */}
                  <PlainText text={r.text} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );

  return (
    <ViewShell className="wv">
      <SplitView
        size="md"
        list={listPane}
        detail={detailPane}
        showDetail={showLog}
        onBack={() => setShowLog(false)}
        backLabel="職人の一覧"
      />
    </ViewShell>
  );
}
