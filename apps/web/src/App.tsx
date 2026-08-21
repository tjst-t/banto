import { useEffect, useState, type CSSProperties } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';

import { useBantoState } from './hooks/useBantoState';
import { useThreadSessions } from './hooks/useThreadSessions';
import { advanceRuns, createThread, forkThread, requestRun, resolveDecision } from './lib/api';
import { ThreadPicker } from './components/ThreadPicker';
import { ThreadColumn } from './components/ThreadColumn';
import { Queue } from './components/Queue';
import { Runs } from './components/Runs';
import { SettingsPanel } from './components/SettingsPanel';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';

type MobilePane = 'conversation' | 'side';
/** 右側の面。**1画面に集める**（要件 A5）ので、増やすのではなく切り替える。 */
type SidePane = 'queue' | 'factory' | 'settings';

/**
 * 横に並べる会話の上限。**画面の幅の話であって、機構の制限ではない。**
 * これ以上開こうとしたら、いちばん古いものを閉じて場所を空ける。
 */
const MAX_OPEN = 3;

export function App() {
  const { data, error, loading, refetch } = useBantoState();
  const { sessionFor, send, loadHistory } = useThreadSessions();

  /**
   * **開いている会話**（要件 A2・A3）。1本ではなく並び。
   *
   * 1本しか開けない画面では、**同時に走っている複数の試みを見比べられない**
   * ——A2 も A3 も「並んでいるものを見る」ことが要点なので、
   * 切り替え式では満たせない。狭い画面では順に並ぶ（要件 E2・E3）。
   */
  const [openThreadIds, setOpenThreadIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('conversation');
  const [sidePane, setSidePane] = useState<SidePane>('queue');

  const threads = data?.threads ?? [];
  const channels = data?.channels ?? [];
  const queue = data?.queue ?? [];
  const runs = data?.runs ?? [];

  // 何も開いていなければ、直近の会話を1本だけ開く。
  useEffect(() => {
    if (openThreadIds.length === 0 && threads.length > 0) {
      const latest = threads[threads.length - 1]?.id;
      if (latest !== undefined) setOpenThreadIds([latest]);
    }
  }, [openThreadIds.length, threads]);

  // 開いた会話の過去を読み直す（要件 A8）。**開き直しても会話が残る。**
  useEffect(() => {
    for (const id of openThreadIds) void loadHistory(id);
  }, [openThreadIds, loadHistory]);

  /** 消えた会話（別の窓で消された等）を開いたままにしない。 */
  const openThreads = openThreadIds
    .map((id) => threads.find((t) => t.id === id))
    .filter((t): t is (typeof threads)[number] => t !== undefined);

  const openThread = (threadId: string) => {
    setOpenThreadIds((prev) => {
      if (prev.includes(threadId)) return [threadId, ...prev.filter((id) => id !== threadId)];
      // **場所が無ければ、いちばん古いものを閉じる。** 黙って開かないのは避ける。
      return [threadId, ...prev].slice(0, MAX_OPEN);
    });
    setMobilePane('conversation');
  };

  /**
   * 判断に答える（要件 A6）。**失敗を握りつぶさない**——断られたら
   * 例外のまま Queue に返して、その場に出す（規則2）。
   *
   * 答えは会話にも返るので、開いている会話を読み直す。
   */
  const handleAnswer = async (decisionId: string, answer: string, optionId?: string) => {
    await resolveDecision({ decisionId, answer, ...(optionId === undefined ? {} : { optionId }) });
    await refetch();
    // **force で読み直す。** 既読の会話は取り直さない作りなので、
    // ここを省くと「答えたのに会話に何も出ない」になる。
    // **開いている全部**——答えが返る先は、いま見ている1本とは限らない。
    for (const id of openThreadIds) await loadHistory(id, true);
  };

  /**
   * ここから分岐する（要件 A3）。**新しい枝を開いて並べる**——
   * 分岐は「並べて見比べる」ためのものなので、切って隠すのでは意味がない。
   */
  const handleFork = async (fromThreadId: string) => {
    try {
      const res = await forkThread({ fromThreadId });
      await refetch();
      openThread(res.threadId);
    } catch (cause) {
      // 握りつぶさない（規則2）。切れなかったことを画面に出す。
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleCreate = async (args: { channelName: string; title: string }) => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createThread(args);
      await refetch();
      openThread(res.threadId);
    } catch (cause) {
      // 握りつぶさない。作成に失敗したことを画面に出す（規則2）。
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  /** **どの会話に送るかを取り違えない。** 送り先は列そのものが決める。 */
  const handleSend = (threadId: string, text: string) => {
    void send(threadId, text, () => void refetch());
  };

  const handleOpenThread = (threadId: string) => {
    openThread(threadId);
  };

  const handleRequestRun = async (request: string) => {
    await requestRun({ request });
    await refetch();
  };

  const handleAdvance = async () => {
    await advanceRuns();
    await refetch();
    // 走ったぶんの会話が増えているので、開いている会話は読み直す。
    for (const id of openThreadIds) await loadHistory(id, true);
  };

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="relative flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tracking-tight text-ink">banto</span>
          <span
            className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              error ? 'bg-critical-soft text-critical' : 'bg-good-soft text-good'
            }`}
            title={error ?? '/api/state を取得できています'}
          >
            <Radio className="h-2.5 w-2.5" />
            {error ? '未接続' : 'live'}
          </span>
        </div>
        <ThreadPicker
          threads={threads}
          channels={channels}
          openThreadIds={openThreadIds}
          onSelect={openThread}
          onCreate={handleCreate}
          creating={creating}
        />
      </header>

      {error && (
        <div className="flex items-center gap-2 border-b border-critical/30 bg-critical-soft px-4 py-2 text-xs text-critical">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          状態の取得に失敗しています: {error}
          <button type="button" onClick={() => void refetch()} className="ml-auto underline">
            再試行
          </button>
        </div>
      )}
      {createError && (
        <div className="flex items-center gap-2 border-b border-critical/30 bg-critical-soft px-4 py-2 text-xs text-critical">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          会話の作成に失敗しました: {createError}
        </div>
      )}

      <div className="flex items-center justify-center border-b border-border bg-surface px-3 py-2 md:hidden">
        <Tabs value={mobilePane} onValueChange={(v) => setMobilePane(v as MobilePane)}>
          <TabsList>
            <TabsTrigger value="conversation">会話</TabsTrigger>
            <TabsTrigger value="side">
              待ち／Factory {queue.length > 0 ? `(${queue.length})` : ''}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_340px]">
        <div
          className={`grid min-h-0 grid-cols-1 md:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))] ${
            mobilePane === 'conversation' ? 'grid' : 'hidden md:grid'
          }`}
          /**
           * **開いた数だけ列を作る**（要件 A2・A3・E3）。
           *
           * **狭い画面では横に並べない**（要件 E2）。数を inline style で書くと
           * 画面幅に関わらず効いてしまい、スマートフォンで3列に潰れる。
           * だから数はカスタムプロパティで渡し、**適用するかどうかは CSS に決めさせる**
           * ——広い画面では横に、狭い画面では縦に並ぶ。
           */
          style={{ '--cols': Math.max(1, openThreads.length) } as CSSProperties}
        >
          {loading && openThreads.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">読み込み中…</div>
          ) : openThreads.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-ink-muted">
              右上の「新しい会話」で会話を始めてください。
            </div>
          ) : (
            openThreads.map((thread) => (
              <ThreadColumn
                key={thread.id}
                thread={thread}
                session={sessionFor(thread.id)}
                onSend={(text) => handleSend(thread.id, text)}
                onClose={() => setOpenThreadIds((prev) => prev.filter((id) => id !== thread.id))}
                onBaseChanged={() => void refetch()}
                onFork={() => void handleFork(thread.id)}
                closable={openThreads.length > 1}
              />
            ))
          )}
        </div>

        <aside
          className={`flex min-h-0 flex-col border-border md:border-l ${
            mobilePane === 'side' ? 'flex' : 'hidden md:flex'
          }`}
        >
          <div className="border-b border-border px-3 py-2.5">
            <Tabs value={sidePane} onValueChange={(v) => setSidePane(v as SidePane)}>
              <TabsList>
                <TabsTrigger value="queue">
                  待っているもの {queue.length > 0 ? `(${queue.length})` : ''}
                </TabsTrigger>
                <TabsTrigger value="factory">
                  Factory {runs.length > 0 ? `(${runs.length})` : ''}
                </TabsTrigger>
                <TabsTrigger value="settings">設定</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {sidePane === 'settings' ? (
            <SettingsPanel />
          ) : sidePane === 'queue' ? (
            <>
              <p className="border-b border-border px-4 py-2 text-[11px] text-ink-muted">
                出所を問わず1つの列にしてある（要件 A6）
              </p>
              <Queue
                queue={queue}
                threads={threads}
                onOpenThread={handleOpenThread}
                onAnswer={handleAnswer}
              />
            </>
          ) : (
            <Runs
              runs={runs}
              onRequest={handleRequestRun}
              onAdvance={handleAdvance}
              onOpenThread={handleOpenThread}
            />
          )}
        </aside>
      </main>
    </div>
  );
}
