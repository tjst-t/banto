import { ChevronDown } from 'lucide-react';
import { useMessageScroller, useMessageScrollerScrollable } from '@shadcn/react/message-scroller';

/**
 * 末尾へ戻る浮き玉（要件 A6・A7）。
 *
 * **判断待ちの常設欄を無くす代わりに、これがある。** 判断待ちは会話の最後尾に
 * そのまま出るので、放っておいても一番下にある——遡ったときだけ、この玉が
 * 「あなたの番」の色に変わって件数を言う。要件 A7 の「発生ではなく滞留」と同じ考え：
 * 遡っている間だけ思い出させればよく、常に画面を占領する必要は無い。
 *
 * `MessageScroller.Root` の内側でだけ使える（決定27。以前は
 * `use-stick-to-bottom` の `useStickToBottomContext` を使っていたが、
 * `@shadcn/react/message-scroller` に載せ替えた）。`useMessageScrollerScrollable`
 * の `end`（＝末尾方向へまだスクロールできるか）が `false` のとき、
 * それが「もう末尾に居る」ということ。
 */
export function JumpToBottom({ pendingCount }: { pendingCount: number }) {
  const { end: canScrollToEnd } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  if (!canScrollToEnd) return null;

  return (
    <button
      type="button"
      onClick={() => scrollToEnd()}
      data-jump-to-bottom
      className={`absolute bottom-4 right-5 z-10 flex h-[30px] items-center gap-1.5 rounded-full px-3 text-xs shadow-pop ${
        pendingCount > 0
          ? 'bg-attention font-semibold text-on-attention'
          : 'bg-paper-raised text-ink-secondary hover:text-ink'
      }`}
    >
      {pendingCount > 0 && <>判断待ち {pendingCount}</>}
      <ChevronDown className="h-3.5 w-3.5" />
    </button>
  );
}
