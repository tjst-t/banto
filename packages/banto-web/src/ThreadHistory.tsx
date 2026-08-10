/**
 * 畳んだ分身の履歴（task-0037・プロトタイプ三次改訂の「履歴タブ」）。
 *
 * 畳んでも会話は消えない（決定30c と同じ扱い）。ここは一覧→読む→再開の面で、
 * プロトタイプの裁定に従い**一覧を崩さない**（読むのは右カラム、狭い画面では
 * 一覧→詳細のドリルダウン）。
 *
 * 読む側は**チャット欄と同じ姿で描く**（`ChatRow`・PO報告 2026-08-06）——ここだけ素の
 * Markdown を並べていたので、落款も、思考も、道具の呼び出しも、添付も出ていなかった。
 * 畳んだあとに読み返すのは、たった今まで見ていたものと同じ会話なので、姿を分けない。
 *
 * 検索・グルーピングはまだ入れない（task-0036/0037 のスコープ外）。まず
 * 「残ること・戻れること」から。
 */

import { useEffect } from "react";
import type { ThreadView, TranscriptEntry } from "@banto/host/protocol";
import { Icon } from "./icons.js";
import { ChatRow } from "./messages.js";

export interface ThreadHistoryProps {
  closedThreads: ThreadView[];
  chatOf(threadId: string): TranscriptEntry[];
  /** 読む会話の履歴を取り寄せる。接続時に届くのは見ている会話の分だけ。 */
  ensureHistory(threadId: string): void;
  /** その会話の履歴が手元にあるか（「発言なし」と「まだ来ていない」を分ける）。 */
  historyLoaded(threadId: string): boolean;
  /**
   * 右で読んでいる会話。**真実は URL**（`viewLocation.ts`）——自分で持つと、
   * リロードや戻る／進むで一覧に戻ってしまう。
   */
  selectedId?: string;
  onSelect(threadId: string | undefined): void;
  onReopen(threadId: string): void;
  onBack(): void;
}

/**
 * 一覧に出す1行分の要約。
 *
 * **ホストが `ThreadView` に載せてくる**（`preview`）。以前はここで transcript から
 * 作っていたが、そのために畳んだ会話の全文を接続時に配る必要があった——一覧の
 * 1行のために数MB流していたことになる。
 */
function preview(thread: ThreadView): string {
  return thread.preview ?? "（発言なし）";
}

function formatClosedAt(iso: string | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString();
}

export function ThreadHistory(props: ThreadHistoryProps): React.ReactElement {
  const { closedThreads, chatOf, ensureHistory, historyLoaded, selectedId, onSelect, onReopen, onBack } =
    props;
  const selected = closedThreads.find((t) => t.threadId === selectedId);
  const entries = selected ? chatOf(selected.threadId) : [];
  // 読む会話が決まってから取り寄せる（一覧を出すだけなら要約で足りる）
  const selectedThreadId = selected?.threadId;
  useEffect(() => {
    if (selectedThreadId) ensureHistory(selectedThreadId);
  }, [selectedThreadId, ensureHistory]);
  const loaded = selectedThreadId ? historyLoaded(selectedThreadId) : false;

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
              終えた幹はまだありません。プロジェクトが終わったら番頭に「この幹は終い」と
              伝えてください——持って出る記憶を選んでから終います。
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
                <div className="history-row-preview">{preview(thread)}</div>
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
                <Icon name="chevron-left" size={14} /> 一覧
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
            {/* チャット欄と同じ器（縦に積んで、発話ごとに間を空ける）に同じ部品を並べる */}
            <div className="history-read-scroll">
              {entries.length === 0 ? (
                // I1: まだ届いていないものを「発言がありません」と言い切らない
                <p className="history-read-empty">
                  {loaded ? "この会話には発言がありません。" : "読み込んでいます…"}
                </p>
              ) : (
                entries.map((entry, i) => <ChatRow key={i} entry={entry} />)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
