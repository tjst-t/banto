import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Send } from 'lucide-react';

import { Button } from './ui/button';

/**
 * 入力欄（要件 E8）。
 *
 * ## 変換確定の Enter で送らない
 *
 * ここは**不具合に近い**ところだった。`Enter` を素で見ていたので、
 * **日本語を打つと、変換を確定するたびに送信されていた**——「にほんご」と打って
 * 変換を確定した瞬間に飛ぶので、毎日使う道具としては成立しない。
 *
 * 直し方は `isComposing` を見るだけである。**名前のある問題**なので、
 * 押下の間隔を測るような自前の判定は作らない（規則12）。
 *
 * ## 走っている間も打てる
 *
 * 送信は止めるが、**入力欄は生かす。** 返事を待つ間に次を書けないと、
 * 考えていたことをどこか別の場所へ書き留めることになる。
 *
 * ## 高さは中身に合わせる
 *
 * 1行に固定すると、長い依頼を書くときに**自分が何を書いたのか見えない。**
 * 上限まで伸ばし、それを越えたら中で送る。
 */
export function Composer({
  disabled,
  onSend,
}: {
  /** 送信を止めるかどうか。**打つことは止めない。** */
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // 中身に合わせて伸びる。**先に縮めてから測る**——縮めないと一度伸びた高さが残る。
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === '' || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // **変換中の Enter は確定であって送信ではない**（要件 E8）。
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const empty = text.trim() === '';

  return (
    <div className="border-t border-rule bg-paper-raised px-3 py-2.5">
      <div className="mx-auto flex w-full max-w-[var(--w-read)] items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={disabled ? '返事を待っています（先に書いておけます）' : 'メッセージを送る'}
          className="max-h-[200px] min-h-[var(--h-ctl)] flex-1 resize-none rounded-md border border-rule bg-paper px-3 py-1.5 text-md leading-relaxed text-ink outline-none placeholder:text-ink-muted focus:border-accent"
        />
        <Button
          variant="accent"
          size="md"
          disabled={disabled || empty}
          onClick={submit}
          aria-label="送信"
          title="Enter で送信 ・ Shift+Enter で改行"
        >
          <Send className="h-3.5 w-3.5" />
          送信
        </Button>
      </div>
      {/* **押し方はその場に書く。** 覚えさせるより、見えているほうが安い */}
      <p className="mx-auto mt-1 flex w-full max-w-[var(--w-read)] items-center gap-1 text-xs text-ink-muted">
        <CornerDownLeft className="h-3 w-3" />
        Enter で送信 ・ Shift+Enter で改行
      </p>
    </div>
  );
}
