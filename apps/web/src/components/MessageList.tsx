import { AlertTriangle, GitFork, HelpCircle, Loader2, PackageMinus } from 'lucide-react';

import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import type { TimelineItem } from '../hooks/useThreadSessions';
import { contextSize } from '../lib/types';

const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function ThreadStatusLabel(status: string): { text: string; tone: 'accent' | 'good' | 'critical' | 'waiting' | 'neutral' } {
  switch (status) {
    case 'working':
      return { text: '作業中', tone: 'accent' };
    case 'done':
      return { text: '完了', tone: 'good' };
    case 'blocked':
      return { text: '停止', tone: 'critical' };
    case 'waiting-on-human':
      return { text: '判断待ち', tone: 'waiting' };
    default:
      return { text: status, tone: 'neutral' };
  }
}

export function MessageList({ items, running }: { items: TimelineItem[]; running: boolean }) {
  /**
   * 文面が記録されている問い合わせの集合（要件 A8）。
   *
   * `message.recorded` を入れる前の会話では、相手の文面は `query.step` の `detail` に
   * しか無い。出さないと**過去の会話が読めなくなる**ので、そのときはそちらから読む。
   *
   * **判定は「会話ごと」ではなく「問い合わせごと」。** 会話ごとにすると、
   * **古い形と新しい形が混ざった会話で、古いほうが丸ごと消える**
   * ——実際に消えた（自分で画面を見て気づいた）。同じ会話の中で形が変わりうる以上、
   * 判定の単位も同じ細かさでないと合わない。
   */
  const recordedQueries = new Set(
    items.flatMap((i) => (i.event.type === 'message.recorded' ? [i.event.queryId] : [])),
  );

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="flex flex-col gap-2 p-4">
        {items.length === 0 && !running && (
          <p className="py-8 text-center text-sm text-ink-muted">
            メッセージを送るとここに会話が流れます。
          </p>
        )}

        {items.map((item) => {
          const { event } = item;

          // 文面は message.recorded が持つ（要件 A8）。**ログに在るので開き直しても残る。**
          if (event.type === 'message.recorded') {
            const mine = event.role === 'user';
            return (
              <div key={item.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={
                    mine
                      ? 'max-w-[80%] rounded-lg rounded-br-sm bg-accent px-3 py-2 text-sm text-white'
                      : 'max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-surface px-3 py-2 text-sm text-ink'
                  }
                >
                  <p className="whitespace-pre-wrap">{event.text}</p>
                  <p className={`mt-1 text-[10px] ${mine ? 'text-right text-white/70' : 'text-ink-muted'}`}>
                    {timeLabel(event.at)}
                  </p>
                </div>
              </div>
            );
          }

          if (event.type === 'query.step') {
            if (event.status === 'started') return null; // 下の running インジケータで表現する
            if (event.status === 'succeeded') {
              // その問い合わせの文面が記録済みなら出さない（同じものが2箇所に並ぶ）。
              if (recordedQueries.has(event.queryId) || !event.detail) return null;
              return (
                <div key={item.id} className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-surface px-3 py-2 text-sm text-ink">
                    <p className="whitespace-pre-wrap">{event.detail}</p>
                    <p className="mt-1 text-[10px] text-ink-muted">{timeLabel(event.at)}</p>
                  </div>
                </div>
              );
            }
            return (
              <div key={item.id} className="flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">実行に失敗しました</p>
                  <p className="text-xs">{event.detail}</p>
                </div>
              </div>
            );
          }

          if (event.type === 'turn.usage') {
            // ツール呼び出しの中身（何を呼んだか）は host のイベントに載っていないので
            // 出せない——見えるのは「1ターン進み、usage がこれだけ記録された」ことだけ。
            return (
              <div key={item.id} className="flex items-center gap-1.5 self-start text-[11px] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
                ターン境界 ・ {contextSize(event.usage).toLocaleString('ja-JP')} トークン
              </div>
            );
          }

          if (event.type === 'compaction.reported') {
            return (
              <div key={item.id} className="flex items-start gap-2 rounded-md border border-waiting/30 bg-waiting-soft px-3 py-2 text-xs text-waiting">
                <PackageMinus className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">圧縮が発火しました</p>
                  <p>{event.detail}</p>
                </div>
              </div>
            );
          }

          /**
           * スレッドの状態は**見出しに出ている**ので、ここには出さない。
           *
           * 1往復ごとに「作業中」「完了」が積まれるため、出すと**会話より状態の札の
           * ほうが多くなる**（自分で画面を見て気づいた）。同じことを2箇所に置かない（規則3）。
           */
          if (event.type === 'thread.status') return null;

          // 会話の見た目には効かない記録。**出さないが、エラーでもない。**
          if (event.type === 'thread.session' || event.type === 'thread.created') return null;
          // 依頼の文面は base に入っているので、ここでは二重に出さない。
          if (event.type === 'run.requested') return null;

          // 「決まったこと」への追記（要件 R2・R6）。**静かに増えるものを見えるようにする。**
          if (event.type === 'base.appended') {
            return (
              <div key={item.id} className="flex items-center gap-1.5 self-start text-[11px] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-accent/50" />
                決まったことに追記（第 {event.baseVersion} 版）・{event.text.length} 文字
              </div>
            );
          }

          if (event.type === 'run.tested') {
            return (
              <div key={item.id} className="flex items-center gap-1.5 self-start text-[11px] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
                テスト {event.passed ? '通過' : '失敗'} ・{' '}
                <span className="font-mono">{event.commit.slice(0, 7)}</span>
              </div>
            );
          }

          if (event.type === 'run.failed') {
            return (
              <div key={item.id} className="flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-xs text-critical">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  <p className="font-medium">{event.stage} で止まりました（人の判断待ち）</p>
                  <p>{event.detail}</p>
                </div>
              </div>
            );
          }

          // **どこから分かれたかは、会話の最初に要る情報**（要件 A3・R4）。
          // 継承した決まりごとは「決まったこと」の面に出るが、
          // 分かれた事実そのものは年表にしか置き場が無い。
          if (event.type === 'thread.forked') {
            return (
              <div key={item.id} className="flex items-center gap-1.5 self-start text-[11px] text-ink-muted">
                <GitFork className="h-3 w-3" />
                {event.mode === 'base' ? '決まったこと' : 'いまの続き'}から分岐（base v
                {event.from.baseVersion} まで引き継ぎ）
              </div>
            );
          }

          // 判断は列（Queue）で答えるが、**会話にも跡を残す**——
          // どこで話が止まったのかが、会話を読み返すだけで分かるように（要件 A8）。
          if (event.type === 'decision.requested') {
            return (
              <div
                key={item.id}
                className="flex items-start gap-2 self-start rounded-md border border-waiting/40 bg-waiting-soft/60 px-3 py-2 text-xs text-ink"
              >
                <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-waiting" />
                <div>
                  <p className="font-medium">判断待ち</p>
                  <p>{event.question}</p>
                </div>
              </div>
            );
          }

          if (event.type === 'decision.resolved') {
            return (
              <div key={item.id} className="flex items-center gap-1.5 self-start text-[11px] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
                判断に答えた{event.optionId === null ? '' : `（${event.optionId}）`}
              </div>
            );
          }

          if (event.type === 'error') {
            return (
              <div key={item.id} className="flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">エラー</p>
                  <p className="text-xs">{event.detail}</p>
                </div>
              </div>
            );
          }

          /**
           * **知らないイベントを「エラー」と言わない。**
           *
           * ここは以前、当たらなかったもの全部をエラー枠に落としていた。
           * サーバを新しくして `run.step` が `query.step` になった日、
           * **画面が真っ赤になり、しかも理由が「エラー」としか出なかった**——
           * 何が起きているのか画面から分からない、いちばん困る形である（規則2）。
           *
           * 知らないものは**知らないと言う。** 型を出しておけば、次に見た人が辿れる。
           */
          return (
            <div key={item.id} className="self-start text-[11px] text-ink-muted">
              未対応のイベント: <span className="font-mono">{(event as { type: string }).type}</span>
            </div>
          );
        })}

        {running && (
          <div className="flex items-center gap-2 self-start rounded-md px-3 py-2 text-sm text-ink-secondary">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            実行中…
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
