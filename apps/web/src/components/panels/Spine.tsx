import { ArrowLeft } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/**
 * 背表紙（見本の `.spine`）。
 *
 * フォーク・作業パネルが開いて幹が隠れているとき、**幹を消さずに** 44px の帯に
 * 畳んでおく——戻り道が常に見えている（見本のコメント「戻り道が見えている」）。
 * 押すと、フォーク・作業パネルを両方閉じて幹だけの表示に戻る。
 */
export function Spine({
  label,
  letter,
  onClick,
}: {
  /** ホバー札の文言（例：「元のスレッド へ戻る」）。 */
  label: string;
  letter: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          data-spine
          className="flex w-11 shrink-0 flex-col items-center gap-2 bg-paper-sunken py-4 hover:bg-paper-sunken-2"
        >
          <ArrowLeft className="h-[15px] w-[15px] text-ink-muted" strokeWidth={1.8} />
          <span className="grid h-7 w-7 place-items-center rounded-sm bg-paper-raised text-sm font-semibold text-ink-secondary shadow-rest">
            {letter}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label} へ戻る</TooltipContent>
    </Tooltip>
  );
}
