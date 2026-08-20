import { type KeyboardEvent, useState } from 'react';
import { Send } from 'lucide-react';

import { Button } from './ui/button';

export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === '' || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-border bg-surface p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={1}
        placeholder={disabled ? '実行中…' : 'メッセージを送る（Enter で送信・Shift+Enter で改行）'}
        className="max-h-40 min-h-[38px] flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-muted focus:border-accent disabled:opacity-50"
      />
      <Button variant="primary" size="md" disabled={disabled || text.trim() === ''} onClick={submit} aria-label="送信">
        <Send className="h-4 w-4" />
        送信
      </Button>
    </div>
  );
}
