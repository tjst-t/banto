/**
 * 畳んだ分身の履歴（task-0037・プロトタイプ三次改訂の「履歴タブ」）。
 *
 * 畳んでも会話は消えない（決定30c と同じ扱い）。ここは一覧→読む→再開の面で、
 * プロトタイプの裁定に従い**一覧を崩さない**（読むのは右カラム、狭い画面では
 * 一覧→詳細のドリルダウン）。
 *
 * 検索・グルーピングはまだ入れない（task-0036/0037 のスコープ外）。まず
 * 「残ること・戻れること」から。
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ThreadView, TranscriptEntry } from "@banto/host/protocol";

export interface ThreadHistoryProps {
  closedThreads: ThreadView[];
  chatOf(threadId: string): TranscriptEntry[];
  /**
   * 右で読んでいる会話。**真実は URL**（`viewLocation.ts`）——自分で持つと、
   * リロードや戻る／進むで一覧に戻ってしまう。
   */
  selectedId?: string;
  onSelect(threadId: string | undefined): void;
  onReopen(threadId: string): void;
  onBack(): void;
}

/** 一覧に出す1行分の要約。中身が分かる最初の発話を採る。 */
function preview(entries: TranscriptEntry[]): string {
  const first = entries.find((e) => e.role === "po" || e.role === "banto");
  if (!first || !("text" in first)) return "（発言なし）";
  const line = first.text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function formatClosedAt(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString();
}

export function ThreadHistory(props: ThreadHistoryProps): React.ReactElement {
  const { closedThreads, chatOf, selectedId, onSelect, onReopen, onBack } = props;
  const selected = closedThreads.find((t) => t.threadId === selectedId);
  const entries = selected ? chatOf(selected.threadId) : [];

  return (
    <div className={`history-view ${selected ? "showing-read" : ""}`}>
      <div className="history-list-col">
        <div className="history-head">
          <h2 className="history-title">履歴</h2>
          <button className="history-back-to-chat" type="button" onClick={onBack}>
            会話へ戻る
          </button>
        </div>
        <div className="history-list-scroll">
          {closedThreads.length === 0 ? (
            <p className="history-empty">
              畳んだ会話はまだありません。会話タブの × で畳むと、ここに残ります。
            </p>
          ) : (
            closedThreads.map((thread) => (
              <div
                key={thread.threadId}
                className={`history-row ${thread.threadId === selectedId ? "is-selected" : ""}`}
                onClick={() => onSelect(thread.threadId)}
              >
                <div className="history-row-head">
                  <span className="history-row-title">{thread.title}</span>
                  <span className="history-row-at">{formatClosedAt(thread.closedAt)}</span>
                </div>
                <div className="history-row-preview">{preview(chatOf(thread.threadId))}</div>
                <div className="history-row-actions">
                  <button
                    className="history-row-resume"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReopen(thread.threadId);
                    }}
                  >
                    再開する
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="history-read-col">
        {!selected ? (
          <p className="history-read-empty">
            左の一覧から会話を選ぶと、ここに中身を表示します。
          </p>
        ) : (
          <>
            <div className="history-read-head">
              <button
                className="history-read-back"
                type="button"
                onClick={() => onSelect(undefined)}
              >
                ← 一覧
              </button>
              <h3>{selected.title}</h3>
              <span className="history-read-at">{formatClosedAt(selected.closedAt)} に畳みました</span>
              <button
                className="history-read-resume"
                type="button"
                onClick={() => onReopen(selected.threadId)}
              >
                再開する
              </button>
            </div>
            <div className="history-read-scroll">
              {entries.length === 0 ? (
                <p className="history-read-empty">この会話には発言がありません。</p>
              ) : (
                entries.map((entry, i) => (
                  <div key={i} className={`msg msg--${entry.role}`}>
                    {entry.role === "tool" ? (
                      <span className="msg-tool">
                        {entry.name} · {entry.state}
                      </span>
                    ) : (
                      <div className="msg-body">
                        <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
