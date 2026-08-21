/**
 * **要件 B の受け入れそのもの**（要件 B・Phase 2 の完了条件）。
 *
 * > 3つの依頼を同時に投げて3つとも main に入る。1つ失敗させても他の2つは進む。
 * > 落として再起動しても、途中から続く。
 *
 * **偽物を使わない**（教訓1）。git も、環境も、イベントログも本物である。
 * 置き換えるのは実装者（LLM）だけで、これは engine の**依存**であって
 * 試験の対象ではない——対象は「順序づけ・再開・衝突の解決」の機構である。
 *
 * **依存は本物の MCP を通す**（要件 C13・決定17）。以前はここで `RepoCore` と
 * `ProcessEnvironmentCore` を直接握っていたので、**役割（capability）の機構に
 * 本物の利用者がいなかった**——「実装は差し替えられる」が試験の中だけの話だった。
 * いまは repo も environment も、他のモジュールと同じ口を通る。
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog, fold } from '@banto/core';
import { connectInProcess, type ToolCaller } from '@banto/module-kit';
import { repoModule } from '@banto/module-repo';
import { envProcessModule } from '@banto/module-env-process';

import { Factory, foldRuns, reviewDecisionId, workdirOf } from './engine.js';
import { environmentPortOver, repoPortOver } from './mcp-ports.js';
import type { Implementer } from './ports.js';

const run = promisify(execFile);

let root: string;
let log: EventLog;
/** **本物の MCP サーバに繋いだ口。** ここを直接の呼び出しに戻すと、試験が何も証明しない。 */
let repoCaller: ToolCaller;
let envCaller: ToolCaller;

/** 本物の git リポジトリを1つ用意する。 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'banto-factory-'));
  const git = (...args: string[]) => run('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  // 離れた行を触らせるための下地。同じファイルでも region が違えば git が自動で解ける。
  await writeFile(
    path.join(dir, 'shared.txt'),
    Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    'utf8',
  );
  await git('add', '-A');
  await git('commit', '-m', 'first');
  return dir;
}

/**
 * 決まった動きをする実装者。**作業ツリーで本物の commit を作る。**
 *
 * `broken` に入れた依頼は、わざと commit を作らない——失敗が他を塞がないことを
 * 確かめるため。
 */
function implementer(broken: ReadonlySet<string> = new Set()): Implementer {
  return {
    implement: async (plan) => {
      if (broken.has(plan.request)) return;
      const cwd = path.join(root, plan.workdir);
      await writeFile(path.join(cwd, `${plan.request}.txt`), `${plan.request}\n`, 'utf8');
      await commit(cwd, plan.request);
    },
  };
}

async function commit(cwd: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['commit', '-m', message], { cwd });
}

/** 同じファイルの、指定した行だけを書き換える実装者。 */
function lineEditor(lineOf: Record<string, number>): Implementer {
  return {
    implement: async (plan) => {
      const cwd = path.join(root, plan.workdir);
      const file = path.join(cwd, 'shared.txt');
      const lines = (await readFile(file, 'utf8')).split('\n');
      const index = (lineOf[plan.request] ?? 1) - 1;
      lines[index] = `${lines[index] ?? ''} <- ${plan.request}`;
      await writeFile(file, lines.join('\n'), 'utf8');
      await commit(cwd, plan.request);
    },
  };
}

/**
 * **main に本当に入ったか**を、成果物で見る。
 *
 * `merge-base --is-ancestor` では見ない——**空のブランチでも真になる**ので、
 * 「まだ何もしていない」と「取り込み済み」を区別できない（engine の同じ注記を見よ）。
 */
/** 作業ツリーが在るかを、**git に直接**聞く（試験の側は口を通さない）。 */
async function hasWorktree(branch: string): Promise<boolean> {
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  return stdout.includes(path.join(root, workdirOf(branch)));
}

async function inMain(file: string): Promise<boolean> {
  return run('git', ['cat-file', '-e', `main:${file}`], { cwd: root }).then(
    () => true,
    () => false,
  );
}

/** テストは「そのファイルが在るか」。**コマンドはリポジトリが決める**（仕様 §6）。 */
const TEST = { command: 'sh', args: ['-c', 'ls *.txt >/dev/null 2>&1'] };

function factory(overrides: Partial<ConstructorParameters<typeof Factory>[0]> = {}): Factory {
  return new Factory({
    log,
    repo: repoPortOver(repoCaller),
    environment: environmentPortOver(envCaller),
    implementer: implementer(),
    test: TEST,
    ...overrides,
  });
}

async function request(f: Factory, name: string): Promise<void> {
  await f.request({
    runId: `run-${name}`,
    channelId: 'c1',
    threadId: `t-${name}`,
    branch: `factory/${name}`,
    request: name,
  });
}

beforeEach(async () => {
  root = await makeRepo();
  log = new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-factory-log-')));
  // モジュールは root を環境変数から受け取る（既定値を持たない・requiredRoot）。
  process.env['BANTO_REPO_ROOT'] = root;
  process.env['BANTO_ENV_ROOT'] = root;
  repoCaller = await connectInProcess(repoModule.createServer());
  envCaller = await connectInProcess(envProcessModule.createServer());
});

afterEach(async () => {
  await repoCaller.close();
  await envCaller.close();
});

describe('要件 B の受け入れ', () => {
  it('3つの依頼を同時に投げて、3つとも main に入る', async () => {
    const f = factory();
    await Promise.all(['alpha', 'beta', 'gamma'].map((n) => request(f, n)));

    await f.advanceAll();

    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(await inMain(`${name}.txt`)).toBe(true);
    }
    // 後片付けまで済んでいる。作業ツリーが残らない。
    for (const name of ['alpha', 'beta', 'gamma']) {
      expect(await hasWorktree(`factory/${name}`)).toBe(false);
    }
    // main に3つの変更が入っている。
    const { stdout } = await run('git', ['ls-files'], { cwd: root });
    expect(stdout).toContain('alpha.txt');
    expect(stdout).toContain('beta.txt');
    expect(stdout).toContain('gamma.txt');
  }, 60_000);

  it('1つ失敗させても、他の2つは進む', async () => {
    const f = factory({ implementer: implementer(new Set(['beta'])) });
    for (const n of ['alpha', 'beta', 'gamma']) await request(f, n);

    await f.advanceAll();

    expect(await inMain('alpha.txt')).toBe(true);
    expect(await inMain('gamma.txt')).toBe(true);
    expect(await inMain('beta.txt')).toBe(false);

    // 失敗は記録され、人に上がる（要件 A6）。**列は止まっていない。**
    const events = await log.read();
    expect(events.filter((e) => e.type === 'run.failed')).toHaveLength(1);
    expect(fold(events).pendingDecisions.has('run-failed:run-beta')).toBe(true);
  }, 60_000);

  it('落として再起動しても、途中から続く', async () => {
    const first = factory();
    for (const n of ['alpha', 'beta']) await request(first, n);

    // 途中まで進める（各 Run を2段ずつ）。ここで「落ちた」ことにする。
    for (let i = 0; i < 2; i += 1) {
      for (const r of foldRuns(await log.read())) await first.step(r);
    }
    expect(await inMain('alpha.txt')).toBe(false);

    // **別のインスタンスで続ける。** 覚えていたものは何も引き継がない。
    const restarted = factory();
    await restarted.advanceAll();

    expect(await inMain('alpha.txt')).toBe(true);
    expect(await inMain('beta.txt')).toBe(true);
  }, 60_000);
});

describe('順序づけと衝突の解決（要件 B7）', () => {
  // **同じ main を触る**が、region が違うので git が自動で解ける。
  // ここで見たいのは、取り込みが1本の列になっていて両方が入ること。
  it('同じファイルを触る2つの依頼が、順に取り込まれる', async () => {
    const f = factory({ implementer: lineEditor({ alpha: 2, beta: 11 }) });
    for (const n of ['alpha', 'beta']) await request(f, n);

    await f.advanceAll();

    const { stdout } = await run('git', ['show', 'main:shared.txt'], { cwd: root });
    expect(stdout).toContain('<- alpha');
    expect(stdout).toContain('<- beta');
    expect((await log.read()).filter((e) => e.type === 'run.failed')).toHaveLength(0);
  }, 60_000);

  /**
   * **機械に解けない衝突は、機械が解いてはいけない。**
   *
   * 同じ行を別々に書き換えると、載せ直しても解けない。そのとき Factory は
   * **黙ってどちらかを採らず**（規則2・規則8）、失敗を記録して人に上げる。
   * そして**列は止まらない**——後ろの依頼はそのまま入る（要件 B の受け入れ）。
   */
  it('解けない衝突は、人に上げて止まる。列は塞がない', async () => {
    const f = factory({ implementer: lineEditor({ alpha: 5, beta: 5, gamma: 9 }) });
    for (const n of ['alpha', 'beta', 'gamma']) await request(f, n);

    await f.advanceAll();

    const { stdout } = await run('git', ['show', 'main:shared.txt'], { cwd: root });
    expect(stdout).toContain('<- alpha');
    expect(stdout).toContain('<- gamma'); // ← 後ろは塞がれていない
    expect(stdout).not.toContain('<- beta');

    const events = await log.read();
    const failed = events.filter((e) => e.type === 'run.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ runId: 'run-beta', stage: 'merge' });
    // 判断待ちに立っている（要件 A6）。**黙って落ちない。**
    expect(fold(events).pendingDecisions.has('run-failed:run-beta')).toBe(true);
  }, 60_000);
});

describe('人を待つ設定（要件 B4）', () => {
  it('待つ設定なら、承認が出るまで取り込まない', async () => {
    const f = factory({ needsReview: true });
    await request(f, 'alpha');

    await f.advanceAll();
    expect(await inMain('alpha.txt')).toBe(false);
    expect(fold(await log.read()).pendingDecisions.has(reviewDecisionId('run-alpha'))).toBe(true);

    // 人が答えたら、続きは同じ機構で進む。
    await log.append({
      type: 'decision.resolved',
      decisionId: reviewDecisionId('run-alpha'),
      answer: 'approve',
    });
    await f.advanceAll();
    expect(await inMain('alpha.txt')).toBe(true);
  }, 60_000);
});
