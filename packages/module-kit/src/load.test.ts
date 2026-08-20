/**
 * ディスクのマニフェスト → 台帳、の経路を本物で確かめる。
 *
 * 相手は `modules/hello-py`——**TypeScript でないモジュール**（要件 C6）。
 * python3 を実際に起動して `tools/list` を聞くので、偽物は挟まっていない（教訓1・16）。
 * API は呼ばないので課金は無い。
 *
 * python3 が無い環境では落ちる。それでよい——「他言語モジュールが動く」ことが
 * 完了条件なのだから、動かせないなら黙って飛ばさず落ちるべきである。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { inProcessSource, loadManifest, subprocessSource } from './load.js';
import { resolve as resolveRegistry } from './registry.js';

const repoRoot = process.cwd();
const helloPy = path.join(repoRoot, 'modules', 'hello-py', 'manifest.json');

describe('loadManifest', () => {
  it('hello-py のマニフェストを読んで契約に照らす', async () => {
    const manifest = await loadManifest(helloPy);
    expect(manifest.id).toBe('hello-py');
    // 他言語は subprocess を建てるぶん一段高い。この非対称は契約の対価（要件 C6）。
    expect(manifest.isolation).toBe('subprocess');
    expect(manifest.mcp.kind).toBe('subprocess');
  });

  it('契約に合わないマニフェストは、理由を並べて弾く', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'banto-manifest-'));
    const bad = path.join(dir, 'manifest.json');
    // secrets を扱うのに in-process。鍵が AI 実行と同居する（要件 C8c）。
    await writeFile(
      bad,
      JSON.stringify({
        id: 'bad',
        description: 'x',
        isolation: 'in-process',
        mcp: { kind: 'in-process' },
        handles: ['secrets'],
      }),
      'utf8',
    );

    await expect(loadManifest(bad)).rejects.toThrow(/secrets/);
  });

  it('JSON として壊れていれば、読めたことにしない', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'banto-manifest-'));
    const broken = path.join(dir, 'manifest.json');
    await writeFile(broken, '{ "id": ', 'utf8');
    await expect(loadManifest(broken)).rejects.toThrow(/JSON として読めない/);
  });
});

describe('subprocessSource', () => {
  it('実際に python3 を起動して tools/list を聞く', async () => {
    const manifest = await loadManifest(helloPy);
    const source = subprocessSource(manifest, repoRoot);

    const tools = await source.listTools();
    expect([...tools].sort()).toEqual(['greet', 'python_version']);
  }, 60_000);

  it('台帳に載り、依存が満たされていれば起動してよいと判定される', async () => {
    const manifest = await loadManifest(helloPy);

    // hello-py の greet に依存する TypeScript 側のモジュールを想定する。
    // 依存はツール名まで書く——相手が名前を変えたら接続の時点で落ちてほしい。
    const consumer = inProcessSource(
      {
        id: 'consumer',
        description: 'hello-py を呼ぶ側',
        isolation: 'in-process',
        mcp: { kind: 'in-process' },
        requires: [{ module: 'hello-py', tools: ['greet'] }],
      },
      ['use_greeting'],
    );

    const resolution = await resolveRegistry([subprocessSource(manifest, repoRoot), consumer]);
    expect(resolution.problems).toEqual([]);
    expect([...resolution.ready].sort()).toEqual(['consumer', 'hello-py']);
  }, 60_000);

  it('宣言したツールが実在しなければ、使う瞬間ではなく接続の時点で落ちる', async () => {
    const manifest = await loadManifest(helloPy);
    const consumer = inProcessSource(
      {
        id: 'consumer',
        description: 'hello-py を呼ぶ側',
        isolation: 'in-process',
        mcp: { kind: 'in-process' },
        // hello-py には存在しない名前。名前を変えられた状況を再現している。
        requires: [{ module: 'hello-py', tools: ['greet_v2'] }],
      },
      ['use_greeting'],
    );

    const resolution = await resolveRegistry([subprocessSource(manifest, repoRoot), consumer]);
    expect(resolution.problems).toContainEqual({
      kind: 'required-tool-missing',
      moduleId: 'consumer',
      missing: 'hello-py',
      tool: 'greet_v2',
    });
  }, 60_000);
});
