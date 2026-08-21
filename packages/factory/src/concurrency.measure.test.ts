/**
 * **F4：平行数を上げると費用はどこで曲がるか**（Phase 2 の検証項目）。
 *
 *   BANTO_E2E=1 npx vitest run packages/factory/src/concurrency.measure.test.ts
 *
 * **課金が要るので既定では走らせない。** 消さないのは、上限を決め直すときに
 * 同じ手順でもう一度測れるようにするため。
 *
 * ## F4 は要件ではなく検証項目である
 *
 * 「線形以上に増えない」を守るべき要件として読むと、**線形を超えた時点で
 * 要件違反と誤判定する**（要件 F4 の注記・ADR 決定15）。枝が分かれて長く伸びれば
 * 共有プレフィックスの割合は減るので、いずれ線形に近づくのは自然な挙動である。
 * だからここは合否を出さない。**数値を出す。**
 *
 * ## なぜ平行数が費用に効くのか（測る前の見立て）
 *
 * 効くとしたらプロンプトキャッシュである。**同じ接頭辞を共有する要求を
 * 同時に投げると、どれも「他が書いている最中」を読めない**——
 * 直列なら2本目以降がキャッシュを読む。だから
 * **平行にすると速いが高い**はずで、`maxConcurrent` はその取引の位置を決める。
 *
 * **見立てであって結論ではない**（規則1）。測って、違ったらそう書く。
 *
 * ## 測った（2026-08-21・claude-haiku-4-5・小さな依頼）
 *
 * **見立ては外れた。** 平行にすると**速くて、しかも安い**：
 *
 * | 依頼 | maxConcurrent | 費用（直列比） | 時間（直列比） |
 * |---|---|---|---|
 * | 3 | 3 | 0.70〜0.83 倍 | 0.37〜0.46 倍 |
 * | 6 | 3 | 0.72 倍 | 0.34 倍 |
 * | 6 | 6 | 0.76 倍 | 0.22 倍 |
 *
 * **曲がる点は 6 までに現れなかった。** 見えたのは別の形で、
 * **費用は3あたりで改善が止まり、時間だけが伸び続ける**——
 * つまり3より上げて買えるのは速さであって、費用ではない。
 * いまの既定（3）はそこに合っているが、**それは後から分かったこと**で、
 * 3 という数字自体は計測から出たものではない。
 *
 * **この計測の限界**：仕事が小さく（1ファイル作って commit）、
 * 共有プレフィックスは system prompt とツール定義が支配的。各点1回。
 * 長く伸びる仕事で測ると、共有の割合が下がって別の形になりうる。
 *
 * **1回、6件中3件しか入らない回があった**（規則6）。実装者が LLM なので
 * 機構が壊れたのか依存がぶれたのかが分からず、**実装者を決まった動きにした
 * 同じ形の試験**（`acceptance.test.ts` の「6件を平行数6で投げても」）を
 * 12回走らせた——12/12。**機構ではなく依存のぶれ**である。
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { EventLog, contextSize, type BantoEvent } from '@banto/core';
import { connectInProcess, type ToolCaller } from '@banto/module-kit';
import { repoModule } from '@banto/module-repo';
import { envProcessModule } from '@banto/module-env-process';
import { workerModule } from '@banto/module-worker';

import { DECLARATION_PATH } from './declaration.js';
import { Factory } from './engine.js';
import { environmentPortOver, repoPortOver, workerImplementerOver } from './mcp-ports.js';

const run = promisify(execFile);
const enabled = process.env['BANTO_E2E'] === '1';

/** 同時に投げる依頼の数。**平行数を変えても、仕事の量は変えない。** */
const REQUESTS = Number(process.env['BANTO_MEASURE_REQUESTS'] ?? '3');
/** 測る平行数。1 が直列（キャッシュを最大に共有する側）。 */
const LEVELS = (process.env['BANTO_MEASURE_LEVELS'] ?? '1,3').split(',').map(Number);

interface Totals {
  readonly level: number;
  readonly merged: number;
  readonly turns: number;
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly peakContext: number;
  readonly wallMs: number;
  /** 落ちた Run の理由。**数だけ出すと、何が壊れたか分からない**（規則2）。 */
  readonly failures: readonly string[];
}

/** 本物の git リポジトリ。**宣言も本物**（仕様 §6）。 */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'banto-f4-'));
  const git = (...args: string[]) => run('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await mkdir(path.join(dir, '.banto'), { recursive: true });
  await writeFile(
    path.join(dir, DECLARATION_PATH),
    JSON.stringify({ test: { command: 'sh', args: ['-c', 'ls *.md >/dev/null 2>&1'] } }),
    'utf8',
  );
  await writeFile(path.join(dir, 'README.md'), '# f4\n', 'utf8');
  await git('add', '-A');
  await git('commit', '-m', 'first');
  return dir;
}

/** 1つの平行数で、同じ仕事をひととおり流す。 */
async function measure(level: number): Promise<Totals> {
  const root = await makeRepo();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-f4-log-'));
  const log = new EventLog(dataDir);

  process.env['BANTO_REPO_ROOT'] = root;
  process.env['BANTO_ENV_ROOT'] = root;

  const worker = workerModule({
    log,
    model: 'claude-haiku-4-5',
    mcpServers: [],
    toolsByModule: new Map(),
    extraAllowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    maxTurns: 12,
  });

  const callers: ToolCaller[] = [];
  const connect = async (server: unknown): Promise<ToolCaller> => {
    const caller = await connectInProcess(server as Parameters<typeof connectInProcess>[0]);
    callers.push(caller);
    return caller;
  };

  const factory = new Factory({
    log,
    repo: repoPortOver(await connect(repoModule.createServer())),
    environment: environmentPortOver(await connect(envProcessModule.createServer())),
    implementer: workerImplementerOver(await connect(worker.createServer()), (workdir) =>
      path.resolve(root, workdir),
    ),
    maxConcurrent: level,
  });

  const started = process.hrtime.bigint();
  try {
    for (let i = 0; i < REQUESTS; i += 1) {
      await factory.request({
        runId: `run-${i}`,
        channelId: 'c1',
        threadId: `t-${i}`,
        branch: `factory/note-${i}`,
        // **どの依頼も同じ形。** 中身の難しさで差が出ないようにする。
        request: `note-${i}.md というファイルを作り、1行だけ「note ${i}」と書いて git commit してください。`,
      });
    }
    await factory.advanceAll();
  } finally {
    for (const caller of callers) await caller.close().catch(() => undefined);
  }
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  const events = await log.read();
  const usage = events.filter((e) => e.type === 'turn.usage') as Extract<
    BantoEvent,
    { type: 'turn.usage' }
  >[];
  const sum = (pick: (u: (typeof usage)[number]['usage']) => number): number =>
    usage.reduce((n, e) => n + pick(e.usage), 0);

  return {
    level,
    // **現物で数える。** 何本 main に入ったかは git に聞く（規則1）。
    merged: await mergedCount(root),
    turns: usage.length,
    input: sum((u) => u.inputTokens),
    cacheWrite: sum((u) => u.cacheCreationInputTokens),
    cacheRead: sum((u) => u.cacheReadInputTokens),
    output: sum((u) => u.outputTokens),
    peakContext: usage.reduce((n, e) => Math.max(n, contextSize(e.usage)), 0),
    wallMs,
    failures: events
      .filter((e) => e.type === 'run.failed')
      .map((e) => `${e.runId} @${e.stage}: ${e.detail.slice(0, 300)}`),
  };
}

async function mergedCount(root: string): Promise<number> {
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  return stdout.split('\n').filter((f) => /^note-\d+\.md$/.test(f.trim())).length;
}

/** Haiku 4.5 の値付け（$1 / $5 per MTok、キャッシュ書き 1.25×・読み 0.1×）。 */
function usd(t: Totals): number {
  return (
    (t.input + t.cacheWrite * 1.25 + t.cacheRead * 0.1) / 1e6 + (t.output * 5) / 1e6
  );
}

describe.skipIf(!enabled)('F4：平行数と費用（Phase 2 の検証項目）', () => {
  it('平行数を上げたときの費用と時間を出す', async () => {
    const results: Totals[] = [];
    for (const level of LEVELS) results.push(await measure(level));

    const base = results[0];
    for (const t of results) {
      // eslint-disable-next-line no-console -- 計測は数値を返すのが仕事（CLAUDE.md の完了条件）
      console.log(
        [
          `【maxConcurrent=${t.level}】 依頼 ${REQUESTS} 件`,
          `  main に入った  : ${t.merged}/${REQUESTS}`,
          `  ターン数        : ${t.turns}`,
          `  入力(素)        : ${t.input}`,
          `  キャッシュ書き  : ${t.cacheWrite}`,
          `  キャッシュ読み  : ${t.cacheRead}`,
          `  出力            : ${t.output}`,
          `  文脈の最大      : ${t.peakContext}`,
          `  費用(USD)       : ${usd(t).toFixed(6)}` +
            (base === undefined || t === base
              ? '  ← 基準'
              : `  （基準の ${(usd(t) / usd(base)).toFixed(2)} 倍）`),
          ...(t.failures.length === 0 ? [] : [`  落ちた          : ${t.failures.join('\n                    ')}`]),
          `  かかった時間    : ${(t.wallMs / 1000).toFixed(1)} 秒` +
            (base === undefined || t === base
              ? ''
              : `  （基準の ${(t.wallMs / base.wallMs).toFixed(2)} 倍）`),
        ].join('\n'),
      );
    }

    // **合否は出さない**（F4 は検証項目であって要件ではない）。ただし
    // **仕事が済んでいない数値は比べる意味が無い**ので、そこだけ確かめる。
    for (const t of results) expect(t.merged).toBe(REQUESTS);
  }, 1_800_000);
});
