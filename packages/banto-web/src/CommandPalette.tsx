/**
 * ⌘K — 会話・面・取次・設定を横断して引く単一の入口（案5「符牒」の取り分）。
 *
 * **骨格は変えない。** 既にある場所へ行くための近道でしかなく、ここから新しい状態は
 * 生まれない——押した結果は、その場所を自分で開いたときと同じ（D3）。
 *
 * 引ける先は「画面がすでに知っているもの」だけにする。ここからデータを取りに行くと、
 * 開くのに待たされる入口になり、近道の意味がなくなる。
 */

import React, { useEffect, useMemo, useState } from "react";
import type { CatalogEntryView, InboxItemView, ThreadView } from "@banto/host/protocol";
import { Icon, iconOfKind, type IconName } from "./icons.js";
import { useListNav } from "./listNav.js";

/** 引いた先。押すと `run` が走る。 */
interface Entry {
  id: string;
  icon: IconName;
  /** 何の仲間か（会話／面／取次／操作）。同じ名前でも区別がつくように出す。 */
  group: string;
  label: string;
  /** 名前だけでは分からないときの一行。 */
  hint?: string;
  /** 判断待ちの印。朱で出る唯一のもの。 */
  waiting?: boolean;
  run(): void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  threads: ThreadView[];
  closedThreads: ThreadView[];
  catalog: CatalogEntryView[];
  inbox: InboxItemView[];
  onOpenThread(threadId: string): void;
  onReopenThread(threadId: string): void;
  onOpenView(kind: string): void;
  onOpenInbox(itemId: string): void;
  onFace(face: "chat" | "history" | "settings" | "inbox"): void;
  onNewThread(): void;
  onToggleTheme(): void;
}

/**
 * かな・英字の区別をせずに当てる。**部分一致で足りる**——ここは検索ではなく近道なので、
 * 賢い当て方より「打った文字が入っていれば出る」ほうが予想を裏切らない。
 */
function matches(entry: Entry, query: string): boolean {
  if (query.length === 0) return true;
  const hay = `${entry.group} ${entry.label} ${entry.hint ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .every((t) => hay.includes(t));
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement | null {
  const { open, onClose } = props;
  const [query, setQuery] = useState("");

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];

    // 判断待ちを**先頭に置く**。横断して引くとき、POを待たせているものが最初に出る
    for (const item of props.inbox.filter((i) => !i.resolvedAt)) {
      out.push({
        id: `inbox:${item.id}`,
        icon: "inbox",
        group: "取次",
        label: item.title,
        hint: `${item.source.label} · ${item.ask}`,
        waiting: true,
        run: () => props.onOpenInbox(item.id),
      });
    }
    for (const t of props.threads) {
      out.push({
        id: `thread:${t.threadId}`,
        icon: "chat",
        group: "会話",
        label: t.title,
        run: () => props.onOpenThread(t.threadId),
      });
    }
    for (const t of props.closedThreads) {
      out.push({
        id: `closed:${t.threadId}`,
        icon: "history",
        group: "畳んだ会話",
        label: t.title,
        hint: "開き直す",
        run: () => props.onReopenThread(t.threadId),
      });
    }
    for (const c of props.catalog) {
      out.push({
        id: `view:${c.kind}`,
        icon: iconOfKind(c.kind),
        group: "面",
        label: c.title,
        hint: c.description,
        run: () => props.onOpenView(c.kind),
      });
    }
    out.push(
      { id: "act:new", icon: "plus", group: "操作", label: "新しい会話を始める", run: props.onNewThread },
      { id: "act:inbox", icon: "inbox", group: "操作", label: "取次を開く", run: () => props.onFace("inbox") },
      { id: "act:history", icon: "history", group: "操作", label: "履歴を開く", run: () => props.onFace("history") },
      { id: "act:settings", icon: "settings", group: "操作", label: "設定を開く", run: () => props.onFace("settings") },
      { id: "act:theme", icon: "moon", group: "操作", label: "明るさを切り替える", run: props.onToggleTheme }
    );
    return out;
  }, [props]);

  const hits = useMemo(() => entries.filter((e) => matches(e, query.trim())).slice(0, 40), [entries, query]);

  const choose = (entry: Entry | undefined): void => {
    if (!entry) return;
    entry.run();
    onClose();
  };
  // 上下と Enter の作法は、モデル選択・場所選び・キャンバスに開くものと同じものを使う
  const nav = useListNav(hits, { onChoose: choose, resetKey: query });

  // 開き直すたびに白紙から。前に打った文字が残っていると、出るものが読めない
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  if (!open) return null;

  return (
    <>
      <div className="cp-backdrop" onClick={onClose} />
      <div className="cp" role="dialog" aria-label="横断して引く">
        <div className="cp-field">
          <Icon name="search" size={16} className="cp-search-icon" />
          <input
            className="cp-input"
            value={query}
            placeholder="会話・面・取次を引く"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              nav.onKeyDown(e);
              if (e.defaultPrevented) return;
              // IME の変換中の Esc は変換取り消しに使われる。そこでは閉じない
              if (e.key === "Escape" && !e.nativeEvent.isComposing) onClose();
            }}
          />
          <span className="cp-hint">↑↓ で選ぶ · Enter で開く · Esc で閉じる · f で符牒</span>
        </div>

        <div className="cp-list" ref={nav.listRef}>
          {hits.length === 0 ? (
            <p className="cp-empty">「{query}」に当てはまるものはありません。</p>
          ) : (
            hits.map((e, i) => (
              <button
                key={e.id}
                type="button"
                className={`cp-row ${nav.isOn(i) ? "is-on" : ""} ${e.waiting ? "is-waiting" : ""}`}
                onClick={() => choose(e)}
                {...nav.rowProps(i)}
              >
                <Icon name={e.icon} size={15} className="cp-ico" />
                <span className="cp-main">
                  <span className="cp-label">{e.label}</span>
                  {e.hint && <span className="cp-sub">{e.hint}</span>}
                </span>
                <span className="cp-group">{e.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/**
 * ⌘K（Windows/Linux は Ctrl+K）で開く。
 *
 * **入力欄の中でも効かせる**——近道は、手が文字を打っている最中にこそ要る。
 * ただし IME の変換中は横取りしない。
 */
export function useCommandPalette(): { open: boolean; setOpen: (v: boolean) => void } {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.isComposing) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}
