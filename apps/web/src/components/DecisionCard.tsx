import { useState } from 'react';
import { HelpCircle } from 'lucide-react';

import { Button } from './ui/button';
import type { DecisionOption } from '../lib/types';

/**
 * 判断待ちカード（要件 A6）。**唯一、面を塗ってよい「あなたの番」の色**を使う。
 *
 * 選択肢を押すか、自由に書くか。選択肢が在るときも書く欄を閉じないのは、
 * **どれも選べないのが普通に起きる**から（立てた側は答えの形を全部は知らない）。
 *
 * 会話の最後尾にそのまま出す形と、受信箱の一覧の中で出す形の**両方から使う**
 * ——見た目が2箇所で揃っていないと、同じ判断待ちが別物に見える（規則3）。
 */
export function DecisionCard({
  question,
  options,
  context,
  onAnswer,
}: {
  question: string;
  options?: readonly DecisionOption[] | undefined;
  /** 受信箱で使うときだけ渡す、出所やスレッド名などの文脈。 */
  context?: React.ReactNode | undefined;
  onAnswer: (answer: string, optionId?: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (answer: string, optionId?: string) => {
    if (answer.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer, optionId);
      setText('');
    } catch (cause) {
      // 握りつぶさない（規則2）。断られた理由をそのまま出す。
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const opts = options ?? [];

  return (
    <div
      data-decision-card
      className="rounded-md bg-attention-soft px-4 py-3 shadow-[inset_3px_0_0_var(--attention)]"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-attention">
        <HelpCircle className="h-3.5 w-3.5" />
        判断待ち
      </div>
      {context}
      <p className="text-md leading-relaxed text-ink">{question}</p>

      <div className="mt-3 flex flex-col gap-2">
        {opts.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {opts.map((o) => (
              <Button
                key={o.id}
                variant="attention"
                size="sm"
                disabled={busy}
                title={o.detail}
                onClick={() => void send(o.label, o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}
        <div className="flex gap-1.5">
          <input
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // 変換確定の Enter で送らない（要件 E8）。**入力欄はどこでも同じ約束にする。**
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(text);
            }}
            placeholder={opts.length > 0 ? 'どれも選べないときは、ここに書く' : '答えを書く'}
            className="h-[var(--h-ctl-sm)] min-w-0 flex-1 rounded-sm border border-rule bg-paper px-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent disabled:opacity-50"
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || text.trim() === ''}
            onClick={() => void send(text)}
          >
            送る
          </Button>
        </div>
        {error !== null && <p className="text-xs text-stopped">{error}</p>}
      </div>
    </div>
  );
}
