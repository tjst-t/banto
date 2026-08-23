/**
 * **本物の docker で測る。** 偽物を置くと、この試験は何も証明しない（教訓1）——
 * ここで確かめたいのは「口を docker で満たせるか」であって、
 * 「自分で書いた偽の docker が自分の期待どおりか」ではない。
 *
 *   BANTO_E2E=1 npx vitest run modules/env-docker
 *
 * 既定で走らせないのは、docker が居ないところでも `npm test` が通ってほしいため。
 * **黙って飛ばさない**——走らせ方をここに書いてある。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DockerEnvironmentCore, containerNameFor } from './core.js';

const run = promisify(execFile);
const enabled = process.env['BANTO_E2E'] === '1';

/** 走らせる箱。**既定を持たない**のは core と同じ理由（教訓13）。 */
const IMAGE = process.env['BANTO_DOCKER_IMAGE'] ?? 'node:22-slim';

let root: string;
let core: DockerEnvironmentCore;
const started: string[] = [];

beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(path.join(tmpdir(), 'banto-docker-'));
  core = new DockerEnvironmentCore(root, IMAGE);
});

afterAll(async () => {
  // **自分が作ったものだけ消す。** 他所のコンテナには触らない。
  for (const name of started) {
    await run('docker', ['rm', '--force', name]).catch(() => undefined);
  }
});

describe.skipIf(!enabled)('docker 環境（決定16 の2つ目の実装）', () => {
  it('作業ツリーを渡すと、その中でコマンドが走る', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    await writeFile(path.join(workdir, 'hello.txt'), 'MIKAN\n', 'utf8');

    const handle = await core.create(workdir);
    started.push(handle);
    expect(await core.status(handle)).toBe('ready');

    const result = await core.exec(handle, 'cat', ['hello.txt']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('MIKAN');
  }, 180_000);

  // **落ちたことと、走らせられなかったことは別の事実**（教訓13）。
  it('終了コードは結果として返る。失敗にしない', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    const handle = await core.create(workdir);
    started.push(handle);

    const result = await core.exec(handle, 'sh', ['-c', 'echo out; echo err >&2; exit 3']);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
  }, 180_000);

  // **覚えていない**ので、同じ作業ツリーからは同じ handle に着く（要件 B5・規則3）。
  it('何度呼んでも同じ handle。別のインスタンスでも同じ', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    const first = await core.create(workdir);
    started.push(first);

    expect(await core.create(workdir)).toBe(first);
    // 落ちて再起動したことにする。**引き継ぐものは何も無い。**
    expect(await new DockerEnvironmentCore(root, IMAGE).create(workdir)).toBe(first);
    expect(first).toBe(containerNameFor(path.resolve(workdir)));
  }, 180_000);

  // コンテナを止めても、`create` は**作り直さずに起こす**——中で入れたものが消える。
  it('止まっていたら、作り直さずに起こす', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    const handle = await core.create(workdir);
    started.push(handle);
    await core.exec(handle, 'sh', ['-c', 'echo mark > /tmp/mark']);

    await run('docker', ['stop', handle]);
    expect(await core.status(handle)).toBe('gone');

    expect(await core.create(workdir)).toBe(handle);
    expect((await core.exec(handle, 'cat', ['/tmp/mark'])).stdout).toContain('mark');
  }, 180_000);

  // `env-process` では何もしなかった口が、ここでは仕事をする（決定16 の到達性）。
  it('address はコンテナの IP を返す（127.0.0.1 ではない）', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    const handle = await core.create(workdir);
    started.push(handle);

    const address = await core.address(handle, 8080);
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+:8080$/);
    expect(address.startsWith('127.0.0.1')).toBe(false);
  }, 180_000);

  // **決定29の核心。** ホストからは届く（上のaddressテスト）が、コンテナから外部の
  // インターネットへは出られない——`--internal` なブリッジが既定であることを実測する。
  it('既定のネットワークでは外部インターネットに出られない', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    const handle = await core.create(workdir);
    started.push(handle);

    const result = await core.exec(handle, 'node', [
      '-e',
      "const net=require('net');" +
        "const s=net.createConnection({host:'8.8.8.8',port:53,timeout:3000});" +
        "s.on('connect',()=>{console.log('CONNECTED');s.end();});" +
        "s.on('timeout',()=>{console.log('BLOCKED-TIMEOUT');s.destroy();});" +
        "s.on('error',(e)=>{console.log('BLOCKED-ERROR',e.code);});",
    ]);
    expect(result.stdout).not.toContain('CONNECTED');
    expect(result.stdout).toMatch(/BLOCKED-/);
  }, 180_000);

  it('畳むとコンテナは消えるが、作業ツリーは残る（持ち主は repo）', async () => {
    const workdir = await mkdtemp(path.join(root, 'w-'));
    await writeFile(path.join(workdir, 'keep.txt'), 'x', 'utf8');
    const handle = await core.create(workdir);

    await core.destroy(handle);
    expect(await core.status(handle)).toBe('gone');
    // **二度畳んでも落ちない**（再開してこの段をやり直すことがある・要件 B5）。
    expect(await core.destroy(handle)).toContain('既に無い');
    await expect(readable(path.join(workdir, 'keep.txt'))).resolves.toBe(true);
  }, 180_000);

  // 握りつぶして作りに行かない（規則2）。作るのは Repo の仕事である。
  it('作業ディレクトリが無ければ、作らずに止まる', async () => {
    await expect(core.create('does-not-exist')).rejects.toThrow(/作業ディレクトリが無い/);
  });

  it('root の外は触れない', async () => {
    await expect(core.create('../..')).rejects.toThrow(/許された範囲の外/);
  });
});

async function readable(file: string): Promise<boolean> {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8').then(
    () => true,
    () => false,
  );
}
