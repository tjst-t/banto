import { Children, isValidElement, memo, useEffect, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useTheme } from '../hooks/useTheme';
import { highlightToHtml } from '../lib/highlight';

/**
 * **相手の言葉を Markdown として描く**（要件 E4）。
 *
 * ここまでは素の文字列（`whitespace-pre-wrap`）で出していたので、
 * **見出しも箇条も表も、記号のまま並んでいた。** LLM の出力は Markdown なので、
 * 描かないというのは「読めるものを読めない形で出す」ことにあたる。
 *
 * ## 未完の Markdown を補う仕掛けは、いまは要らない
 *
 * 前の実装は `remend` で未完の記法（閉じていない ``` や `**`）を補っていた。
 * **こちらは1文字ずつ流していない**——`message.recorded` が発話まるごと1件で届くので、
 * 途中の形が画面に出ることがない。要らない依存は足さない（規則10）。
 * 途中経過を流すようになったら、そのとき**名前のあるもの**（remend）を引く（規則12）。
 *
 * ## 見た目は CSS 側（`.markdown`）に置く
 *
 * ここにクラスを並べると、字の段と色がまたコンポーネントの中に散る（要件 E9）。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** `<pre><code>` の中身を文字列として集める（react-markdown は配列で渡すことがある）。 */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/**
 * コードブロック。**色と、写す口**（要件 E4）。
 *
 * 色は非同期に降ってくるので、**届くまでは素のまま出す**——流れている最中は
 * 未完のコードが来るのが普通で、色が付くまで待つと文字が消えたように見える。
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const { theme } = useTheme();
  const child = Children.toArray(children)[0];
  const className = isValidElement<{ className?: string }>(child)
    ? (child.props.className ?? '')
    : '';
  const lang = /language-([\w-]+)/.exec(className)?.[1] ?? '';
  const code = textOf(children);

  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    if (lang === '') {
      setHtml(null);
      return;
    }
    void highlightToHtml(code, lang, theme).then(
      (out) => {
        if (live) setHtml(out);
      },
      () => {
        // 色が付かなくても中身は読める。**そこで止めない**——
        // ただし黙って別のものに見せかけもしない（素のまま出る）。
        if (live) setHtml(null);
      },
    );
    return () => {
      live = false;
    };
  }, [code, lang, theme]);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="group relative my-3">
      <button
        type="button"
        onClick={copy}
        title="コピー"
        aria-label="コードをコピー"
        className="absolute right-1.5 top-1.5 z-10 rounded-md p-1.5 text-ink-muted opacity-0 transition-opacity hover:bg-paper-sunken hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-done" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {lang !== '' && (
        <span className="absolute left-3 top-1.5 font-mono text-xs text-ink-muted">{lang}</span>
      )}
      {html === null ? (
        <pre className="overflow-x-auto rounded-md bg-paper-sunken px-3 pb-3 pt-6 font-mono text-sm leading-relaxed text-ink">
          {children}
        </pre>
      ) : (
        // shiki が組み立てた HTML（外部入力をそのまま流していない）。
        <div
          className="[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:px-3 [&_pre]:pb-3 [&_pre]:pt-6 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
