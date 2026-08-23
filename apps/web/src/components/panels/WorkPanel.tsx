import { X } from 'lucide-react';

import { ResourceViewer } from '../ResourceViewer';
import { BasePanel } from '../BasePanel';

export type WorkTarget =
  | { readonly kind: 'resource'; readonly uri: string; readonly name: string }
  | { readonly kind: 'base'; readonly threadId: string; readonly threadTitle: string };

/**
 * 作業パネルのガワ（要件 C1・C14、決定20）。
 *
 * **層で重ねる。** 会話パネルの上に紙を1枚乗せた見た目にする——横に並べただけでは
 * 「別のもの」に見えるが、重ねると「会話から開いたもの」だと分かる。
 *
 * 中身（`ResourceViewer`／`BasePanel`）は**手を触れない**。ここは置き場のガワだけ。
 */
export function WorkPanel({
  work,
  onClose,
  onBaseChanged,
  /**
   * 「会話は左に残しています」の札（見本の work-head バッジ）。**幅の要る作業に
   * 入っても会話が消えていないことを言うためのもの**——横に会話の帯があるとき
   * （狭い画面での丸ごと入れ替えでは会話が見えていないので）だけ渡す。
   */
  sideNote,
  /** 共有baseスレッドのid（決定30）。`BasePanel` が共有base由来の行に印を付けるのに使う。 */
  sharedBaseThreadId,
}: {
  work: WorkTarget;
  onClose: () => void;
  onBaseChanged: () => void;
  sideNote?: string | undefined;
  sharedBaseThreadId?: string | undefined;
}) {
  return (
    <section
      data-work-panel={work.kind === 'resource' ? work.uri : `base:${work.threadId}`}
      className="relative z-[3] ml-[-10px] mt-5 flex min-h-0 min-w-0 flex-1 flex-col rounded-t-lg bg-paper-raised shadow-cascade animate-slide-in"
    >
      {work.kind === 'resource' ? (
        <ResourceViewer uri={work.uri} name={work.name} onClose={onClose} badge={sideNote} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" data-base-panel={work.threadId}>
          <div className="flex items-center gap-2 border-b border-rule-faint px-3 py-2">
            <button
              type="button"
              onClick={onClose}
              title="閉じる"
              className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-sm text-ink-muted hover:bg-paper-sunken hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-md font-semibold text-ink">決まったこと</h3>
              <p className="truncate text-xs text-ink-muted">{work.threadTitle}</p>
            </div>
            {sideNote !== undefined && (
              <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
                {sideNote}
              </span>
            )}
          </div>
          <BasePanel
            threadId={work.threadId}
            onChanged={onBaseChanged}
            sharedBaseThreadId={sharedBaseThreadId}
          />
        </div>
      )}
    </section>
  );
}
