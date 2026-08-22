import { useEffect, useState } from 'react';
import { Group as PanelGroup, Panel, Separator as PanelSeparator } from 'react-resizable-panels';

import { useBantoState } from './hooks/useBantoState';
import { useThreadSessions } from './hooks/useThreadSessions';
import { useNarrow } from './hooks/useNarrow';
import {
  createThread,
  forkThread as apiForkThread,
  mergeThread,
  resolveDecision,
} from './lib/api';
import { Sidebar, type OpenItem } from './components/Sidebar';
import { ConversationPanel } from './components/panels/ConversationPanel';
import { Spine } from './components/panels/Spine';
import { WorkPanel, type WorkTarget } from './components/panels/WorkPanel';
import { InboxDialog } from './components/dialogs/InboxDialog';
import { HistoryDialog } from './components/dialogs/HistoryDialog';
import { SettingsDialog } from './components/dialogs/SettingsDialog';
import { TooltipProvider } from './components/ui/tooltip';
import { Button } from './components/ui/button';
import type { ThreadSummary } from './lib/types';

type DialogKind = 'inbox' | 'history' | 'settings' | null;
/** 作業パネルを開いた元。会話が2本並んでいるとき、どちらを帯にするかを言う。 */
type RoomKind = 'root' | 'fork';

/**
 * 最上位。**サイドバー＋間の重なり**を組む（決定22・決定26）。
 *
 * **幹（ルートのスレッド）は常に居る。フォークは開いた元の横に並ぶ**
 * （見本 `13-tsuzukima-kai.html` の trunk/branch と同じ模型——規則12）。
 * 作業パネルが開くと、開いた側の会話だけが話しかけるための帯に縮み、
 * もう一方は消さずに背表紙（`Spine`）へ畳む——戻り道を残す。
 */
export function App() {
  const { data, error, loading, refetch } = useBantoState();
  const { sessionFor, send, loadHistory } = useThreadSessions();
  const narrow = useNarrow();

  const [rootThreadId, setRootThreadId] = useState<string | null>(null);
  const [forkThreadId, setForkThreadId] = useState<string | null>(null);
  const [work, setWork] = useState<WorkTarget | null>(null);
  /** 作業パネルを、幹側から開いたか、フォーク側から開いたか（見本の `workFrom`）。 */
  const [workOrigin, setWorkOrigin] = useState<RoomKind>('root');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const threads = data?.threads ?? [];
  const queue = data?.queue ?? [];

  /**
   * 何も開いていなければ、いちばん新しいスレッドを開く（決定23）。
   * それがフォークなら、その親を幹として一緒に開く（決定26）。
   */
  useEffect(() => {
    if (rootThreadId !== null && threads.some((t) => t.id === rootThreadId)) return;
    // 畳んだフォークは自動では開かない（PO裁定 2026-08-22）——開いているものからも外れているので。
    const openOnes = threads.filter((t) => t.mergedInto === null);
    const latest = openOnes[openOnes.length - 1] ?? threads[threads.length - 1];
    if (latest === undefined) {
      setRootThreadId(null);
      setForkThreadId(null);
      return;
    }
    if (latest.forkedFrom !== null) {
      setRootThreadId(latest.forkedFrom.threadId);
      setForkThreadId(latest.id);
    } else {
      setRootThreadId(latest.id);
      setForkThreadId(null);
    }
  }, [threads, rootThreadId]);

  // 開いている会話の過去を読み直す（要件 A8）。**開き直しても会話が残る。**
  useEffect(() => {
    if (rootThreadId !== null) void loadHistory(rootThreadId);
  }, [rootThreadId, loadHistory]);
  useEffect(() => {
    if (forkThreadId !== null) void loadHistory(forkThreadId);
  }, [forkThreadId, loadHistory]);

  const rootThread = threads.find((t) => t.id === rootThreadId) ?? null;
  const forkThread = forkThreadId !== null ? (threads.find((t) => t.id === forkThreadId) ?? null) : null;
  const rootSession = rootThreadId !== null ? sessionFor(rootThreadId) : null;
  const forkSession = forkThreadId !== null ? sessionFor(forkThreadId) : null;

  /** どのスレッドを開いても、その親（フォークなら）まで一緒に立てて開く。 */
  const openThread = (threadId: string): void => {
    const t = threads.find((x) => x.id === threadId);
    if (t === undefined) return;
    if (t.forkedFrom !== null) {
      setRootThreadId(t.forkedFrom.threadId);
      setForkThreadId(t.id);
    } else {
      setRootThreadId(t.id);
      setForkThreadId(null);
    }
    setWork(null);
  };

  const handleSend = (threadId: string, text: string): void => {
    void send(threadId, text, () => void refetch());
  };

  /**
   * 判断に答える（要件 A6）。**失敗を握りつぶさない**——断られたら
   * 例外のまま呼び手（会話・受信箱）に返す（規則2）。
   */
  const answerDecision = async (
    decisionId: string,
    answer: string,
    optionId: string | undefined,
    forThreadId: string | null,
  ): Promise<void> => {
    await resolveDecision({ decisionId, answer, ...(optionId === undefined ? {} : { optionId }) });
    await refetch();
    if (forThreadId !== null) await loadHistory(forThreadId, true);
  };

  /**
   * **`openThread` を使わない。** `refetch()` の直後は、この関数が閉じ込めた
   * `threads` がまだ古いまま——できたばかりの新しいスレッドがそこに無いので、
   * `openThread` の中の `find` が `undefined` を返し、何も起きない（実測
   * 2026-08-22）。新しいスレッドの素性（親が誰か）はここで API の返答から
   * 直接分かっているので、`threads` の再取得を待たずに状態を組み立てる。
   */
  const handleFork = async (fromThreadId: string): Promise<void> => {
    try {
      const res = await apiForkThread({ fromThreadId });
      await refetch();
      // 幹からでもフォークからでも、開いていた幹（rootThreadId）は変わらない。
      setForkThreadId(res.threadId);
      setWork(null);
    } catch (cause) {
      // 握りつぶさない（規則2）。切れなかったことを画面に出す。
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /**
   * フォークを閉じて親に畳む（PO裁定 2026-08-22）。**削除ではない**——一覧から
   * 外れるだけで、スレッド自体は残る。閉じたら親（幹）だけの表示に戻る。
   */
  const handleMerge = async (threadId: string): Promise<void> => {
    try {
      await mergeThread({ threadId });
      await refetch();
      // 畳んだフォークの親は、常にいま開いている幹（rootThreadId）——別の
      // 幹のフォークを畳むボタンは、そもそもこの幹の下にしか出ていない。
      setForkThreadId(null);
      setWork(null);
    } catch (cause) {
      // 握りつぶさない（規則2）。親の base が上限で断られた場合もここに来る。
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleCreate = async (): Promise<void> => {
    try {
      const res = await createThread({ title: '新しい会話' });
      await refetch();
      // 新しいスレッドは常にルート（親を持たない）。
      setRootThreadId(res.threadId);
      setForkThreadId(null);
      setWork(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /**
   * 作業パネルを開く。**どちら側の会話から開いたかで、もう一方の扱いが変わる**
   * （見本の `workFrom`）——幹から開いたなら、開いていたフォークは表示から外れる
   * （畳まれるわけではない。ただ表示の主役から外れるだけ）。フォークから開いたなら
   * 幹は背表紙に畳まれ、フォークは残って帯になる。
   */
  const openWork = (target: WorkTarget, origin: RoomKind): void => {
    if (origin === 'root') setForkThreadId(null);
    setWorkOrigin(origin);
    setWork(target);
  };

  const handleOpenReference = (uri: string, name: string, origin: RoomKind): void => {
    openWork({ kind: 'resource', uri, name }, origin);
  };

  const handleOpenBase = (thread: ThreadSummary, origin: RoomKind): void => {
    openWork({ kind: 'base', threadId: thread.id, threadTitle: thread.title }, origin);
  };

  const closeWork = (): void => setWork(null);

  /** 背表紙を押す・ESC：作業パネルとフォークを両方閉じて、幹だけの表示に戻る（見本の `data-spine`）。 */
  const returnToRoot = (): void => {
    setWork(null);
    setForkThreadId(null);
  };

  // ESC で作業パネルを閉じる（PO指摘 2026-08-22）。見本の cascade と同じ優先度—
  // まず作業パネル、無ければここでは何もしない（フォークを畳む操作は明示のボタンに残す）。
  useEffect(() => {
    if (work === null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeWork();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [work]);

  // **開いているもの**の点。フォークは、いま開いている幹に属するものだけに絞る
  // （PO指摘 2026-08-22）——見本の `mine()` が現在のプロジェクトで絞るのと同じ考え。
  // ルートのスレッドは絞らない（レールの `pj` に相当し、常に全部出す）。
  const openItems: OpenItem[] = threads
    .filter((t) => t.mergedInto === null)
    .filter((t) => t.forkedFrom === null || t.forkedFrom.threadId === rootThreadId)
    .map((t) => ({
      key: t.id,
      title: t.title,
      meta: `ターン ${t.turnCount}`,
      status: t.status,
      turnCount: t.turnCount,
      active: t.id === rootThreadId || t.id === forkThreadId,
      // **スレッドとフォークを見分けられるように**（PO裁定 2026-08-22）。
      isFork: t.forkedFrom !== null,
      onOpen: () => openThread(t.id),
    }));

  const slimClickGuard = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement;
    // ボタン・リンク・入力欄からのクリックは素通りさせる（PO指摘 2026-08-22）。
    if (target.closest('button, a, input, textarea, [role="button"]')) return;
    closeWork();
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh flex-col bg-paper max-md:flex-col md:flex-row">
        <Sidebar
          openItems={openItems}
          queueCount={queue.length}
          onOpenInbox={() => setDialog('inbox')}
          onOpenHistory={() => setDialog('history')}
          onOpenSettings={() => setDialog('settings')}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error !== null && (
            <Banner onRetry={() => void refetch()}>状態の取得に失敗しています: {error}</Banner>
          )}
          {actionError !== null && (
            <Banner onRetry={() => setActionError(null)}>{actionError}</Banner>
          )}

          {loading && rootThread === null ? (
            <div className="flex flex-1 items-center justify-center text-md text-ink-muted">
              読み込み中…
            </div>
          ) : rootThread === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-md text-ink-muted">
              <p>まだ会話がありません。</p>
              <Button variant="accent" onClick={() => void handleCreate()}>
                新しい会話をはじめる
              </Button>
            </div>
          ) : narrow ? (
            // **狭い画面では、いちばん手前のものだけを丸ごと表示する**（要件 E2・E3）。
            // 横に並べる／重ねる余白が無いので、手前から順に丸ごと入れ替える。
            work !== null ? (
              <WorkPanel work={work} onClose={closeWork} onBaseChanged={() => void refetch()} />
            ) : forkThread !== null && forkSession !== null ? (
              <ConversationPanel
                thread={forkThread}
                session={forkSession}
                slim={false}
                onSend={(text) => handleSend(forkThread.id, text)}
                onOpenReference={(uri, name) => handleOpenReference(uri, name, 'fork')}
                onAnswer={(id, a, o) => answerDecision(id, a, o, forkThread.id)}
                onFork={() => void handleFork(forkThread.id)}
                onMerge={() => void handleMerge(forkThread.id)}
                onOpenBase={() => handleOpenBase(forkThread, 'fork')}
                onBack={() => setForkThreadId(null)}
                parentTitle={rootThread.title}
              />
            ) : (
              <ConversationPanel
                thread={rootThread}
                session={rootSession!}
                slim={false}
                onSend={(text) => handleSend(rootThread.id, text)}
                onOpenReference={(uri, name) => handleOpenReference(uri, name, 'root')}
                onAnswer={(id, a, o) => answerDecision(id, a, o, rootThread.id)}
                onFork={() => void handleFork(rootThread.id)}
                onMerge={() => void handleMerge(rootThread.id)}
                onOpenBase={() => handleOpenBase(rootThread, 'root')}
              />
            )
          ) : work !== null ? (
            // **作業パネルが開くと、開いた側の会話だけが帯に縮む。**
            // もう一方（幹）は消さず、背表紙に畳む——戻り道が見えている（見本 `.spine`）。
            //
            // `PanelGroup`/`Panel` は既定で `overflow: hidden`/`auto` を強制するが、
            // `style` prop は消費側のものが後から展開されるので上書きできる
            // （実測 2026-08-22、`className` では不可）。
            <div className="flex min-h-0 flex-1">
              {workOrigin === 'fork' && (
                <Spine label={rootThread.title} letter={rootThread.title.slice(0, 1)} onClick={returnToRoot} />
              )}
              <PanelGroup orientation="horizontal" className="min-h-0 flex-1" style={{ overflow: 'visible' }}>
                <Panel defaultSize="26" minSize="18" maxSize="45" className="flex min-h-0">
                  {workOrigin === 'fork' && forkThread !== null && forkSession !== null ? (
                    <ConversationPanel
                      thread={forkThread}
                      session={forkSession}
                      slim
                      onSend={(text) => handleSend(forkThread.id, text)}
                      onOpenReference={(uri, name) => handleOpenReference(uri, name, 'fork')}
                      onAnswer={(id, a, o) => answerDecision(id, a, o, forkThread.id)}
                      onFork={() => void handleFork(forkThread.id)}
                      onMerge={() => void handleMerge(forkThread.id)}
                      onOpenBase={() => handleOpenBase(forkThread, 'fork')}
                      onBack={() => setForkThreadId(null)}
                      parentTitle={rootThread.title}
                      onPanelClick={slimClickGuard}
                    />
                  ) : (
                    <ConversationPanel
                      thread={rootThread}
                      session={rootSession!}
                      slim
                      onSend={(text) => handleSend(rootThread.id, text)}
                      onOpenReference={(uri, name) => handleOpenReference(uri, name, 'root')}
                      onAnswer={(id, a, o) => answerDecision(id, a, o, rootThread.id)}
                      onFork={() => void handleFork(rootThread.id)}
                      onMerge={() => void handleMerge(rootThread.id)}
                      onOpenBase={() => handleOpenBase(rootThread, 'root')}
                      onPanelClick={slimClickGuard}
                    />
                  )}
                </Panel>
                <PanelSeparator className="w-1.5 bg-transparent transition-colors hover:bg-accent/30 data-[state=drag]:bg-accent/40" />
                <Panel minSize="40" className="flex min-h-0" style={{ overflow: 'visible' }}>
                  <WorkPanel
                    work={work}
                    onClose={closeWork}
                    onBaseChanged={() => void refetch()}
                    sideNote="会話は左に残しています"
                  />
                </Panel>
              </PanelGroup>
            </div>
          ) : (
            // **幹は常に居る。フォークが開いていれば、その横に紙が1枚重なる**
            // （見本の trunk/branch——規則12）。素の flex 行なので、フォークの
            // 影・負のマージンがそのまま隣の幹の上に落ちる。
            <div className="flex min-h-0 flex-1">
              <ConversationPanel
                thread={rootThread}
                session={rootSession!}
                slim={false}
                onSend={(text) => handleSend(rootThread.id, text)}
                onOpenReference={(uri, name) => handleOpenReference(uri, name, 'root')}
                onAnswer={(id, a, o) => answerDecision(id, a, o, rootThread.id)}
                onFork={() => void handleFork(rootThread.id)}
                onMerge={() => void handleMerge(rootThread.id)}
                onOpenBase={() => handleOpenBase(rootThread, 'root')}
              />
              {forkThread !== null && forkSession !== null && (
                <ConversationPanel
                  thread={forkThread}
                  session={forkSession}
                  slim={false}
                  elevated
                  onSend={(text) => handleSend(forkThread.id, text)}
                  onOpenReference={(uri, name) => handleOpenReference(uri, name, 'fork')}
                  onAnswer={(id, a, o) => answerDecision(id, a, o, forkThread.id)}
                  onFork={() => void handleFork(forkThread.id)}
                  onMerge={() => void handleMerge(forkThread.id)}
                  onOpenBase={() => handleOpenBase(forkThread, 'fork')}
                  onBack={() => setForkThreadId(null)}
                  parentTitle={rootThread.title}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <InboxDialog
        open={dialog === 'inbox'}
        onOpenChange={(open) => setDialog(open ? 'inbox' : null)}
        queue={queue}
        threads={threads}
        onAnswer={(id, a, o) => {
          const forThread = queue.find((d) => d.decisionId === id)?.threadId ?? null;
          return answerDecision(id, a, o, forThread);
        }}
        onOpenThread={openThread}
      />
      <HistoryDialog
        open={dialog === 'history'}
        onOpenChange={(open) => setDialog(open ? 'history' : null)}
        threads={threads}
        onOpenThread={openThread}
      />
      <SettingsDialog
        open={dialog === 'settings'}
        onOpenChange={(open) => setDialog(open ? 'settings' : null)}
        onOpenResource={(uri, name) => handleOpenReference(uri, name, 'root')}
      />
    </TooltipProvider>
  );
}

/**
 * 上段に出す不具合。**止まったものは紫**——朱は「あなたの番」に取ってある。
 */
function Banner({
  children,
  onRetry,
}: {
  children: React.ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 bg-stopped-soft px-4 py-2 text-sm text-ink shadow-[inset_3px_0_0_var(--stopped)]">
      {children}
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry} className="ml-auto underline">
          閉じる
        </button>
      )}
    </div>
  );
}
