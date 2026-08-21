import { useEffect, useState } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';

import { useBantoState } from './hooks/useBantoState';
import { useThreadSessions } from './hooks/useThreadSessions';
import { advanceRuns, createThread, requestRun, resolveDecision } from './lib/api';
import { ThreadPicker } from './components/ThreadPicker';
import { ConversationPane } from './components/ConversationPane';
import { Queue } from './components/Queue';
import { Runs } from './components/Runs';
import { Tabs, TabsList, TabsTrigger } from './components/ui/tabs';

type MobilePane = 'conversation' | 'side';
/** 右側の面。**1画面に集める**（要件 A5）ので、増やすのではなく切り替える。 */
type SidePane = 'queue' | 'factory';

export function App() {
  const { data, error, loading, refetch } = useBantoState();
  const { sessionFor, send, loadHistory } = useThreadSessions();

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('conversation');
  const [sidePane, setSidePane] = useState<SidePane>('queue');

  const threads = data?.threads ?? [];
  const channels = data?.channels ?? [];
  const queue = data?.queue ?? [];
  const runs = data?.runs ?? [];

  // 何も選ばれていなければ、直近のスレッドを既定にする。
  useEffect(() => {
    if (selectedThreadId === null && threads.length > 0) {
      setSelectedThreadId(threads[threads.length - 1]?.id ?? null);
    }
  }, [selectedThreadId, threads]);

  // 選んだ会話の過去を読み直す（要件 A8）。**開き直しても会話が残る。**
  useEffect(() => {
    if (selectedThreadId !== null) void loadHistory(selectedThreadId);
  }, [selectedThreadId, loadHistory]);

  const selectedThread = threads.find((t) => t.id === selectedThreadId) ?? null;
  const session = selectedThreadId ? sessionFor(selectedThreadId) : sessionFor('__none__');

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
    if (selectedThreadId !== null) await loadHistory(selectedThreadId, true);
  };

  const handleCreate = async (args: { channelName: string; title: string }) => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createThread(args);
      await refetch();
      setSelectedThreadId(res.threadId);
      setMobilePane('conversation');
    } catch (cause) {
      // 握りつぶさない。作成に失敗したことを画面に出す（規則2）。
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const handleSend = (text: string) => {
    if (!selectedThreadId) {
      // 黙って捨てない（教訓13）。捨てると「送ったのに何も起きない」になり、
      // 何が悪いのか本人にも分からなくなる。
      setCreateError('会話が選ばれていません。「新しい会話」を押してから送ってください。');
      return;
    }
    void send(selectedThreadId, text, () => void refetch());
  };

  const handleOpenThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    setMobilePane('conversation');
  };

  const handleRequestRun = async (request: string) => {
    await requestRun({ request });
    await refetch();
  };

  const handleAdvance = async () => {
    await advanceRuns();
    await refetch();
    // 走ったぶんの会話が増えているので、開いている会話は読み直す。
    if (selectedThreadId !== null) await loadHistory(selectedThreadId, true);
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
          selectedThreadId={selectedThreadId}
          onSelect={(id) => {
            setSelectedThreadId(id);
            setMobilePane('conversation');
          }}
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
        <section className={`flex min-h-0 flex-col ${mobilePane === 'conversation' ? 'flex' : 'hidden md:flex'}`}>
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">読み込み中…</div>
          ) : (
            <ConversationPane thread={selectedThread} session={session} onSend={handleSend} />
          )}
        </section>

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
              </TabsList>
            </Tabs>
          </div>

          {sidePane === 'queue' ? (
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
