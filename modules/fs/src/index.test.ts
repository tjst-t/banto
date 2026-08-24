/**
 * fs モジュールの配線を確かめる試験（決定33）。**本物の MCP** で繋ぎ、
 * `banto://fs/dir/{+path}` が実際に読めることを確認する——
 * 特に**根そのもの**（`banto://fs/dir/`、パス無し）が `{+path}` に
 * 空文字として当たるかは、コードを眺めても分からない（規則1）。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fsModule, manifest } from './index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'banto-fs-wiring-'));
  await mkdir(path.join(root, 'repo-a'), { recursive: true });
  await writeFile(path.join(root, 'repo-a', 'a.txt'), 'A', 'utf8');
  await writeFile(path.join(root, 'top.txt'), 'top', 'utf8');
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(root, { recursive: true, force: true });
});

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = fsModule(root).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

describe('fs モジュールの配線', () => {
  it('台帳に launcherUri（決定33）の元になる view が出る', () => {
    const launcher = manifest.gui?.views.find((v) => v.slot === 'launcher');
    expect(launcher).toMatchObject({
      uriPrefix: 'banto://fs/dir/',
      entry: 'fs/DirView',
      launcherUri: 'banto://fs/dir',
    });
  });

  it('banto://fs/dir（末尾スラッシュ無し＝根専用の固定リソース）が読める', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.readResource({ uri: 'banto://fs/dir' });
      const entries = JSON.parse((res.contents[0] as { text: string }).text) as { name: string; kind: string }[];
      expect(entries.map((e) => e.name).sort()).toEqual(['repo-a', 'top.txt']);
    } finally {
      await close();
    }
  });

  it('banto://fs/dir/repo-a（サブディレクトリ）が読める', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.readResource({ uri: 'banto://fs/dir/repo-a' });
      const entries = JSON.parse((res.contents[0] as { text: string }).text) as { name: string; kind: string }[];
      expect(entries).toEqual([{ name: 'a.txt', kind: 'file', bytes: 1 }]);
    } finally {
      await close();
    }
  });
});
