import { AlertTriangle, GitFork, GitMerge, ListChecks, Trash2 } from 'lucide-react';

import { PanelHeader } from './PanelHeader';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { ContextChart, type ContextPoint } from '../ContextChart';
import { MessageList } from '../MessageList';
import { Composer } from '../Composer';
import type { ThreadSession } from '../../hooks/useThreadSessions';
import type { ThreadSummary } from '../../lib/types';
import { displayStatus, type DisplayStatus } from '../../lib/threadOrder';

/** サイドバーの点と同じ判定を使う（`idle`）——同じ食い違いを2箇所で直さない（規則3）。 */
const STATUS_LABEL: Record<
  DisplayStatus,
  { text: string; tone: 'accent' | 'done' | 'stopped' | 'attention' | 'neutral' }
> = {
  working: { text: '作業中', tone: 'accent' },
  done: { text: '完了', tone: 'done' },
  blocked: { text: '停止', tone: 'stopped' },
  'waiting-on-human': { text: '判断待ち', tone: 'attention' },
  idle: { text: 'まだ何も無い', tone: 'neutral' },
};

/**
 * 会話1本ぶんのパネル（要件 A2・A3・A8）。
 *
 * **ルートのスレッドでもフォークでも同じコンポーネント**——見た目の違いは
 * 「戻る」の有無（`thread.forkedFrom` があるかどうか）だけで、2つに分ける理由が無い。
 *
 * `slim` は、作業パネルが横に開いていて帯に縮んでいるとき。
 * 中の余白を詰めるだけで、機構は変えない。
 */
export function ConversationPanel({
  thread,
  session,
  slim,
  onSend,
  onOpenReference,
  onAnswer,
  onFork,
  onMerge,
  onOpenBase,
  onDelete,
  onBack,
  parentTitle,
  elevated = false,
  onPanelClick,
}: {
  thread: ThreadSummary;
  session: ThreadSession;
  slim: boolean;
  onSend: (text: string) => void;
  onOpenReference: (uri: string, name: string) => void;
  onAnswer: (decisionId: string, answer: string, optionId?: string) => Promise<void>;
  onFork: () => void;
  /** フォークだけが持つ操作（PO裁定 2026-08-22）。ルートのスレッドには畳む先が無い。 */
  onMerge: () => void;
  onOpenBase: () => void;
  /** 決定30：ルートでもフォークでも削除できる。未マージの子フォークは自動でマージされる。 */
  onDelete: () => void;
  onBack?: (() => void) | undefined;
  /**
   * フォークの出所（`thread.forkedFrom`）が指す親の題。**スレッドとフォークが
   * 見分けにくい**という指摘（PO 2026-08-22）を受け、灰色の補足ではなく
   * 題の上に出す——プロトタイプの `.from`（「◂ 親 の幹から」）と同じ考え。
   */
  parentTitle?: string | undefined;
  /**
   * **フォークが幹の横に紙で重なる**（見本 `.room.branch` と同じ見た目、決定26）。
   * ルートと並べて出すときだけ立てる——帯（slim）のときは重ねる相手が無いので立てない。
   */
  elevated?: boolean;
  /**
   * 作業パネルが開いていて帯に縮んでいるとき、**この会話側をクリックすると
   * 作業パネルを閉じる**（PO指摘 2026-08-22）。ボタン・リンク・入力欄からの
   * クリックは素通りさせる——書きかけの返信やフォーク操作を巻き込まない。
   */
  onPanelClick?: ((event: React.MouseEvent) => void) | undefined;
}) {
  const points: ContextPoint[] = session.items
    .map((i) => i.event)
    .filter((e): e is Extract<typeof e, { type: 'turn.usage' }> => e.type === 'turn.usage')
    .map((e) => ({ turnIndex: e.turnIndex, queryId: e.queryId, usage: e.usage }));

  const status = STATUS_LABEL[displayStatus(thread.status, thread.turnCount)];

  return (
    <section
      data-conversation-panel={thread.id}
      onClick={onPanelClick}
      className={
        elevated
          ? 'relative z-[2] ml-[-10px] mt-2.5 flex min-h-0 min-w-0 flex-1 flex-col rounded-t-lg bg-paper-raised shadow-branch-cascade animate-slide-in'
          : 'flex min-h-0 min-w-0 flex-1 flex-col bg-paper'
      }
    >
      <PanelHeader
        title={thread.title}
        eyebrow={
          // **矢は戻るボタン側にある**（`onBack`）。ここで重ねて描かない。
          thread.forkedFrom !== null ? `${parentTitle ?? '元のスレッド'} から` : undefined
        }
        sub={
          thread.workspaceRoot === null
            ? `ターン ${thread.turnCount}`
            : `ターン ${thread.turnCount} ・ ${thread.workspaceRoot}`
        }
        onBack={onBack}
        actions={
          !slim ? (
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={status.tone}>{status.text}</Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={onOpenBase}
                title="決まったことを開く"
                data-open-base={thread.id}
              >
                <ListChecks className="h-3.5 w-3.5" />v{thread.baseVersion}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onFork}
                aria-label="ここからフォークする"
                title="ここからフォークする（決まったことを引き継ぐ）"
                data-fork={thread.id}
              >
                <GitFork className="h-3.5 w-3.5" />
              </Button>
              {thread.forkedFrom !== null && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onMerge}
                  aria-label="マージして閉じる"
                  title="決まったことを親に流し込んで、このフォークを閉じる"
                  data-merge={thread.id}
                >
                  <GitMerge className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={onDelete}
                aria-label="削除する"
                title="このスレッドを削除する（未マージのフォークは先に自動でマージされる）"
                data-delete={thread.id}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Badge tone={status.tone}>{status.text}</Badge>
          )
        }
      />

      {session.items.length === 0 && thread.turnCount > 0 && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md bg-caution-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--caution)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" />
          <p>
            このスレッドはすでに {thread.turnCount} ターン進んでいますが、host に会話ログを
            読み返す口が無いため、ここより前のやり取りは表示できません。この画面を開いてから
            のぶんだけが見えています。
          </p>
        </div>
      )}

      {!slim && (
        <div className="mx-auto w-full max-w-[var(--w-read)] shrink-0 border-b border-rule-faint px-5 py-1.5">
          <ContextChart points={points} />
        </div>
      )}

      {session.error !== null && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
          <p>ストリームが途中で切れました: {session.error}</p>
        </div>
      )}

      <MessageList
        items={session.items}
        running={session.running}
        onOpen={onOpenReference}
        onAnswer={onAnswer}
      />
      <Composer disabled={session.running} onSend={onSend} />
    </section>
  );
}
