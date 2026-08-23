/**
 * ファイルモジュールの core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * ツールインターフェースもデータ API も、ここへ委譲するだけ。
 * ここが唯一の実装なので、GUI を足すときに書き直すものは無い。
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { resolveInside } from '@banto/module-kit';

export interface Entry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly bytes: number;
}

/**
 * AI が触れる範囲は、明示的に許した範囲に限られる（要件 D4）。
 *
 * `root` の外へは出られない（境界チェックは `@banto/module-kit` の `resolveInside`
 * に一本化——規則3）。
 *
 * **読み取りは広く、書き込みは狭く**（決定29）。会話には人が同席するので、
 * 読み取り・一覧は既定の広い `root` のままでよい。書き込みだけ、
 * `writeRoot`（そのスレッドが向いているリポジトリ）が渡されていれば、
 * その内側に追加で縛る——プロンプトインジェクションで隣のリポジトリを
 * 書き換えられる穴（レビュー指摘）を塞ぐ。`writeRoot` が無い（リポジトリに
 * 紐づかない会話）ときは、今までどおり `root` のどこにでも書ける。
 */
export class FileSystemCore {
  private readonly root: string;
  private readonly writeRoot: string | null;

  constructor(root: string, writeRoot: string | null = null) {
    this.root = path.resolve(root);
    // writeRoot 自体も root の内側でなければならない——外を指されても広がらない。
    this.writeRoot = writeRoot === null ? null : resolveInside(this.root, writeRoot);
  }

  private resolveInside(relative: string): string {
    return resolveInside(this.root, relative);
  }

  async read(relative: string, maxBytes = 200_000): Promise<string> {
    const target = this.resolveInside(relative);
    const info = await stat(target);
    if (info.isDirectory()) throw new Error(`${relative} はディレクトリ`);
    const text = await readFile(target, 'utf8');
    if (text.length <= maxBytes) return text;
    // 黙って切らない。切ったことを本文に書く（教訓13）。
    return `${text.slice(0, maxBytes)}\n…（${text.length - maxBytes} 文字を切り落とした。maxBytes=${maxBytes}）`;
  }

  async write(relative: string, content: string): Promise<number> {
    const target = this.resolveInside(relative);
    if (this.writeRoot !== null) {
      const rel = path.relative(this.writeRoot, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `この会話が書ける範囲の外: ${relative}` +
            `（書き込みは ${path.relative(this.root, this.writeRoot) || '.'} の内側に限る。読むだけなら root 全体を見られる）`,
        );
      }
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    return Buffer.byteLength(content, 'utf8');
  }

  async list(relative: string): Promise<Entry[]> {
    const target = this.resolveInside(relative);
    const entries = await readdir(target, { withFileTypes: true });
    const out: Entry[] = [];
    for (const entry of entries) {
      const info = await stat(path.join(target, entry.name)).catch(() => null);
      out.push({
        name: entry.name,
        kind: entry.isDirectory() ? 'dir' : 'file',
        bytes: info?.isFile() === true ? info.size : 0,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * いまの設定（要件 C4）。**根がどこかは、いちばん知りたいこと**である
   * ——ここを取り違えると、意図しない場所を読み書きすることになる。
   */
  describeSettings(): string {
    return [
      '# fs モジュールの設定',
      '',
      `作業範囲の根: ${this.root}`,
      '',
      'この根は BANTO_FS_ROOT で渡される（既定値は持たない）。',
      '変えるには banto を起動し直す——実行中に作業範囲が動くと、',
      '同じ相対パスが別のファイルを指すことになる。',
      '',
      this.writeRoot === null
        ? '書き込みの範囲: root 全体（このスレッドは対象リポジトリを宣言していない）'
        : `書き込みの範囲: ${path.relative(this.root, this.writeRoot) || '.'}（読み取りは root 全体）`,
    ].join('\n');
  }
}
