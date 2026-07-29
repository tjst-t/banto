/**
 * Banto の画面：チャット＋キャンバスの2ペイン（ADR-0010 決定2）。
 *
 * D3/D5: キャンバスの表示状態はホストが持つ真実をそのまま描くだけ。UIは判断を持たず、
 *        タブの開閉・切替も「番頭が canvas.* Tool で行う」のが主経路。
 *        （PO が直接触るタブ操作はUI都合の操作なので、ホストへ送らずローカルには持たない——
 *          いまは番頭経由に一本化しておく。必要になったらToolを介して足す）
 */

import { useState } from "react";
import { useBantoSession, type ChatEntry } from "./useBantoSession.js";
import { resolveCanvasView } from "./views/registry.js";

const WS_URL = new URLSearchParams(location.search).get("host") ?? "ws://localhost:4100/ws";

function ChatRow({ entry }: { entry: ChatEntry }): React.ReactElement {
  switch (entry.kind) {
    case "po":
      return <div className="msg msg--po">{entry.text}</div>;
    case "banto":
      return <div className="msg msg--banto">{entry.text}</div>;
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
                  {tab.title}
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
            <div className="chat-title">番頭と相談する</div>
            <div className="chat-sub">
              {session.tools.length > 0 ? `${session.tools.length} tools` : "—"}
              {session.sessionId ? ` · ${session.sessionId.slice(0, 8)}` : ""}
            </div>
          </div>

          <div className="chat-scroll">
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
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <div className="chat-actions">
              <span className="chat-hint">⌘/Ctrl + Enter で送信</span>
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
