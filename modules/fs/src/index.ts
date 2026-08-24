/**
 * ファイルモジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * この層に条件分岐や整形以上のものが出てきたら、それは core に置くべきもの。
 */

import { defineModule, ok, type BantoModule, type DefinedModule } from '@banto/module-kit';
import { z } from 'zod';

import { FileSystemCore } from './core.js';

export const manifest: BantoModule = {
  id: 'fs',
  description: '許された root の内側で、ファイルを読む・書く・並べる',
  // 鍵を扱わず、落ちてもホストを道連れにしない。in-process でよい（要件 C8b）。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  /**
   * 持ち込む画面（要件 C1・C14、決定20）。
   *
   * **`in-page`** ——このモジュールは banto の束ねに入っていて、
   * プロセスも内側（`in-process`）である。**プロセスで信用しているものを、
   * 画面でも信用する**。第三者モジュールは束ねに入らないので、
   * ここを名乗ろうとしても実体が無い（方針ではなく、構造で決まる）。
   */
  gui: {
    kind: 'in-page',
    entry: 'fs/FileView',
    views: [
      { uriPrefix: 'banto://fs/file/', title: 'ファイル' },
      // 設定の区画（要件 C4）。**置き場が違うだけで、機構は会話の面と同じ。**
      { uriPrefix: 'banto://fs/settings', title: 'ファイル（fs）', slot: 'settings' },
      /**
       * **人が直接開けるファイルブラウザ**（要件C3・PO指摘 2026-08-25：
       * 「フォルダをBANTO ROOTから開けるようなのがあるといい」）。
       * `fs/FileView` とは別の面を持つので、この面だけ `entry` を上書きする
       * （決定33）。
       */
      {
        uriPrefix: 'banto://fs/dir/',
        title: 'ファイル一覧',
        slot: 'launcher',
        entry: 'fs/DirView',
        // 根だけ別の固定URI（`banto://fs/dir`、末尾スラッシュ無し）。
        // `.`や空文字はURL正規化でドットセグメントとして消える
        // （実測 2026-08-25：`new URL('banto://fs/dir/.').href` は
        // `'banto://fs/dir/'`になり、テンプレートの`{+path}`に当たらなくなる）
        // ので、根専用の固定リソースを別に持つ（`ViewSpec.launcherUri` 参照）。
        launcherUri: 'banto://fs/dir',
      },
    ],
  },
};

/**
 * ファイルモジュールを1つ組み立てる。
 *
 * **`root` と `writeRoot` は呼び手（host）が解いて渡す**——`conversationModule` と
 * 同じ考え方で、ここでは環境変数を読まない（規則3：作業範囲の由来を1箇所にする）。
 *
 * `writeRoot` は省略可（決定29）。渡さなければ書き込みも `root` 全体に及ぶ
 * ——リポジトリに紐づかない会話や、起動時の読み取り専用接続（`/api/resource`）は
 * これで今までどおり動く。
 */
export function fsModule(root: string, writeRoot: string | null = null): DefinedModule {
  return defineModule({
    manifest,
    createCore: () => new FileSystemCore(root, writeRoot),
    tools: (tool) => [
      tool({
        name: 'read',
        description:
          'Read a UTF-8 text file, relative to the module root. ' +
          'Returns a uri for the file — pass it to the show tool if the person should see it.',
        input: { path: z.string().describe('Path relative to the root') },
        // **`write` と同じ形**（要件C14）。中身は summary でそのまま返す——
        // structuredContent と会話に出す文字列で、事実を二重に作文しない（規則3）。
        output: {
          content: z.string(),
          uri: z.string().describe('banto:// uri for this file'),
        },
        run: async (core, { path: p }) => ({
          content: await core.read(p),
          uri: uriFor(p),
        }),
        summary: (v) => v.content,
      }),
      tool({
        name: 'write',
        description:
          'Write a UTF-8 text file, relative to the module root. Creates parent directories. ' +
          'Returns a uri for the file — pass it to the show tool if the person should see it. ' +
          'Writing may be restricted to the repository this conversation is working in, even ' +
          'though reading is not — if declined for being outside that range, that is not a bug.',
        input: {
          path: z.string().describe('Path relative to the root'),
          content: z.string().describe('Full file contents'),
        },
        // **書いたものの URI を返す**（要件 C14）。AI はこれを `show` に渡すだけで、
        // 画面の名前を知る必要がない（決定19）。
        output: {
          bytes: z.number(),
          uri: z.string().describe('banto:// uri for this file'),
        },
        run: async (core, { path: p, content }) => ({
          bytes: await core.write(p, content),
          uri: uriFor(p),
        }),
        summary: (v) => `${v.bytes} バイト書いた: ${v.uri}`,
      }),
      tool({
        name: 'list',
        description: 'List directory entries, relative to the module root.',
        input: { path: z.string().describe('Directory path relative to the root') },
        run: async (core, { path: p }) =>
          ok((await core.list(p)).map((e) => `${e.kind === 'dir' ? 'd' : '-'} ${e.name} ${e.bytes}`).join('\n')),
      }),
    ],
    // **持っている URI 空間**（要件 C14）。人も AI も、同じ URI で同じものを見る（C2）。
    resources: [
      {
        name: 'settings',
        description: 'What this module is configured with',
        uri: 'banto://fs/settings',
        mimeType: 'text/plain',
        /**
         * **いまの設定を、そのまま見せる**（要件 C4）。
         *
         * まだ変えられるものが無いので、変える口は出さない
         * ——**押せるのに効かない**より、押せないほうがよい（規則2）。
         */
        read: async (core) => core.describeSettings(),
      },
      {
        name: 'file',
        description: 'A text file under the module root',
        uri: 'banto://fs/file/{+path}',
        mimeType: 'text/plain',
        read: async (core, _uri, params) => {
          const raw = params['path'];
          const p = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
          // 握りつぶさない（規則2）。読めない理由は core が投げる。
          return core.read(decodeURIComponent(p));
        },
      },
      {
        // **根専用の固定リソース**。テンプレート版（下）は空文字にマッチしない
        // ——`launcherUri`（manifest 側のコメントを見よ）と同じ理由。
        name: 'dir-root',
        description: 'Directory entries at the module root',
        uri: 'banto://fs/dir',
        mimeType: 'application/vnd.banto.dir+json',
        read: async (core) => JSON.stringify(await core.list('')),
      },
      {
        name: 'dir',
        description: 'Directory entries under the module root',
        uri: 'banto://fs/dir/{+path}',
        // JSON だが `application/json` は「汎用の面」ではなく空タブになるので、
        // 素の json とは別の型名にして DirView にだけ割り当てる（決定20と同じ考え）。
        mimeType: 'application/vnd.banto.dir+json',
        read: async (core, _uri, params) => {
          const raw = params['path'];
          const p = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
          // **中身は `list` ツールと同じ core.list に一本化**（規則3）——
          // 人向けの一覧とAI向けの一覧を、別のロジックで作らない。
          return JSON.stringify(await core.list(decodeURIComponent(p)));
        },
      },
    ],
  });
}

/**
 * このモジュールが持つ URI の作りかた（要件 C14・決定19）。
 *
 * **`banto://<モジュール id>/…` にする**——先頭を見れば持ち主が分かるので、
 * 「どの URI を誰が持っているか」の表を別に持たずに済む（規則3）。
 */
export function uriFor(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '');
  return `banto://fs/file/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

export { FileSystemCore } from './core.js';
