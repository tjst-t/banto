import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * 会話パネル・作業パネルで共通する頭。**題・サブ情報・戻る・右側の操作**という
 * 同じ形を持つので、1つにまとめる（規則3）。
 */
export function PanelHeader({
  title,
  eyebrow,
  sub,
  onBack,
  actions,
}: {
  title: string;
  /**
   * 題の**上**に出す、素性の1行（例：「◂ 親のタイトル から」）。フォークだけが持つ。
   *
   * プロトタイプ（`13-tsuzukima-kai.html`）の `.from` 行と同じ考え——
   * どこから来たかを、灰色の補足ではなく最初に目に入る場所に出す。
   */
  eyebrow?: ReactNode;
  sub?: ReactNode;
  /** 開いた元へ戻る。**無ければ出さない**（ルートのスレッドには戻り先が無い）。 */
  onBack?: (() => void) | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-[54px] shrink-0 items-center gap-2 border-b border-rule-faint px-4 py-2">
      {onBack !== undefined && (
        <button
          type="button"
          onClick={onBack}
          aria-label="戻る"
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-sm text-ink-muted hover:bg-paper-sunken hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        {eyebrow !== undefined && (
          <p className="truncate text-xs font-medium text-accent">{eyebrow}</p>
        )}
        <h1 className="truncate text-lg font-semibold leading-tight text-ink">{title}</h1>
        {sub !== undefined && (
          <p className="truncate text-xs text-ink-muted">{sub}</p>
        )}
      </div>
      {actions}
    </div>
  );
}
