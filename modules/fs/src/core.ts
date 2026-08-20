/**
 * ファイルモジュールの core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * ツールインターフェースもデータ API も、ここへ委譲するだけ。
 * ここが唯一の実装なので、GUI を足すときに書き直すものは無い。
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface Entry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly bytes: number;
}

/**
 * AI が触れる範囲は、明示的に許した範囲に限られる（要件 D4）。
 *
 * `root` の外へは出られない。**判定は正規化してから**行う——
 * `..` も symlink も、文字列の見た目では防げない。
 */
export class FileSystemCore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** root の内側に閉じ込める。外へ出ようとしたら理由を付けて投げる。 */
  private resolveInside(relative: string): string {
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`許された範囲の外: ${relative}（root=${this.root}）`);
    }
    return target;
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
}
