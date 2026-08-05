/**
 * 分身（会話スレッド）のタブ列（ADR-0010 決定2・task-0037）。
 *
 * 見た目と挙動は `prototype/banto-shell.html` で PO 承認済みの裁定に従う。
 * 蒸し返さないよう、決まっている点をここに書いておく：
 *
 * - **丸ボタン（pill）**。八次改訂で「地続きに見せるタブ」路線は破棄した
 *   （キャンバスのタブは別物で、そちらは地続きのまま＝九次改訂）
 * - **横スクロールは使わない**。収まらない分だけ ▾ に収納し、**▾ は収まらないときだけ出す**。
 *   中身は「全部」ではなく「はみ出している分だけ」（六次改訂）
 * - **狭い画面ではタブ列を出さず**、現在の会話名＋▾のドロップダウンに統一する。
 *   「＋新しい会話」も ▾ の先頭に入れる（六次改訂）
 * - × と切替の**入れ子のクリック判定は close を先に**（四次・六次改訂で2度踏んだ）
 * - **右クリックで名前を変えられる**（PO要望 2026-08-05）。番頭の `thread.rename` と
 *   同じ結果になる人側の経路（決定25）。名前の真実はホストなので、ここでは投げるだけで
 *   楽観更新しない——`thread_state` が返って初めてタブの字が変わる（D3）
 */

import { useEffect, useRef, useState } from "react";
import type { ThreadView } from "@banto/host/protocol";
import { useTabOverflow } from "./useTabOverflow.js";

/** 六次改訂の裁定でモバイル扱いにする幅。プロトタイプと同じ。 */
const MOBILE_MAX_WIDTH = 780;

/**
 * 入力欄で受ける名前の長さ。ホスト側の `MAX_THREAD_TITLE_LENGTH` と同じ値を置く
 * ——値そのものは**ホストが真実**（超えた分は向こうで切り詰められる）。ここは
 * 打っている最中に「入るのか入らないのか」を見せるためだけの写し。
 * 実行時の値を持ち込むと、UI のバンドルにホスト側（Node向け）が丸ごと入る。
 */
const MAX_TITLE_LENGTH = 40;

/** 右クリックメニューの見た目の大きさ（画面の外へはみ出させないための寄せ幅）。 */
const CTX_MENU_WIDTH = 220;
const CTX_MENU_HEIGHT = 88;

export interface ThreadTabsProps {
  threads: ThreadView[];
  activeThreadId: string | undefined;
  unreadThreadIds: string[];
  onSwitch(threadId: string): void;
  onClose(threadId: string): void;
  onOpen(): void;
  /** 名前を付け直す（右クリック → 名前を変える）。ホストへ投げるだけ。 */
  onRename(threadId: string, title: string): void;
}

/** 右クリックで出す小さなメニューの位置と対象。 */
interface TabMenu {
  threadId: string;
  x: number;
  y: number;
}

/** 画面幅がモバイル扱いか。 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.innerWidth <= MOBILE_MAX_WIDTH);
  useEffect(() => {
    const onResize = (): void => setMobile(window.innerWidth <= MOBILE_MAX_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mobile;
}

export function ThreadTabs(props: ThreadTabsProps): React.ReactElement {
  const { threads, activeThreadId, unreadThreadIds, onSwitch, onClose, onOpen, onRename } = props;
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  /** 右クリックで出したメニュー（対象の会話と位置）。 */
  const [tabMenu, setTabMenu] = useState<TabMenu | undefined>(undefined);
  /** いま名前を書き換えている会話。タブの字が入力欄に変わる。 */
  const [editing, setEditing] = useState<string | undefined>(undefined);
  /** 確定を1回にする——Enter で確定したあとの blur で二重に投げない。 */
  const committed = useRef(false);
  // 収まらない分だけ ▾ に収納する（計測は useTabOverflow）。狭い画面では全部そちらへ
  const { stripRef, hiddenIds: hidden } = useTabOverflow(
    threads.map((t) => t.threadId),
    { hideAll: mobile }
  );

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest(".thread-more-wrap")) setMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  // 右クリックメニューは、次のクリック・Esc・スクロールで消す（開きっぱなしにしない）
  useEffect(() => {
    if (!tabMenu) return;
    const dismiss = (): void => setTabMenu(undefined);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setTabMenu(undefined);
    };
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismiss);
    };
  }, [tabMenu]);

  /** 書き換えを確定する。空にしたときは**名前を変えない**（消す操作ではない）。 */
  const commitRename = (threadId: string, value: string): void => {
    if (committed.current) return;
    committed.current = true;
    setEditing(undefined);
    const title = value.trim();
    const before = threads.find((t) => t.threadId === threadId)?.title;
    if (title !== "" && title !== before) onRename(threadId, title);
  };

  const unread = new Set(unreadThreadIds);
  const active = threads.find((t) => t.threadId === activeThreadId);
  const overflowing = threads.filter((t) => hidden.has(t.threadId));
  // ▾ は収まらないときだけ出す（六次改訂）。モバイルでは常に出す
  const showMore = mobile || overflowing.length > 0;

  const tab = (thread: ThreadView, inMenu: boolean): React.ReactElement => (
    <span
      key={thread.threadId}
      data-tab-id={thread.threadId}
      className={[
        inMenu ? "thread-menu-row" : "thread-tab-wrap",
        thread.threadId === activeThreadId ? "is-active" : "",
        !inMenu && hidden.has(thread.threadId) ? "is-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      // 入れ子のクリック判定は close を先に（四次・六次改訂）
      onClick={(e) => {
        if ((e.target as Element).closest("[data-thread-close]")) return;
        if (editing === thread.threadId) return; // 書き換え中は切替に取られない
        onSwitch(thread.threadId);
        setMenuOpen(false);
      }}
      // 右クリックで名前を変える／畳む（PO要望 2026-08-05）
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(false);
        setTabMenu({ threadId: thread.threadId, x: e.clientX, y: e.clientY });
      }}
    >
      <button className="thread-tab" type="button">
        <span className="tt-ico">💬</span>
        {editing === thread.threadId ? (
          <input
            className="tt-rename"
            defaultValue={thread.title}
            autoFocus
            maxLength={MAX_TITLE_LENGTH}
            aria-label="会話の名前"
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation(); // 入力中のキーを画面側のショートカットに拾わせない
              if (e.key === "Enter") commitRename(thread.threadId, e.currentTarget.value);
              // Esc は**やめる**。書きかけを捨てて元の名前のまま戻す
              if (e.key === "Escape") {
                committed.current = true;
                setEditing(undefined);
              }
            }}
            onBlur={(e) => commitRename(thread.threadId, e.currentTarget.value)}
          />
        ) : (
          <span className="tt-title">{thread.title}</span>
        )}
        {unread.has(thread.threadId) && thread.threadId !== activeThreadId && (
          <span className="tt-unread" title="新しい知らせがあります" />
        )}
      </button>
      {/* どの会話も畳める（PO要望 2026-07-31）。畳んでも履歴に残るので失われない */}
      <button
        className="thread-tab-close"
        type="button"
        data-thread-close=""
        aria-label={`${thread.title} を閉じる`}
        title="会話を畳む（履歴に残ります）"
        onClick={() => onClose(thread.threadId)}
      >
        ×
      </button>
    </span>
  );

  return (
    <div className="thread-tabs-wrap">
      <div className={`thread-tabs ${mobile ? "is-mobile" : ""}`} ref={stripRef}>
        {threads.map((t) => tab(t, false))}
      </div>

      {!mobile && (
        <button className="thread-new-btn" type="button" onClick={onOpen} title="新しい会話を始める">
          ＋
        </button>
      )}

      {showMore && (
        <div className="thread-more-wrap">
          <button
            className="thread-more-btn"
            type="button"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="tmb-title">{mobile ? (active?.title ?? "会話なし") : ""}</span>
            <span className="tmb-caret">▾</span>
            {overflowing.length > 0 && !mobile && (
              <span className="tmb-count">{overflowing.length}</span>
            )}
          </button>
          {menuOpen && (
            <div className="thread-more-menu">
              <button
                className="thread-menu-new"
                type="button"
                onClick={() => {
                  onOpen();
                  setMenuOpen(false);
                }}
              >
                ＋ 新しい会話を始める
              </button>
              {/* 中身は「全部」ではなく**はみ出している分だけ**（六次改訂）。
                  モバイルではタブ列そのものを出さないので全部がここに来る */}
              {overflowing.length > 0 && <div className="thread-menu-divider" />}
              {overflowing.map((t) => tab(t, true))}
            </div>
          )}
        </div>
      )}

      {/* 右クリックのメニュー。画面の隅で切れないよう、位置は幅・高さの分だけ内側へ寄せる */}
      {tabMenu && (
        <div
          className="thread-ctx-menu"
          style={{
            left: Math.min(tabMenu.x, window.innerWidth - CTX_MENU_WIDTH),
            top: Math.min(tabMenu.y, window.innerHeight - CTX_MENU_HEIGHT),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              committed.current = false;
              setEditing(tabMenu.threadId);
              setTabMenu(undefined);
            }}
          >
            ✎ 名前を変える
          </button>
          <button
            type="button"
            onClick={() => {
              onClose(tabMenu.threadId);
              setTabMenu(undefined);
            }}
          >
            × 会話を畳む（履歴に残ります）
          </button>
        </div>
      )}
    </div>
  );
}
