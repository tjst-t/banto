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
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog, fold } from '@banto/core';
import { connectInProcess, type ToolCaller } from '@banto/module-kit';
import { repoModule } from '@banto/module-repo';
import { envProcessModule } from '@banto/module-env-process';
import { publishNoneModule } from '@banto/module-publish-none';

import { DECLARATION_PATH } from './declaration.js';
import { Factory, foldRuns, reviewDecisionId, workdirOf } from './engine.js';
import { environmentPortOver, publishPortOver, repoPortOver } from './mcp-ports.js';
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
  // **テストの走らせ方はリポジトリが宣言する**（仕様 §6）。ここが本物の経路。
  // 中身は「そのファイルが在るか」——Factory はコマンドを組み立てない。
  await mkdir(path.join(dir, '.banto'), { recursive: true });
  await writeFile(
    path.join(dir, DECLARATION_PATH),
    JSON.stringify({ test: { command: 'sh', args: ['-c', 'ls *.txt >/dev/null 2>&1'] } }),
    'utf8',
  );
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

/** 取り込み先の宣言を差し替える（仕様 §6）。**commit するまで効かない。** */
async function declare(
  test: { command: string; args: string[] },
  preview?: { command: string; args: string[]; port: number },
): Promise<void> {
  await writeFile(
    path.join(root, DECLARATION_PATH),
    JSON.stringify({ test, ...(preview === undefined ? {} : { preview }) }),
    'utf8',
  );
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['commit', '-q', '-m', '宣言を変える'], { cwd: root });
}

function factory(overrides: Partial<ConstructorParameters<typeof Factory>[0]> = {}): Factory {
  return new Factory({
    log,
    repo: repoPortOver(repoCaller),
    environment: environmentPortOver(envCaller),
    implementer: implementer(),
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

  /**
   * **平行数を上げた機構だけを見る**（規則6）。F4 の計測で
   * 「6件中3件しか入らない」回があり、そこは実装者が LLM だったので
   * **機構が壊れているのか、依存がぶれたのかが分からなかった。**
   * ここは実装者を決まった動きにしてあるので、落ちたら機構の問題である。
   */
  it('6件を平行数6で投げても、6件とも入る', async () => {
    const f = factory({ maxConcurrent: 6 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => request(f, `n${i}`)),
    );

    await f.advanceAll();

    for (let i = 0; i < 6; i += 1) expect(await inMain(`n${i}.txt`)).toBe(true);
    expect((await log.read()).filter((e) => e.type === 'run.failed')).toEqual([]);
  }, 120_000);

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

describe('テストの走らせ方は、リポジトリが宣言する（仕様 §6）', () => {
  /**
   * **これは安全の試験である。** 作業ツリーではエージェントが働いていて、
   * そこには宣言のファイルも在る。そこから読んでいたら、
   * `test` を `true` に書き換えるだけで何を壊しても緑になる。
   */
  it('作業ツリーで宣言を書き換えても効かない。読むのは取り込み先', async () => {
    // 取り込み先の宣言を、**成果物が無ければ落ちる**ものに差し替える。
    // 既定の `ls *.txt` は fixture の shared.txt で常に通ってしまい、
    // 「読む先が違う」ことを区別できない。
    await declare({ command: 'sh', args: ['-c', 'test -f alpha.txt'] });

    const f = factory({
      implementer: {
        implement: async (plan) => {
          const cwd = path.join(root, plan.workdir);
          // 自分に都合のよい宣言に書き換え、**テストを通る成果物は作らない**。
          await writeFile(
            path.join(cwd, DECLARATION_PATH),
            JSON.stringify({ test: { command: 'sh', args: ['-c', 'true'] } }),
            'utf8',
          );
          await commit(cwd, 'テストを骨抜きにする');
        },
      },
    });
    await request(f, 'alpha');
    await f.advanceAll();

    // 取り込み先の宣言（*.txt が在るか）で測るので、落ちて止まる。
    const events = await log.read();
    const tested = events.filter((e) => e.type === 'run.tested');
    expect(tested.map((e) => e.passed)).toEqual([false]);
    expect(events.some((e) => e.type === 'run.failed')).toBe(true);
  }, 60_000);

  // 分からないまま `npm test` を当てると、テストの無いリポジトリで
  // 「0件が通った」になる（規則2）。
  it('宣言も設定も無ければ、テストの段で止まる', async () => {
    await run('git', ['rm', '-q', DECLARATION_PATH], { cwd: root });
    await run('git', ['commit', '-q', '-m', '宣言を消す'], { cwd: root });

    const f = factory();
    await request(f, 'alpha');
    await f.advanceAll();

    const failed = (await log.read()).filter((e) => e.type === 'run.failed');
    expect(failed[0]).toMatchObject({ stage: 'test' });
    expect(failed[0]?.detail).toContain('テストの走らせ方が分からない');
  }, 60_000);

  it('宣言が無くても、運用者が設定で引き受けられる', async () => {
    await run('git', ['rm', '-q', DECLARATION_PATH], { cwd: root });
    await run('git', ['commit', '-q', '-m', '宣言を消す'], { cwd: root });

    const f = factory({ test: { command: 'sh', args: ['-c', 'ls *.txt >/dev/null 2>&1'] } });
    await request(f, 'alpha');
    await f.advanceAll();

    expect(await inMain('alpha.txt')).toBe(true);
  }, 60_000);
});

/**
 * **同じ受け入れを、環境の実装を差し替えて通す**（決定16 の実装順）。
 *
 * 口が本当に実装から独立しているかは、`tools/list` が揃っていることでは分からない
 * ——**同じ Factory が、本物のコンテナの上で最後まで走る**ところまで見て分かる。
 * ここは docker を要るので、既定では走らせない：
 *
 *   BANTO_E2E=1 npx vitest run packages/factory
 */
describe.skipIf(process.env['BANTO_E2E'] !== '1')('環境を docker に差し替えても通る', () => {
  it('依頼が、コンテナの中でテストされて main に入る', async () => {
    process.env['BANTO_DOCKER_IMAGE'] ??= 'node:22-slim';
    const { envDockerModule } = await import('@banto/module-env-docker');
    const dockerCaller = await connectInProcess(envDockerModule.createServer());

    try {
      // **テストが本当にコンテナの中で走ったことを、テスト自身に証明させる。**
      // `/.dockerenv` はコンテナには在り、ホストには無い。これを外すと、
      // 環境を差し替えたつもりでホストで走っていても緑になる（規則1）。
      await declare({ command: 'sh', args: ['-c', 'test -f /.dockerenv && ls *.txt'] });

      const f = factory({ environment: environmentPortOver(dockerCaller) });
      await request(f, 'alpha');
      await f.advanceAll();

      expect((await log.read()).filter((e) => e.type === 'run.tested')[0]?.passed).toBe(true);
      expect(await inMain('alpha.txt')).toBe(true);
      // **コンテナも畳まれている**（teardown が docker の側で効いた）。
      expect(await hasWorktree('factory/alpha')).toBe(false);
    } finally {
      await dockerCaller.close();
      // 自分が作ったものだけ消す。落ちた回のコンテナを残さない。
      await run('sh', [
        '-c',
        `docker ps -aq --filter name=banto-alpha- | xargs -r docker rm -f`,
      ]).catch(() => undefined);
    }
  }, 300_000);
});

/**
 * **公開は段ではなく、確認を待つときに使う任意の枝**（仕様 §5.2）。
 *
 * ここも本物の MCP を通す——`publish-none` は「公開しないことを正直に言う」実装で、
 * 返す URL に**届く範囲**が付いてくる。それが人の確認に出るところまで見る。
 */
describe('動いているものを人に見せる（仕様 §3・§5.2）', () => {
  let publishCaller: ToolCaller;

  beforeEach(async () => {
    publishCaller = await connectInProcess(publishNoneModule.createServer());
  });
  afterEach(async () => {
    await publishCaller.close();
  });

  const withPreview = () =>
    declare(
      { command: 'sh', args: ['-c', 'ls *.txt >/dev/null 2>&1'] },
      { command: 'sh', args: ['-c', 'true'], port: 3000 },
    );

  it('確認に、見る URL と届く範囲が付く', async () => {
    await withPreview();
    const f = factory({ needsReview: true, publish: publishPortOver(publishCaller) });
    await request(f, 'alpha');
    await f.advanceAll();

    const pending = fold(await log.read()).pendingDecisions.get(reviewDecisionId('run-alpha'));
    expect(pending?.question).toContain('見る: http://127.0.0.1:3000');
    // **「公開した」と「届く」は別物。** 範囲を書かないと、外から開けると誤解される。
    expect(pending?.question).toContain('届く範囲: banto-host-only');
  }, 60_000);

  // 待たない既定（要件 B4）で URL を生やすと、誰も見ないものが残り続ける。
  it('確認を待たない設定では、公開しない', async () => {
    await withPreview();
    const f = factory({ publish: publishPortOver(publishCaller) });
    await request(f, 'alpha');
    await f.advanceAll();

    expect(await inMain('alpha.txt')).toBe(true);
    expect((await log.read()).some((e) => e.type === 'decision.requested')).toBe(false);
  }, 60_000);

  // 宣言していないなら、枝には入らない。**空の URL を出さない。**
  it('preview を宣言していなければ、確認に URL は付かない', async () => {
    const f = factory({ needsReview: true, publish: publishPortOver(publishCaller) });
    await request(f, 'alpha');
    await f.advanceAll();

    const pending = fold(await log.read()).pendingDecisions.get(reviewDecisionId('run-alpha'));
    expect(pending?.question).not.toContain('見る');
  }, 60_000);

  // 仕様と実態の食い違いは、黙ってどちらかに寄せずに人へ上げる（規則8）。
  it('preview は在るのに公開手段が無ければ、確認にそう書く', async () => {
    await withPreview();
    const f = factory({ needsReview: true });
    await request(f, 'alpha');
    await f.advanceAll();

    const pending = fold(await log.read()).pendingDecisions.get(reviewDecisionId('run-alpha'));
    expect(pending?.question).toContain('公開手段が紐づいていない');
  }, 60_000);

  // 取り込めるものを、前置きが失敗しただけで止めない。**理由は人に見せる。**
  it('preview が落ちても Run は止まらない。理由が確認に出る', async () => {
    await declare(
      { command: 'sh', args: ['-c', 'ls *.txt >/dev/null 2>&1'] },
      { command: 'sh', args: ['-c', 'echo こわれた >&2; exit 7'], port: 3000 },
    );
    const f = factory({ needsReview: true, publish: publishPortOver(publishCaller) });
    await request(f, 'alpha');
    await f.advanceAll();

    const pending = fold(await log.read()).pendingDecisions.get(reviewDecisionId('run-alpha'));
    expect(pending?.question).toContain('exit=7');
    expect(pending?.question).toContain('こわれた');
    // 確認は立っている＝人は取り込むかどうかを決められる。
    expect(pending?.options?.map((o) => o.id)).toEqual(['approve', 'reject']);
  }, 60_000);
});

describe('人を待つ設定（要件 B4）', () => {
  it('待つ設定なら、承認が出るまで取り込まない', async () => {
    const f = factory({ needsReview: true });
    await request(f, 'alpha');

    await f.advanceAll();
    expect(await inMain('alpha.txt')).toBe(false);
    const pending = fold(await log.read()).pendingDecisions.get(reviewDecisionId('run-alpha'));
    expect(pending).toBeDefined();
    // 選択肢が出ている。**選ばせるが、これに限らない。**
    expect(pending?.options?.map((o) => o.id)).toEqual(['approve', 'reject']);

    // 選択肢を選ばない答えは、まだ答えではない——聞き直す（規則2）。
    await log.append({
      type: 'decision.resolved',
      decisionId: reviewDecisionId('run-alpha'),
      optionId: null,
      answer: 'テストのカバレッジはどうなってる？',
    });
    await f.advanceAll();
    expect(await inMain('alpha.txt')).toBe(false);
    expect(fold(await log.read()).pendingDecisions.has(reviewDecisionId('run-alpha'))).toBe(true);

    // 選択肢を選んだら、続きは同じ機構で進む。
    await log.append({
      type: 'decision.resolved',
      decisionId: reviewDecisionId('run-alpha'),
      optionId: 'approve',
      answer: '取り込む',
    });
    await f.advanceAll();
    expect(await inMain('alpha.txt')).toBe(true);
  }, 60_000);

  it('却下されたら取り込まず、作業ツリーを畳んで終わる', async () => {
    const f = factory({ needsReview: true });
    await request(f, 'alpha');
    await f.advanceAll();

    await log.append({
      type: 'decision.resolved',
      decisionId: reviewDecisionId('run-alpha'),
      optionId: 'reject',
      answer: '取り込まない',
    });
    await f.advanceAll();
    await f.advanceAll(); // teardown → rejected

    expect(await inMain('alpha.txt')).toBe(false);
    // 枝は残る。**捨てるのではなく、取り込まないだけ。**
    const { stdout } = await run('git', ['branch', '--list', 'factory/alpha'], { cwd: root });
    expect(stdout.trim()).toContain('factory/alpha');
    // 失敗として記録しない——機構は正しく動いた。
    expect((await log.read()).filter((e) => e.type === 'run.failed')).toHaveLength(0);
  }, 60_000);
});
