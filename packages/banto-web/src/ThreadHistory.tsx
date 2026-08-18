/**
 * 畳んだ分身の履歴（task-0037・プロトタイプ三次改訂の「履歴タブ」）。
 *
 * 畳んでも会話は消えない（決定30c と同じ扱い）。ここは一覧→読む→再開の面で、
 * プロトタイプの裁定に従い**一覧を崩さない**（読むのは右カラム、狭い画面では
 * 一覧→詳細のドリルダウン）。
 *
 * **2つのタブ**（PO報告 2026-08-14）。
 * - **枝**：いま見ている幹にぶら下がる枝。開いているものも畳んだものも並べる。
 *   ADR-0022 決定112 はこれを会話の面（チャット欄の上）に置いたが、会話の器を
 *   常時 240px 取ってしまっていた。**流れない場所に置く**という狙いは、履歴の面でも
 *   同じだけ満たせる——他の話題をいくら重ねても消えない
 * - **幹**：終えた幹だけ（PO裁定 2026-08-10）。枝は混ぜない
 *
 * 開いた直後は**枝**。畳んだ枝を読み返したいのが、この面を開く主な用（決定111）。
 *
 * 読む側は**チャット欄と同じ姿で描く**（`ChatRow`・PO報告 2026-08-06）——ここだけ素の
 * Markdown を並べていたので、落款も、思考も、道具の呼び出しも、添付も出ていなかった。
 * 畳んだあとに読み返すのは、たった今まで見ていたものと同じ会話なので、姿を分けない。
 *
 * 検索・グルーピングはまだ入れない（task-0036/0037 のスコープ外）。まず
 * 「残ること・戻れること」から。
 */

import { useEffect, useState } from "react";
import type { ThreadView, TranscriptEntry } from "@banto/host/protocol";
import { Icon } from "./icons.js";
import { ChatRow, DayDivider, isNewDay } from "./messages.js";
import { Segmented } from "./views/ui.js";

/** 出している一覧。**URL には載せない**——下の `useState` のコメントを見よ。 */
type HistoryTab = "branch" | "trunk";

export interface ThreadHistoryProps {
  /** 「幹」タブに並べる、終えた幹。 */
  closedTrunks: ThreadView[];
  /** 「枝」タブに並べる、いま見ている幹の枝（開いているものも畳んだものも）。 */
  trunkBranches: ThreadView[];
  /** いま見ている幹の題。タブの説明に出すだけ。 */
  trunkTitle?: string;
  chatOf(threadId: string): TranscriptEntry[];
  /** 読む会話を引く。**一覧に無いものも読む**——⌘K は他の幹の枝も読ませる（決定111）。 */
  threadOf(threadId: string): ThreadView | undefined;
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
  /** 開いている枝へ移る（会話の面へ戻る）。畳んだものは `onReopen`。 */
  onOpen(threadId: string): void;
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
  const {
    closedTrunks,
    trunkBranches,
    trunkTitle,
    chatOf,
    threadOf,
    ensureHistory,
    historyLoaded,
    selectedId,
    onSelect,
    onReopen,
    onOpen,
    onBack,
  } = props;

  /**
   * どちらの一覧を出しているか。**URL には載せない**（決定41: 位置に無いものは
   * 履歴に積まない）——タブは「どこを見ているか」ではなく面の中の見せ方で、積むと
   * 会話へ戻るのに戻るを2回押すことになる。この面は閉じると消える（`App` の条件描画）
   * ので、開くたびに既定へ戻る＝**開いた直後はいつも枝**。
   *
   * ただし読む会話が先に決まっているとき（リロード・戻る・⌘K の「畳んだ会話」）は、
   * その会話が居る側を出す——出していない一覧の中身を右で読んでいると辻褄が合わない。
   */
  const [tab, setTab] = useState<HistoryTab>(() =>
    selectedId && threadOf(selectedId)?.kind === "trunk" ? "trunk" : "branch"
  );

  const rows = tab === "branch" ? trunkBranches : closedTrunks;
  const selected = selectedId ? threadOf(selectedId) : undefined;
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
        {/* 択一なので既にある `Segmented` をそのまま使う（新しい部品は起こさない） */}
        <div className="history-tabs">
          <Segmented<HistoryTab>
            label="履歴に出すもの"
            value={tab}
            onChange={(next) => {
              setTab(next);
              // 読んでいたものは畳む。別の一覧に移ったのに右が前のままだと、
              // どの一覧の何を読んでいるのか分からなくなる
              onSelect(undefined);
            }}
            options={[
              {
                value: "branch",
                label: "枝",
                title: trunkTitle ? `「${trunkTitle}」の枝` : "いま見ている幹の枝",
              },
              { value: "trunk", label: "幹", title: "終えた幹" },
            ]}
          />
        </div>
        <div className="history-list-scroll">
          {rows.length === 0 ? (
            <p className="history-empty">
              {tab === "branch" ? (
                <>
                  この幹には枝がまだありません。枝は「還す条件」と「開く理由」を書いてから
                  開きます——書けないものは枝にしません（決定77）。
                </>
              ) : (
                <>
                  終えた幹はまだありません。プロジェクトが終わったら番頭に「この幹は終い」と
                  伝えてください——幹は持って出る記憶を選んでから終います。
                </>
              )}
            </p>
          ) : (
            rows.map((thread) => {
              const closed = thread.state === "closed";
              return (
                <div
                  key={thread.threadId}
                  className={`history-row ${thread.threadId === selectedId ? "is-selected" : ""}`}
                  onClick={() => onSelect(thread.threadId)}
                >
                  <div className="history-row-head">
                    <span className="history-row-title">{thread.title}</span>
                    <span className="history-row-at">
                      {/* 開いている枝には畳んだ時刻が無い。**そこに状態を出す**——
                          一覧のまま「まだ動いている枝」と「片が付いた枝」が見分けられる */}
                      {closed ? formatClosedAt(thread.closedAt) : "動いています"}
                    </span>
                  </div>
                  {/* 枝は畳むと結論が付く（決定77）。一覧のまま結末が読めることが要点（ADR-0022 決定111） */}
                  {thread.conclusion ? (
                    <div className="history-row-conclusion">
                      <span className="bres-label">結論：</span>
                      {thread.conclusion}
                    </div>
                  ) : (
                    <div className="history-row-preview">{preview(thread)}</div>
                  )}
                  <div className="history-row-actions">
                    <button
                      className="history-row-resume"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (closed) onReopen(thread.threadId);
                        else onOpen(thread.threadId);
                      }}
                    >
                      {closed ? "再開する" : "この枝を開く"}
                    </button>
                  </div>
                </div>
              );
            })
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
              <span className="history-read-at">
                {selected.state === "closed"
                  ? `${formatClosedAt(selected.closedAt)} に畳みました`
                  : "まだ開いています"}
              </span>
              <button
                className="history-read-resume"
                type="button"
                onClick={() =>
                  selected.state === "closed"
                    ? onReopen(selected.threadId)
                    : onOpen(selected.threadId)
                }
              >
                {selected.state === "closed" ? "再開する" : "この会話を開く"}
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
                (() => {
                  const nodes: React.ReactNode[] = [];
                  // 直前行の at。**at のある行だけ更新する**——at の無い行は区切り判定の
                  // 対象にしない（task-0279）。日付が変わったら横線＋日付を挟む。
                  let prevAt: string | undefined;
                  entries.forEach((entry, i) => {
                    const at = entry.at;
                    if (at !== undefined) {
                      if (isNewDay(at, prevAt)) {
                        nodes.push(<DayDivider key={`day-${i}`} at={at} />);
                      }
                      prevAt = at;
                    }
                    nodes.push(<ChatRow key={i} entry={entry} />);
                  });
                  return nodes;
                })()
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
