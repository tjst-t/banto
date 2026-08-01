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
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadView } from "@banto/host/protocol";

/** 六次改訂の裁定でモバイル扱いにする幅。プロトタイプと同じ。 */
const MOBILE_MAX_WIDTH = 780;
/** ▾ ボタンのぶんとして空けておく幅。 */
const MORE_BUTTON_RESERVE_PX = 44;
/** タブ同士の間隔（CSS の gap と合わせる）。 */
const TAB_GAP_PX = 6;

export interface ThreadTabsProps {
  threads: ThreadView[];
  activeThreadId: string | undefined;
  unreadThreadIds: string[];
  onSwitch(threadId: string): void;
  onClose(threadId: string): void;
  onOpen(): void;
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
  const { threads, activeThreadId, unreadThreadIds, onSwitch, onClose, onOpen } = props;
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * タブ1つ分の幅。**隠す前に測った値を覚えておく**——隠したあとに測ると 0 になり、
   * 「隠したから入る、入るから出す」の往復になる（プロトタイプが `computeOverflow` で
   * 実測しているのと同じ問題を、React では再描画のたびに踏む）。
   */
  const widths = useRef(new Map<string, number>());

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    for (const el of strip.querySelectorAll<HTMLElement>("[data-thread-id]")) {
      const id = el.dataset["threadId"];
      if (id && el.offsetWidth > 0) widths.current.set(id, el.offsetWidth);
    }

    if (mobile) {
      // 狭い画面ではタブ列を出さない（六次改訂）
      setHiddenIds(threads.map((t) => t.threadId));
      return;
    }

    const fit = (available: number): string[] => {
      let used = 0;
      const hidden: string[] = [];
      for (const thread of threads) {
        const width = widths.current.get(thread.threadId) ?? 0;
        const next = used + width + (used > 0 ? TAB_GAP_PX : 0);
        if (next > available) hidden.push(thread.threadId);
        else used = next;
      }
      return hidden;
    };

    const full = strip.clientWidth;
    const first = fit(full);
    // ▾ を出すなら、その分だけ狭くなる。出すか出さないかで幅が変わるので2度測る
    setHiddenIds(first.length === 0 ? [] : fit(full - MORE_BUTTON_RESERVE_PX));
  }, [mobile, threads]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest(".thread-more-wrap")) setMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  const hidden = new Set(hiddenIds);
  const unread = new Set(unreadThreadIds);
  const active = threads.find((t) => t.threadId === activeThreadId);
  const overflowing = threads.filter((t) => hidden.has(t.threadId));
  // ▾ は収まらないときだけ出す（六次改訂）。モバイルでは常に出す
  const showMore = mobile || overflowing.length > 0;

  const tab = (thread: ThreadView, inMenu: boolean): React.ReactElement => (
    <span
      key={thread.threadId}
      data-thread-id={thread.threadId}
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
        onSwitch(thread.threadId);
        setMenuOpen(false);
      }}
    >
      <button className="thread-tab" type="button">
        <span className="tt-ico">💬</span>
        <span className="tt-title">{thread.title}</span>
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
    </div>
  );
}
