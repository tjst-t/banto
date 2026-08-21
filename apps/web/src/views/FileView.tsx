import { ScrollArea } from '../components/ui/scroll-area';
import type { ModuleViewProps } from './registry';

/**
 * **fs モジュールが持ち込む面**（要件 C1・C14、決定20）。
 *
 * `banto://fs/file/…` を開く。ホストの汎用の面（素のまま出す）との違いは、
 * **ファイルとして見せる**こと——行番号を振り、パスを見出しにする。
 *
 * **整形はしない。** Markdown を描画したりはせず、書いてあるものをそのまま出す
 * ——整形すると、壊れているのか元からそうなのかが分からなくなる。
 * 見せ方を足すのは、要るようになってからでよい。
 */
export function FileView({ uri, text, mimeType }: ModuleViewProps) {
  const filePath = decodeURIComponent(uri.replace(/^banto:\/\/fs\/file\//, ''));
  const lines = text.split('\n');

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-module-view="fs/FileView">
      <div className="border-b border-border px-3 py-1.5">
        <p className="truncate font-mono text-[11px] text-ink-secondary">{filePath}</p>
        <p className="text-[10px] text-ink-muted">
          {lines.length} 行 ・ {mimeType ?? '形は分からない'}
        </p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <table className="w-full border-collapse font-mono text-xs">
          <tbody>
            {lines.map((line, i) => (
              <tr key={`${i}-${line.slice(0, 16)}`} className="align-top">
                {/* 行番号は**選択に入らない**ようにしておく（写して貼るときに邪魔になる）。 */}
                <td className="w-10 select-none border-r border-border px-2 py-0.5 text-right text-[10px] text-ink-muted">
                  {i + 1}
                </td>
                <td className="whitespace-pre-wrap break-words px-2 py-0.5 text-ink">{line}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}
