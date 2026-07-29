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
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新しい発話が入ったら末尾へ追従する
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.chat]);

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
              session.tabs.map((tab) => (
                <span
                  key={tab.id}
                  className={`canvas-tab ${tab.id === session.activeTabId ? "is-active" : ""}`}
                >
                  <button
                    className="canvas-tab-label"
                    onClick={() => session.switchTab(tab.id)}
                    title={tab.kind}
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
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : ActiveView ? (
              <ActiveView params={activeTab.params} tabId={activeTab.id} kind={activeTab.kind} />
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

          <div className="chat-scroll" ref={scrollRef}>
            {session.chat.length === 0 && (
              <p className="chat-empty">
                番頭に話しかけてください。キャンバスに何かを出したいときは「〜を開いて」と頼みます。
              </p>
            )}
            {session.chat.map((entry, i) => (
              <ChatRow key={i} entry={entry} />
            ))}
          </div>

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
