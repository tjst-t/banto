import { AlertTriangle, Loader2, PackageMinus } from 'lucide-react';

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
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="flex flex-col gap-2 p-4">
        {items.length === 0 && !running && (
          <p className="py-8 text-center text-sm text-ink-muted">
            メッセージを送るとここに会話が流れます。
          </p>
        )}

        {items.map((item) => {
          if (item.kind === 'user') {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg rounded-br-sm bg-accent px-3 py-2 text-sm text-white">
                  <p className="whitespace-pre-wrap">{item.text}</p>
                  <p className="mt-1 text-right text-[10px] text-white/70">{timeLabel(item.at)}</p>
                </div>
              </div>
            );
          }

          const { event } = item;

          if (event.type === 'run.step') {
            if (event.state === 'started') return null; // 下の running インジケータで表現する
            if (event.state === 'succeeded') {
              return (
                <div key={item.id} className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-surface px-3 py-2 text-sm text-ink">
                    <p className="whitespace-pre-wrap">{event.detail ?? '（応答なし）'}</p>
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

          if (event.type === 'thread.status') {
            const label = ThreadStatusLabel(event.status);
            return (
              <div key={item.id} className="flex justify-center py-1">
                <Badge tone={label.tone}>状態: {label.text}</Badge>
              </div>
            );
          }

          // event.type === 'error'（封筒を持たない、ランタイム例外の生の通知）
          return (
            <div key={item.id} className="flex items-start gap-2 rounded-md border border-critical/30 bg-critical-soft px-3 py-2 text-sm text-critical">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">エラー</p>
                <p className="text-xs">{event.detail}</p>
              </div>
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
