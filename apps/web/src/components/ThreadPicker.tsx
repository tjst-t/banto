import { useState } from 'react';
import { Plus } from 'lucide-react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Button } from './ui/button';
import type { ChannelSummary, ThreadSummary } from '../lib/types';

export function ThreadPicker({
  threads,
  channels,
  openThreadIds,
  onSelect,
  onCreate,
  creating,
}: {
  threads: ThreadSummary[];
  channels: ChannelSummary[];
  /** いま開いている会話。**選ぶのではなく開く**ので、1本に限らない（要件 A2）。 */
  openThreadIds: readonly string[];
  onSelect: (threadId: string) => void;
  onCreate: (args: { channelName: string; title: string }) => void;
  creating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [channelName, setChannelName] = useState('banto-v3');
  const [title, setTitle] = useState('');

  const channelNameOf = (id: string): string => channels.find((c) => c.id === id)?.name ?? id;

  const submit = () => {
    onCreate({ channelName: channelName.trim() || 'banto-v3', title: title.trim() || '新しい会話' });
    setTitle('');
    setOpen(false);
  };

  return (
    <div className="relative flex items-center gap-2">
      {threads.length > 0 && (
        <Select value="" onValueChange={onSelect}>
          <SelectTrigger className="w-32 sm:w-56">
            {/* **開いた数を出す。** 「いま何本並べているか」が見えないと、
                開いたつもりで開いていないのに気づけない。 */}
            <SelectValue
              placeholder={openThreadIds.length === 0 ? '会話を開く' : `会話を開く（${openThreadIds.length}本）`}
            />
          </SelectTrigger>
          <SelectContent>
            {threads.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {openThreadIds.includes(t.id) ? '● ' : ''}
                {channelNameOf(t.channelId)} / {t.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
        <Plus className="h-3.5 w-3.5" />
        新しい会話
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-md border border-border bg-surface p-3 shadow-lg">
          <label className="mb-2 block text-xs text-ink-secondary">
            プロジェクト名
            <input
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              className="mt-1 w-full rounded border border-border px-2 py-1 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="mb-3 block text-xs text-ink-secondary">
            タイトル
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="新しい会話"
              className="mt-1 w-full rounded border border-border px-2 py-1 text-sm outline-none focus:border-accent"
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              やめる
            </Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={creating}>
              作成
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
