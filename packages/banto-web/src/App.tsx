/**
 * Banto の画面：チャット＋キャンバスの2ペイン（ADR-0010 決定2）。
 *
 * D3/D5: キャンバスの表示状態も会話履歴もホストが持つ真実をそのまま描く。POのタブ操作も
 *        ホストへ投げ返すので、番頭が canvas.* を呼んだ場合と結果が一致する。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptEntry } from "@banto/host/protocol";
import { useBantoSession } from "./useBantoSession.js";
import { resolveCanvasView } from "./views/registry.js";
import { ThreadTabs } from "./ThreadTabs.js";
import { ThreadHistory } from "./ThreadHistory.js";
import { SettingsPanel } from "./views/SettingsPanel.js";

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

/** チャット欄の幅の記憶先。 */
const CHAT_WIDTH_KEY = "banto.chatWidth";
const CHAT_WIDTH_DEFAULT = 400;
const CHAT_WIDTH_MIN = 300;
/** 入力欄の最低の高さ（1/3 の上限がこれを下回らないように）。 */
const MIN_COMPOSER_HEIGHT_PX = 56;

/** キャンバス側が潰れない範囲に収める。 */
function clampChatWidth(width: number): number {
  const max = Math.max(CHAT_WIDTH_MIN, window.innerWidth - 360);
  return Math.min(Math.max(width, CHAT_WIDTH_MIN), max);
}

function readStoredChatWidth(): number {
  try {
    const stored = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampChatWidth(stored) : CHAT_WIDTH_DEFAULT;
  } catch {
    return CHAT_WIDTH_DEFAULT;
  }
}

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
 * 知らせの出所ごとの札。
 *
 * **外から入る知らせを全部「職人」で出さない**（PO報告 2026-07-31）——番頭が別の会話を
 * 開いたときの最初の一言まで職人に見えていた。知らない出所はそのまま出す（隠さない）。
 */
const NOTICE_LABELS: Record<string, string> = {
  worker: "職人",
  thread: "別の会話",
  system: "知らせ",
};

/**
 * POでも番頭でもない知らせ（決定29）。**既定は畳んでおく**——番頭の報告と違い長くなりがちで、
 * 会話を追う邪魔になるため（PO フィードバック）。クリックで開く。
 */
function NoticeRow({ source, text }: { source: string; text: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  // 1行目を要約として出す。Markdownの強調記号は畳んだ状態では邪魔なので落とす
  const summary = (text.split("\n").find((l) => l.trim().length > 0) ?? "")
    .replace(/\*\*/g, "")
    .trim();

  return (
    <div className={`msg msg--notice ${open ? "is-open" : ""}`}>
      <button className="notice-head" onClick={() => setOpen(!open)} title="クリックで開閉">
        <span className="notice-tag">{NOTICE_LABELS[source] ?? source}</span>
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

/**
 * 番頭が考えている間の表示（PO要望 2026-07-31）。
 *
 * 送ったあと何も起きないように見えるのがいちばん不安なので、**言葉と動きの両方**で出す
 * （Claude・Gemini・ChatGPT も同じ形）。番頭が喋り始めたら消える——本文そのものが
 * 進んでいる証拠になるため、二重には出さない。
 */
function ThinkingRow(): React.ReactElement {
  return (
    <div className="msg msg--thinking" role="status" aria-live="polite">
      <span className="thinking-mark" />
      <span className="thinking-label">考えています</span>
      <span className="thinking-dots">
        <i />
        <i />
        <i />
      </span>
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
      // 外からの知らせ（決定29）。番頭の発話と混ざらないよう見た目を分け、出所も出す
      return <NoticeRow source={entry.source} text={entry.text} />;
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
  /** 履歴の面を見ているか。プロトタイプ三次改訂の「ピンタブ」に相当する */
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * 設定面（決定41・prototype の3面構成）。
   *
   * **キャンバスのタブではなく独立した面**。設定は Banto の一級の機能で、会話と同じ
   * ヘッダーの右端から開く。履歴面と同じ扱いで、同時にはどちらか一方しか出さない。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** チャット欄の幅。境界のドラッグで変えられる（PO要望 2026-07-31）。 */
  const [chatWidth, setChatWidth] = useState(readStoredChatWidth);
  const chatPaneRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 入力欄を中身の行数に合わせて伸ばす。**チャット欄の高さの1/3まで**（PO要望）——
  // それ以上は会話が見えなくなるので、中でスクロールさせる
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const limit = Math.max(
      MIN_COMPOSER_HEIGHT_PX,
      Math.round((chatPaneRef.current?.clientHeight ?? 0) / 3)
    );
    const wanted = el.scrollHeight;
    el.style.height = `${Math.min(wanted, limit)}px`;
    el.style.overflowY = wanted > limit ? "auto" : "hidden";
  }, [draft, chatWidth]);

  // 次に開いたときも同じ幅で始める。**状態から書く**——ドラッグの終わりに DOM を読むと、
  // React がまだ最後の1手を反映しておらず、記憶する幅が1手ぶんずれる（実測で見つけた）
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
    } catch {
      // ストレージが使えない環境でも幅の変更自体は効く
    }
  }, [chatWidth]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = chatPaneRef.current?.clientWidth ?? chatWidth;
    const onMove = (move: PointerEvent): void => {
      // チャットは右側にあるので、左へ動かすほど広くなる
      setChatWidth(clampChatWidth(startWidth - (move.clientX - startX)));
    };
    const onUp = (): void => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

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
  const settingsEndpoint = session.modules.find((m) => m.name === "settings")?.baseUrl;

  /**
   * モジュール名 → 到達先。GUI がまたぐとき（検証環境の画面が場所の一覧を要る等）に使う。
   * カタログが持っている情報をそのまま引くだけで、UI 側にURLを持たせない（決定25）。
   */
  const endpointOf = useCallback(
    (moduleName: string): string | undefined =>
      // GUI を持たないモジュール（設定など）はカタログに出ないので、モジュールの表を先に見る
      session.modules.find((m) => m.name === moduleName)?.baseUrl ??
      session.catalog.find((entry) => entry.module === moduleName)?.endpoint,
    [session.modules, session.catalog]
  );

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
        <ThreadTabs
          threads={session.threads}
          activeThreadId={session.activeThreadId}
          unreadThreadIds={session.unreadThreadIds}
          onSwitch={(id) => {
            session.switchThread(id);
            setHistoryOpen(false);
          }}
          onClose={session.closeThread}
          onOpen={() => {
            session.openThread();
            setHistoryOpen(false);
          }}
        />
        <button
          className={`pin-tab ${historyOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => {
            setHistoryOpen((v) => !v);
            setSettingsOpen(false);
          }}
          title="畳んだ会話の履歴"
          aria-label="履歴"
        >
          🕘
          {session.closedThreads.length > 0 && (
            <span className="pin-tab-count">{session.closedThreads.length}</span>
          )}
        </button>
        {/* 設定は一級の面（決定41）。会話タブの列とは混ざらないよう、右端に固定する */}
        <button
          className={`pin-tab ${settingsOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => {
            setSettingsOpen((v) => !v);
            setHistoryOpen(false);
          }}
          title="設定"
          aria-label="設定"
        >
          ⚙️
        </button>
        <span className={`conn conn--${session.status}`}>
          {session.status === "open"
            ? "接続中"
            : session.status === "connecting"
              ? "接続しています…"
              : session.status === "reconnecting"
                ? "繋ぎ直しています…"
                : "切断"}
        </span>
      </header>

      {settingsOpen ? (
        settingsEndpoint ? (
          <SettingsPanel
            params={{}}
            tabId="settings"
            kind="settings"
            module="settings"
            endpoint={settingsEndpoint}
            endpointOf={endpointOf}
          />
        ) : (
          <div className="threads-empty">
            <p className="threads-empty-title">設定を開けません</p>
            <p className="threads-empty-sub">
              設定モジュールが登録されていません（ホストの構成を確認してください）
            </p>
          </div>
        )
      ) : historyOpen ? (
        <ThreadHistory
          closedThreads={session.closedThreads}
          chatOf={session.chatOf}
          onReopen={(id) => {
            session.reopenThread(id);
            setHistoryOpen(false);
          }}
          onBack={() => setHistoryOpen(false)}
        />
      ) : !session.activeThreadId ? (
        /* 全部畳んだ空状態（どの会話も畳めるようにした帰結。プロトタイプにも空状態がある） */
        <div className="threads-empty">
          <p className="threads-empty-title">開いている会話はありません</p>
          <p className="threads-empty-sub">
            新しく始めるか、履歴から畳んだ会話を再開してください。
          </p>
          <div className="threads-empty-actions">
            <button className="btn btn--primary" onClick={() => session.openThread()}>
              ＋ 新しい会話を始める
            </button>
            {session.closedThreads.length > 0 && (
              <button className="btn" onClick={() => setHistoryOpen(true)}>
                🕘 履歴を見る（{session.closedThreads.length}）
              </button>
            )}
          </div>
        </div>
      ) : (
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
                endpointOf={endpointOf}
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

        {/* 境界のドラッグでチャット欄の幅を変える（PO要望 2026-07-31）。
            狭い画面では上下に積むので出さない（CSS 側で消す） */}
        <div
          className="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="チャット欄の幅を変える"
          onPointerDown={startResize}
          onDoubleClick={() => setChatWidth(CHAT_WIDTH_DEFAULT)}
          title="ドラッグで幅を変える（ダブルクリックで既定に戻す）"
        />

        <aside className="chat-pane" ref={chatPaneRef} style={{ width: chatWidth }}>
          <div className="chat-head">
            <div className="chat-head-main">
              <div className="chat-title">番頭と相談する</div>
              <div className="chat-sub">
                {session.tools.length > 0 ? `${session.tools.length} tools` : "—"}
                {session.sessionId ? ` · ${session.sessionId.slice(0, 8)}` : ""}
              </div>
            </div>
            <button
              title="いまの会話を畳んで新しく始めます（畳んだ会話は履歴に残ります）"
              className="btn btn--ghost btn--small"
              /* 確認を取らない：畳むだけで消えないので、取り返しがつく（PO要望 2026-07-31） */
              onClick={() => session.newSession()}
              disabled={session.chat.length === 0}
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
            {/* 番頭が喋り始めたら消す——本文そのものが進んでいる証拠になる */}
            {session.busy && session.chat[session.chat.length - 1]?.role !== "banto" && (
              <ThinkingRow />
            )}
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
              ref={inputRef}
              value={draft}
              placeholder={session.busy ? "番頭が考えています…" : "番頭に相談する"}
              rows={1}
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
      )}
    </div>
  );
}
