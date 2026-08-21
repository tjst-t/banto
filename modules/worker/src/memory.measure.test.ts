/**
 * **worker は記憶を持つべきか**を、本物で測る（ADR 決定17 の未決）。
 *
 *   BANTO_E2E=1 npx vitest run modules/worker/src/memory.measure.test.ts
 *
 * **課金が要るので既定では走らせない。** 消さないのは、この裁定を覆すときに
 * 同じ手順でもう一度測れるようにするため。
 *
 * ## 何を再現するか
 *
 * セッション再開と memoryless が**実際に分かれる場面は1つしかない**——
 * `implement` は `!hasCommits` のときだけ走るので、通常は Run につき1回で、
 * 1回目は（前のセッションが無いので）どちらの設定でも同じものが走る。
 * 分かれるのは**途中で落ちて、同じ Thread でもう一度 implement が走るとき**
 * （＝要件 B5）だけである。
 *
 * だから「落ちた」を `maxTurns` で作る：1回目を commit に届かない turn 数で
 * 打ち切り、2回目を通常の turn 数で走らせる。**2回目だけを測る**
 * ——1回目は両方の腕で同じなので、比べる意味が無い。
 *
 * ## 何を測るか
 *
 * 1. **仕事が済んだか**（commit が在るか・現物で見る。自己申告を採らない・規則1）
 * 2. **費用**（turn.usage の4種を全部。丸めた1つの数にしない）
 * 3. **文脈の大きさ**（要件 F1 が見ている軸そのもの）
 */

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { EventLog, contextSize } from '@banto/core';

import { WorkerCore } from './core.js';

const run = promisify(execFile);
const enabled = process.env['BANTO_E2E'] === '1';

/** 各腕を何回走らせるか。**1回では分からない**（規則6 の考え方）。 */
const TRIALS = Number(process.env['BANTO_MEASURE_TRIALS'] ?? '3');

/** 複数手かかり、済んだかどうかが**現物で分かる**仕事。 */
const REQUEST =
  'shared.txt の各行の末尾に、その行の番号を " #N" の形で足してください（1行目なら " #1"）。' +
  '全12行すべてに足したうえで、git add と git commit をしてください。';

/** 1回目を commit に届かせないための打ち切り。**ここで「落ちた」を作る。** */
const CRASH_AT_TURN = Number(process.env['BANTO_MEASURE_CRASH_TURNS'] ?? '3');

interface Sample {
  readonly resumed: boolean;
  readonly committed: boolean;
  readonly complete: boolean;
  readonly turns: number;
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
  /** 最後のターンの文脈の大きさ。要件 F1 が見ている軸。 */
  readonly peakContext: number;
  /**
   * **つまみが本当に効いたか。** 再開したなら、2回目は1回目と同じセッションを
   * 続けているはずである。ここを確かめないと、**効いていない設定の差を
   * 腕の差として読む**ことになる（規則1：測る前に犯人を決めない）。
   */
  readonly sameSession: boolean;
  /**
   * 1回目が commit まで届いてしまった回。**この回は2回目にやる仕事が無い**ので、
   * 費用の比較には入れない——混ぜると「安く済んだ」に見える（規則2）。
   */
  readonly firstFinished: boolean;
}

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'banto-memory-'));
  const git = (...args: string[]) => run('git', args, { cwd: dir });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await writeFile(
    path.join(dir, 'shared.txt'),
    Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    'utf8',
  );
  await git('add', '-A');
  await git('commit', '-m', 'first');
  return dir;
}

function workerOn(log: EventLog, maxTurns: number, resumeConversation: boolean): WorkerCore {
  return new WorkerCore({
    log,
    model: 'claude-haiku-4-5',
    mcpServers: [],
    toolsByModule: new Map(),
    // 実装には編集とコマンド実行が要る（要件 D4：既定を持たせず、明示的に許す）。
    extraAllowedTools: ['Read', 'Edit', 'Write', 'Bash'],
    maxTurns,
    resumeConversation,
  });
}

/** 1回分。**落ちた1回目**を作ってから、2回目だけを測る。 */
async function trial(resumed: boolean, index: number): Promise<Sample> {
  const cwd = await freshRepo();
  const log = new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-memory-log-')));
  const threadId = `t-${resumed ? 'resume' : 'fresh'}-${index}`;
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'measure' });
  await log.append({ type: 'thread.created', threadId, channelId: 'c1', title: '計測' });

  // 1回目。**commit に届く前に打ち切る**＝落ちたことにする。両腕で同じもの。
  const initialHead = await headOf(cwd);
  const first = `${threadId}:implement`;
  await workerOn(log, CRASH_AT_TURN, false)
    .work({ threadId, queryId: first, request: REQUEST, cwd })
    .catch(() => undefined);

  // 2回目。**ここだけが腕によって変わる。**
  const second = `${threadId}:implement-2`;
  const before = await headOf(cwd);
  const firstFinished = before !== initialHead;
  await workerOn(log, 40, resumed)
    .work({ threadId, queryId: second, request: REQUEST, cwd })
    .catch(() => undefined);

  const all = await log.read();
  const handles = all.filter((e) => e.type === 'thread.session');
  const firstHandle = handles.find((e) => e.queryId === first)?.sessionHandle ?? null;
  const secondHandle = handles.find((e) => e.queryId === second)?.sessionHandle ?? null;

  const events = all.filter(
    (e) => e.type === 'turn.usage' && e.queryId === second,
  ) as Extract<Awaited<ReturnType<EventLog['read']>>[number], { type: 'turn.usage' }>[];

  const sum = (pick: (u: (typeof events)[number]['usage']) => number): number =>
    events.reduce((n, e) => n + pick(e.usage), 0);

  return {
    resumed,
    // **現物で見る。** 「やった」と言われたかどうかは数えない（規則1）。
    committed: (await headOf(cwd)) !== before,
    complete: await allLinesNumbered(cwd),
    turns: events.length,
    input: sum((u) => u.inputTokens),
    cacheWrite: sum((u) => u.cacheCreationInputTokens),
    cacheRead: sum((u) => u.cacheReadInputTokens),
    output: sum((u) => u.outputTokens),
    peakContext: events.reduce((n, e) => Math.max(n, contextSize(e.usage)), 0),
    sameSession: firstHandle !== null && firstHandle === secondHandle,
    firstFinished,
  };
}

async function headOf(cwd: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

/** 仕事が**本当に**済んだか。commit が在ることと、中身が揃っていることは別。 */
async function allLinesNumbered(cwd: string): Promise<boolean> {
  const { stdout } = await run('git', ['show', 'HEAD:shared.txt'], { cwd }).catch(() => ({
    stdout: '',
  }));
  const lines = stdout.split('\n').filter((l) => l.trim() !== '');
  return lines.length === 12 && lines.every((l, i) => l.endsWith(` #${i + 1}`));
}

function report(label: string, all: readonly Sample[]): void {
  // **1回目で終わっていた回を外して数える。** 外した数は隠さず出す。
  const samples = all.filter((s) => !s.firstFinished);
  const n = samples.length;
  if (n === 0) {
    // eslint-disable-next-line no-console -- 計測は数値を返すのが仕事
    console.log(`【${label}】 ${all.length} 回すべて1回目で終わった。打ち切りを早める`);
    return;
  }
  const avg = (pick: (s: Sample) => number): string =>
    (samples.reduce((t, s) => t + pick(s), 0) / n).toFixed(0);
  const count = (pick: (s: Sample) => boolean): string => `${samples.filter(pick).length}/${n}`;

  // eslint-disable-next-line no-console -- 計測は数値を返すのが仕事（CLAUDE.md の完了条件）
  console.log(
    [
      `【${label}】 ${n} 回（${all.length} 回中 ${all.length - n} 回は1回目で終わったので除外）`,
      `  commit した        : ${count((s) => s.committed)}`,
      `  仕事が揃っていた   : ${count((s) => s.complete)}`,
      `  ターン数(平均)     : ${avg((s) => s.turns)}`,
      `  入力(素)           : ${avg((s) => s.input)}`,
      `  キャッシュ書き     : ${avg((s) => s.cacheWrite)}`,
      `  キャッシュ読み     : ${avg((s) => s.cacheRead)}`,
      `  出力               : ${avg((s) => s.output)}`,
      `  文脈の最大         : ${avg((s) => s.peakContext)}`,
      `  同じセッション     : ${count((s) => s.sameSession)}  ← つまみが効いた回数`,
    ].join('\n'),
  );
}

describe.skipIf(!enabled)('worker の記憶（ADR 決定17 の未決）', () => {
  it('落ちた後の2回目を、再開あり／なしで比べる', async () => {
    const resumed: Sample[] = [];
    const fresh: Sample[] = [];

    // **腕を交互に走らせる。** 片方をまとめて走らせると、その間の
    // 混み具合や日付の違いが、腕の差として現れる。
    for (let i = 0; i < TRIALS; i += 1) {
      resumed.push(await trial(true, i));
      fresh.push(await trial(false, i));
    }

    report('セッション再開', resumed);
    report('memoryless', fresh);

    // **数値を返すのが仕事**だが、1つだけ落ちてほしくないことがある：
    // memoryless が「落ちた後の続きをやれない」なら、費用を比べる意味が無い。
    expect(fresh.some((s) => s.committed || s.firstFinished)).toBe(true);
    // **つまみが効いていない計測を、結果として読ませない**（規則1）。
    expect(resumed.every((s) => s.sameSession)).toBe(true);
    expect(fresh.every((s) => !s.sameSession)).toBe(true);
  }, 1_800_000);
});
