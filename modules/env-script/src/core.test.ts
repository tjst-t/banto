/**
 * **口の検査**（決定16・仕様 §2.4）。
 *
 * シェルスクリプトで環境の口を満たせるか、本物のスクリプトを置いて確かめる。
 * **満たせないなら、口が大きすぎるということ。** ここで露見してほしい——
 * 実際に露見した：4本のつもりで始めて、`status` が足りなかった（仕様 §8-3）。
 *
 * 承認台帳も本物のイベントログから畳む——偽物は本物の制約を持たない（教訓1）。
 */

import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { APPROVE, EventLog, foldApprovals, ledgerOf, type ApprovalLedger } from '@banto/core';

import { ScriptEnvironmentCore, UnapprovedScriptError } from './core.js';

/** リポジトリが置くスクリプト。**これで足りるかが、この試験の問いそのもの。** */
const SCRIPTS: Record<string, string> = {
  'script/env-create': `#!/bin/sh
# 環境の実体を作って、handle を1行で返す。
d="$(mktemp -d)"
printf '%s' "$d"
`,
  'script/env-status': `#!/bin/sh
# $1 = handle。使えるかどうかだけを答える。
if [ -d "$1" ]; then printf 'ready'; else printf 'gone'; fi
`,
  'script/env-exec': `#!/bin/sh
# $1 = handle、以降がコマンド。**終了コードはそのまま通す。**
h="$1"; shift
cd "$h" || exit 1
exec "$@"
`,
  'script/env-address': `#!/bin/sh
# $1 = handle、$2 = port。同じホストなので何もしない。
printf '127.0.0.1:%s' "$2"
`,
  'script/env-destroy': `#!/bin/sh
rm -rf "$1"
printf 'destroyed'
`,
};

async function makeRepo(overrides: Record<string, string> = {}): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'banto-envscript-'));
  await mkdir(path.join(repo, '.banto'), { recursive: true });
  await mkdir(path.join(repo, 'script'), { recursive: true });
  await writeFile(
    path.join(repo, '.banto/repo.json'),
    JSON.stringify({
      environment: {
        kind: 'script',
        create: 'script/env-create',
        status: 'script/env-status',
        exec: 'script/env-exec',
        address: 'script/env-address',
        destroy: 'script/env-destroy',
      },
    }),
    'utf8',
  );
  for (const [rel, body] of Object.entries({ ...SCRIPTS, ...overrides })) {
    const target = path.join(repo, rel);
    await writeFile(target, body, 'utf8');
    await chmod(target, 0o755);
  }
  return repo;
}

/** 本物のログに承認を積んで、畳んで台帳にする。 */
async function approveAll(core: ScriptEnvironmentCore, repo: string): Promise<ApprovalLedger> {
  const log = new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-approve-')));
  for (const verb of ['create', 'status', 'exec', 'address', 'destroy'] as const) {
    const { subject, print } = await core.fingerprintOf(repo, verb);
    await log.append({
      type: 'decision.resolved',
      decisionId: `approval:${subject}:${print}`,
      optionId: null,
      answer: APPROVE,
    });
  }
  return ledgerOf(foldApprovals(await log.read()));
}

/** 承認済みの core を組む。台帳を得るのに一度 core が要るので、2段構えになる。 */
async function approvedCore(repo: string): Promise<ScriptEnvironmentCore> {
  const probe = new ScriptEnvironmentCore([repo], { isApproved: () => false });
  return new ScriptEnvironmentCore([repo], await approveAll(probe, repo));
}

describe('門① 許可されたリポジトリだけ', () => {
  it('許可されていなければ、設定を読むところで断る', async () => {
    const repo = await makeRepo();
    const core = new ScriptEnvironmentCore([], { isApproved: () => true });
    await expect(core.create(repo)).rejects.toThrow(/自前の環境を許可されていない/);
  });

  // 根の内側を許すと、許した1つの下にもう1つ置くだけで通ってしまう。
  it('許可したリポジトリの「内側」の別リポジトリは通らない', async () => {
    const repo = await makeRepo();
    const core = new ScriptEnvironmentCore([repo], { isApproved: () => true });
    await expect(core.create(path.join(repo, 'nested'))).rejects.toThrow(/許可されていない/);
  });
});

describe('門② 承認していない内容は走らせない', () => {
  it('承認が無ければ走らない。指紋を値で持って返す（教訓13）', async () => {
    const repo = await makeRepo();
    const core = new ScriptEnvironmentCore([repo], { isApproved: () => false });

    const error = await core.create(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnapprovedScriptError);
    expect((error as UnapprovedScriptError).print).toMatch(/^[0-9a-f]{16}$/);
    expect((error as UnapprovedScriptError).subject).toContain('script/env-create');
  });

  // 名前で承認すると、一度通ったファイルが以後どう書き換わっても通ってしまう。
  it('1バイト書き換えると承認が外れる', async () => {
    const repo = await makeRepo();
    const core = await approvedCore(repo);
    expect(await core.create(repo)).toMatch(/^\//);

    await writeFile(path.join(repo, 'script/env-create'), `${SCRIPTS['script/env-create']}\n`, 'utf8');
    await expect(core.create(repo)).rejects.toBeInstanceOf(UnapprovedScriptError);
  });
});

describe('シェルスクリプトで口が満たせる', () => {
  it('create → status → exec → address → destroy が通る', async () => {
    const repo = await makeRepo();
    const core = await approvedCore(repo);

    const handle = await core.create(repo);
    expect(handle).toMatch(/^\//);

    expect(await core.status(repo, handle)).toBe('ready');

    const ran = await core.exec(repo, handle, ['sh', '-c', 'printf hello']);
    expect(ran).toMatchObject({ exitCode: 0, stdout: 'hello' });

    expect(await core.address(repo, handle, 4173)).toBe('127.0.0.1:4173');
    expect(await core.destroy(repo, handle)).toBe('destroyed');

    // 畳んだあとは gone。Factory の再開判定はこれを見る（仕様 §5.3）。
    expect(await core.status(repo, handle)).toBe('gone');
  });

  // 知らない値を勝手ににぎりつぶして ready に寄せない（規則2）。
  it('status が ready でも gone でもなければ止まる', async () => {
    const repo = await makeRepo({ 'script/env-status': "#!/bin/sh\nprintf たぶん\n" });
    const core = await approvedCore(repo);
    await expect(core.status(repo, '/tmp')).rejects.toThrow(/ready でも gone でもない/);
  });

  // 中のコマンドが落ちたことと、スクリプトを走らせられなかったことは別の事実。
  it('exec の非ゼロは結果として返る', async () => {
    const repo = await makeRepo();
    const core = await approvedCore(repo);
    const handle = await core.create(repo);

    const ran = await core.exec(repo, handle, ['sh', '-c', 'exit 3']);
    expect(ran.exitCode).toBe(3);
  });

  it('exec 以外の非ゼロは失敗として投げる（規則2）', async () => {
    const repo = await makeRepo({ 'script/env-create': '#!/bin/sh\necho こわれた >&2\nexit 1\n' });
    const core = await approvedCore(repo);
    await expect(core.create(repo)).rejects.toThrow(/create が失敗した（exit=1）.*こわれた/s);
  });

  // 起動できないときは close ではなく error が来る。作り物の約束なしに区別できる。
  it('起動できないことは、失敗して終わったことと区別される', async () => {
    const repo = await makeRepo({ 'script/env-create': '#!/bin/sh\ntrue\n' });
    await chmod(path.join(repo, 'script/env-create'), 0o644);
    const core = await approvedCore(repo);
    await expect(core.create(repo)).rejects.toThrow(/スクリプトを起動できない/);
  });
});

describe('設定の検査', () => {
  it('動詞が欠けていたら止まる。黙って何もしない動詞を作らない', async () => {
    const repo = await makeRepo();
    await writeFile(
      path.join(repo, '.banto/repo.json'),
      JSON.stringify({ environment: { kind: 'script', create: 'script/env-create' } }),
      'utf8',
    );
    const core = new ScriptEnvironmentCore([repo], { isApproved: () => true });
    await expect(core.config(repo)).rejects.toThrow(/動詞が足りない: status, exec, address, destroy/);
  });

  it('kind が script でなければ止まる', async () => {
    const repo = await makeRepo();
    await writeFile(
      path.join(repo, '.banto/repo.json'),
      JSON.stringify({ environment: { kind: 'docker' } }),
      'utf8',
    );
    const core = new ScriptEnvironmentCore([repo], { isApproved: () => true });
    await expect(core.config(repo)).rejects.toThrow(/kind が "script" でない/);
  });

  it('スクリプトがリポジトリの外を指したら止まる', async () => {
    const repo = await makeRepo();
    await writeFile(
      path.join(repo, '.banto/repo.json'),
      JSON.stringify({
        environment: {
          kind: 'script',
          create: '../../../bin/sh',
          status: 'script/env-status',
          exec: 'script/env-exec',
          address: 'script/env-address',
          destroy: 'script/env-destroy',
        },
      }),
      'utf8',
    );
    const core = new ScriptEnvironmentCore([repo], { isApproved: () => true });
    await expect(core.create(repo)).rejects.toThrow(/リポジトリの外を指している/);
  });
});
