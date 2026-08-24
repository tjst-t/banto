import { File, Folder } from 'lucide-react';

import { ScrollArea } from '../components/ui/scroll-area';
import type { ModuleViewProps } from './registry';

interface Entry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly bytes: number;
}

const ROOT_URI = 'banto://fs/dir';

/**
 * `banto://fs/dir` は根専用の固定URI、`banto://fs/dir/<path>` はそれ以外
 * （`modules/fs/src/index.ts` 参照。`.` や空文字はURL正規化で消えるので使えない）。
 */
function pathFromUri(uri: string): string {
  if (uri === ROOT_URI) return '';
  return decodeURIComponent(uri.replace(/^banto:\/\/fs\/dir\//, ''));
}

function dirUri(path: string): string {
  return path === '' ? ROOT_URI : `banto://fs/dir/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function fileUri(path: string): string {
  return `banto://fs/file/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * **fsモジュールが持ち込む、人が直接開けるファイルブラウザ**（要件C3・決定33・
 * PO指摘 2026-08-25：「フォルダをBANTO ROOTから開けるようなのがあるといい」）。
 *
 * `banto://fs/file/…`（`FileView`）とは別の面——押すとパネルの中だけで移動する
 * （`onNavigate`）。フォルダを押せば`DirView`のまま次の階層へ、ファイルを押せば
 * `FileView`に切り替わる（`ResourceViewer`がURIの接頭辞から面を選び直す。
 * 規則3：割り当ての判定は1箇所しか持たない）。
 */
export function DirView({ uri, text, onNavigate }: ModuleViewProps) {
  const path = pathFromUri(uri);
  const entries: Entry[] = (() => {
    try {
      return JSON.parse(text) as Entry[];
    } catch {
      // 握りつぶさない代わりに、空の一覧として描く——素のJSONを出しても
      // 人には読みにくいだけで、規則2の「理由を言う」は下の件数表示に譲る。
      return [];
    }
  })();

  const parentPath =
    path === ''
      ? null
      : path
          .split('/')
          .slice(0, -1)
          .join('/');

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-module-view="fs/DirView">
      <div className="border-b border-rule px-3 py-1.5">
        <p className="truncate font-mono text-xs text-ink-secondary">/{path}</p>
        <p className="text-xs text-ink-muted">{entries.length} 件</p>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col p-1">
          {parentPath !== null && (
            <li>
              <button
                type="button"
                data-dir-up
                onClick={() => onNavigate(dirUri(parentPath), parentPath === '' ? '/' : `/${parentPath}`)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink-secondary hover:bg-paper-sunken"
              >
                <Folder className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                ..
              </button>
            </li>
          )}
          {entries.map((e) => {
            const childPath = path === '' ? e.name : `${path}/${e.name}`;
            return (
              <li key={e.name}>
                <button
                  type="button"
                  data-dir-entry={e.name}
                  onClick={() =>
                    e.kind === 'dir'
                      ? onNavigate(dirUri(childPath), `/${childPath}`)
                      : onNavigate(fileUri(childPath), `/${childPath}`)
                  }
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink hover:bg-paper-sunken"
                >
                  {e.kind === 'dir' ? (
                    <Folder className="h-4 w-4 shrink-0 text-ink-muted" strokeWidth={1.7} />
                  ) : (
                    <File className="h-4 w-4 shrink-0 text-ink-muted" strokeWidth={1.7} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  {e.kind === 'file' && (
                    <span className="shrink-0 font-mono text-xs text-ink-muted">
                      {e.bytes.toLocaleString()}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {entries.length === 0 && <li className="px-2 py-1.5 text-sm text-ink-muted">空のフォルダ</li>}
        </ul>
      </ScrollArea>
    </div>
  );
}
