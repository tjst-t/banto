/**
 * Banto の画面：チャット＋キャンバスの2ペイン（ADR-0010 決定2）。
 *
 * D3/D5: キャンバスの表示状態も会話履歴もホストが持つ真実をそのまま描く。POのタブ操作も
 *        ホストへ投げ返すので、番頭が canvas.* を呼んだ場合と結果が一致する。
 */

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptEntry } from "@banto/host/protocol";
import { useBantoSession } from "./useBantoSession.js";
import { resolveCanvasView } from "./views/registry.js";

/**
 * 既定は**同一オリジンの `/ws`**。開発サーバがそれを番頭ホストへ中継するので、
 * リバースプロキシ（Caddy等）のサブドメイン経由でもそのまま繋がる——`localhost` を
 * 直書きすると、プロキシ越しに開いたときブラウザ側のマシンを指してしまう。
 * 別ホストの番頭に繋ぎたいときは `?host=ws://...` で上書きする。
 */
function defaultWsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

const WS_URL = new URLSearchParams(location.search).get("host") ?? defaultWsUrl();

/** 末尾から何px以内を「一番下にいる」とみなすか。1行分の余裕を持たせる。 */
const AT_BOTTOM_SLACK_PX = 24;

/**
 * 末尾追従。**一番下にいるときだけ**追う（PO フィードバック）。
 *
 * 上の方を読んでいる最中に番頭が喋り出すと、勝手に下へ飛ばされて読めなくなる。
 * ライブラリ（use-stick-to-bottom 等）もあるが、この挙動はこれだけで足りるので
 * 依存を増やさない（D6）。
 */
function useStickToBottom(
  dep: unknown
): {
  ref: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  toBottom: () => void;
  onScroll: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // 追従の判断は「直前に下にいたか」で決める。描画後に測ると、追加された分だけ
  // 常に「下にいない」と判定されてしまう
  const wasAtBottom = useRef(true);

  const measure = (): void => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK_PX;
    wasAtBottom.current = bottom;
    setAtBottom(bottom);
  };

  const toBottom = (): void => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasAtBottom.current = true;
    setAtBottom(true);
  };

  useEffect(() => {
    if (wasAtBottom.current) toBottom();
    else measure();
    // dep（会話）が変わるたびに判断する
  }, [dep]);

  return { ref, atBottom, toBottom, onScroll: measure };
}

/**
 * 職人からの知らせ（決定29）。**既定は畳んでおく**——番頭の報告と違い長くなりがちで、
 * 会話を追う邪魔になるため（PO フィードバック）。クリックで開く。
 */
function NoticeRow({ text }: { text: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  // 1行目を要約として出す。Markdownの強調記号は畳んだ状態では邪魔なので落とす
  const summary = (text.split("\n").find((l) => l.trim().length > 0) ?? "")
    .replace(/\*\*/g, "")
    .trim();

  return (
    <div className={`msg msg--notice ${open ? "is-open" : ""}`}>
      <button className="notice-head" onClick={() => setOpen(!open)} title="クリックで開閉">
        <span className="notice-tag">職人</span>
        <span className="notice-caret">{open ? "▾" : "▸"}</span>
        {!open && <span className="notice-summary">{summary}</span>}
      </button>
      {open && (
        <div className="markdown notice-body">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

function ChatRow({ entry }: { entry: TranscriptEntry }): React.ReactElement {
  switch (entry.role) {
    case "po":
      return <div className="msg msg--po">{entry.text}</div>;
    case "banto":
      // 番頭の応答は Markdown で返るので整形して描く（react-markdown は既定で生HTMLを通さない）
      return (
        <div className="msg msg--banto markdown">
          {/* remark-gfm: 表・打ち消し線・タスクリスト等。素の react-markdown は CommonMark のみ */}
          <Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown>
        </div>
      );
    case "notice":
      // 職人からの知らせ（決定29）。番頭の発話と混ざらないよう見た目を分ける
      return <NoticeRow text={entry.text} />;
    case "tool":
      return (
        <div className={`msg msg--tool is-${entry.state}`}>
          <span className="tool-dot" />
          {entry.name}
          {entry.state === "running" ? " …" : entry.state === "ok" ? " ✓" : " ✗"}
        </div>
      );
    case "error":
      return <div className="msg msg--error">{entry.text}</div>;
  }
}

export function App(): React.ReactElement {
  const session = useBantoSession(WS_URL);
  const [draft, setDraft] = useState("");
  const chat = useStickToBottom(session.chat);
  const [dragTabId, setDragTabId] = useState<string>();
  const [dropIndex, setDropIndex] = useState<number>();
  const [catalogOpen, setCatalogOpen] = useState(false);

  // カタログは category ごとにまとめて出す（何が開けるか探しやすくするため）
  const catalogGroups = Object.entries(
    session.catalog.reduce<Record<string, typeof session.catalog>>((groups, entry) => {
      const key = entry.category ?? "その他";
      (groups[key] ??= []).push(entry);
      return groups;
    }, {})
  );

  // カタログメニューは外側をクリックしたら閉じる
  useEffect(() => {
    if (!catalogOpen) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest(".canvas-catalog-wrap")) setCatalogOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [catalogOpen]);

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId);
  const activeSpec = activeTab
    ? session.catalog.find((c) => c.kind === activeTab.kind)
    : undefined;
  const ActiveView = activeSpec ? resolveCanvasView(activeSpec.component) : undefined;

  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || session.busy) return;
    session.send(text);
    setDraft("");
  };

  return (
    <div className="shell">
      <header className="shell-topbar">
        <div className="brand">
          <span className="brand-mark">番</span>
          <span>
            <span className="brand-name">banto</span>
            <span className="brand-sub">番頭</span>
          </span>
        </div>
        <div className="topbar-spacer" />
        <span className={`conn conn--${session.status}`}>
          {session.status === "open" ? "接続中" : session.status === "connecting" ? "接続しています…" : "切断"}
        </span>
      </header>

      <div className="shell-body">
        <main className="canvas-pane">
          <div className="canvas-tabstrip">
            {session.tabs.length === 0 ? (
              <span className="canvas-tab-empty">タブなし</span>
            ) : (
              session.tabs.map((tab, index) => (
                <span
                  key={tab.id}
                  className={`canvas-tab ${tab.id === session.activeTabId ? "is-active" : ""} ${
                    dropIndex === index ? "is-drop-target" : ""
                  }`}
                  draggable
                  onDragStart={() => setDragTabId(tab.id)}
                  onDragEnd={() => {
                    setDragTabId(undefined);
                    setDropIndex(undefined);
                  }}
                  onDragOver={(e) => {
                    if (!dragTabId) return;
                    e.preventDefault();
                    setDropIndex(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    // 並べ替えはホストへ投げる。UIは順序を自前で持たない（D3）
                    if (dragTabId) session.reorderTab(dragTabId, index);
                    setDragTabId(undefined);
                    setDropIndex(undefined);
                  }}
                >
                  <button
                    className="canvas-tab-label"
                    onClick={() => session.switchTab(tab.id)}
                    title={`${tab.kind}（ドラッグで並べ替え）`}
                  >
                    {tab.title}
                  </button>
                  <button
                    className="canvas-tab-close"
                    onClick={() => session.closeTab(tab.id)}
                    aria-label={`${tab.title} を閉じる`}
                  >
                    ×
                  </button>
                </span>
              ))
            )}

            {/* POが自分でGUIを開く入口（決定25の人側の経路）。省スペースのため「＋」のみ */}
            {session.catalog.length > 0 && (
              <div className="canvas-catalog-wrap">
                <button
                  className="canvas-catalog-btn"
                  onClick={() => setCatalogOpen((v) => !v)}
                  aria-label="カタログを開く"
                  aria-expanded={catalogOpen}
                  title="カタログを開く"
                >
                  ＋
                </button>
                {catalogOpen && (
                  <div className="canvas-catalog-menu">
                    {catalogGroups.map(([category, entries]) => (
                      <div key={category}>
                        <div className="catalog-group-label">{category}</div>
                        {entries.map((entry) => (
                          <button
                            key={entry.kind}
                            className="catalog-item"
                            onClick={() => {
                              session.openView(entry.kind);
                              setCatalogOpen(false);
                            }}
                            title={entry.description}
                          >
                            <span className="ci-ico">{entry.icon ?? "▫"}</span>
                            <span className="ci-body">
                              <span className="ci-name">{entry.title}</span>
                              <span className="ci-src">
                                {entry.kind} · {entry.module}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="canvas-body">
            {!activeTab ? (
              <div className="canvas-empty">
                <p className="canvas-empty-title">キャンバスには何も開かれていません</p>
                <p className="canvas-empty-sub">
                  番頭に「テスト用のGUIを開いて」と頼むと、ここに表示されます。
                </p>
                {session.catalog.length > 0 && (
                  <ul className="canvas-empty-catalog">
                    {session.catalog.map((entry) => (
                      <li key={entry.kind}>
                        <code>{entry.kind}</code> — {entry.title}
                        <span className="catalog-module"> / {entry.module}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : ActiveView ? (
              // key にタブID＋版を渡す。IDだけだと (a) 同じ種別の別タブで状態が混ざり、
              // (b) タブを使い回して別のパラメータで開き直しても中身が作り直されない
              // （どちらも実際に踏んだ）
              <ActiveView
                key={`${activeTab.id}:${activeTab.rev}`}
                params={activeTab.params}
                tabId={activeTab.id}
                kind={activeTab.kind}
                module={activeSpec!.module}
                endpoint={activeSpec!.endpoint}
              />
            ) : (
              // I2: カタログにあるのにUIが解決できない＝配線漏れ。黙って空にせず理由を出す
              <div className="canvas-empty">
                <p className="canvas-empty-title">描画できません</p>
                <p className="canvas-empty-sub">
                  コンポーネント <code>{activeSpec?.component ?? "(不明)"}</code> がUI側の解決表にありません。
                </p>
              </div>
            )}
          </div>
        </main>

        <aside className="chat-pane">
          <div className="chat-head">
            <div className="chat-head-main">
              <div className="chat-title">番頭と相談する</div>
              <div className="chat-sub">
                {session.tools.length > 0 ? `${session.tools.length} tools` : "—"}
                {session.sessionId ? ` · ${session.sessionId.slice(0, 8)}` : ""}
              </div>
            </div>
            <button
              className="btn btn--ghost btn--small"
              onClick={() => {
                if (confirm("この会話を消して新しく始めます。記憶（好み・習慣）は残ります。")) {
                  session.newSession();
                }
              }}
              disabled={session.chat.length === 0}
              title="会話だけを捨てる。記憶は残る"
            >
              新しい会話
            </button>
          </div>

          <div className="chat-scroll" ref={chat.ref} onScroll={() => chat.onScroll()}>
            {session.chat.length === 0 && (
              <p className="chat-empty">
                番頭に話しかけてください。キャンバスに何かを出したいときは「〜を開いて」と頼みます。
              </p>
            )}
            {session.chat.map((entry, i) => (
              <ChatRow key={i} entry={entry} />
            ))}
          </div>

          {/* 一番下にいないときだけ出す。番頭が喋っていることに気づけるようにする */}
          {!chat.atBottom && session.chat.length > 0 && (
            <button className="chat-to-bottom" onClick={chat.toBottom} title="一番下へ">
              ↓
            </button>
          )}

          <div className="chat-composer">
            <textarea
              className="chat-input"
              value={draft}
              placeholder={session.busy ? "番頭が考えています…" : "番頭に相談する"}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter で送信、Shift+Enter で改行。IME変換中の Enter は送信しない
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="chat-actions">
              <span className="chat-hint">Enter で送信 · Shift + Enter で改行</span>
              {session.busy ? (
                <button className="btn btn--ghost" onClick={session.abort}>
                  中断
                </button>
              ) : (
                <button className="btn btn--primary" onClick={submit} disabled={draft.trim().length === 0}>
                  送る
                </button>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
