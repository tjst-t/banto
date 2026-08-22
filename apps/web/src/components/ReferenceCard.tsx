import { ExternalLink } from 'lucide-react';

import type { ReferenceRecorded } from '../lib/types';

/**
 * **AI が「これを見て」と指したもの**（要件 C14・決定19）。
 *
 * 「パネルを開く」カード——**押すまで開かない。** 指しは会話に並ぶだけで、
 * 開くのは人が決める（要件 A7 の「発生では鳴らさない」と同じ考え）。
 *
 * 中身はここに持たない。開くときに持ち主のモジュールへ読みに行く（規則3）。
 */
export function ReferenceCard({
  event,
  onOpen,
}: {
  event: Pick<ReferenceRecorded, 'uri' | 'name' | 'note'>;
  onOpen: (uri: string, name: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(event.uri, event.name)}
      data-reference={event.uri}
      className="ml-8 flex max-w-[85%] items-start gap-2 self-start rounded-md bg-paper-raised px-3 py-2 text-left text-sm text-ink shadow-rest transition-colors hover:text-accent"
    >
      <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="block font-medium">{event.name}</span>
        {event.note !== null && <span className="block text-ink-secondary">{event.note}</span>}
        <span className="block truncate font-mono text-xs text-ink-muted">{event.uri}</span>
      </span>
    </button>
  );
}
