#!/usr/bin/env node
/**
 * 観測の数値をプレーンテキストで出す CLI。
 *
 * 3つのモード：
 *  --transcripts [rootDir]  Claude Code のトランスクリプトを読んで畳む（検算用）
 *  --since / --until        セッションの開始時刻で母集団を絞る。過去の計測と
 *                           突き合わせるとき、コーパスの増加と実装の変化を取り違えないため
 *  --log <dataDir>          banto 自身のイベントログを読んで畳む
 *  --watch <dataDir>        繰り返し畳んで、**警報を判断待ちの列に流す**（要件 F1 → A6）
 *
 * ## `--watch` は banto の中で走らせてはいけない（規則4）
 *
 * > **観測は、観測される機構の外側に置く。中に置くと、機構が止まったとき
 * > 観測も一緒に止まる。**
 *
 * `raiseAlarms` は最初から在ったのに、**どこからも呼ばれていなかった**
 * ——要件 F1 の「増え続けていることを**機構が**検知する」は、人が手で
 * CLI を叩いたときだけ成り立っていた（2026-08-21 に露見・規則8）。
 * だからといってホストの中で回すと規則4 に反するので、**別のプロセス**にする。
 * ホストが落ちたときに鳴らないのでは、いちばん鳴ってほしいときに鳴らない。
 *
 * ここは「見るだけ」。畳み込みは observe.ts、読み込みは from-transcript.ts /
 * from-log.ts に任せる——CLI 自身に集計ロジックを増やさない。
 */

import { observe, percentile, DEFAULT_OPTIONS, type Observation } from './observe.js';
import { readLogSource } from './from-log.js';
import { raiseAlarms } from './raise-alarms.js';
import { scanTranscripts, type ScanOptions, type TranscriptScanResult } from './from-transcript.js';

function parseArgs(argv: readonly string[]): {
  mode: 'transcripts' | 'log' | 'watch' | null;
  rootDir: string | undefined;
  dataDir: string | undefined;
  json: boolean;
  since: string | undefined;
  until: string | undefined;
  intervalMs: number;
} {
  let mode: 'transcripts' | 'log' | 'watch' | null = null;
  let rootDir: string | undefined;
  let dataDir: string | undefined;
  let json = false;
  let since: string | undefined;
  let until: string | undefined;
  /** 見に行く間隔。**短くしても壊れない**——読むだけで、書くのは警報が変わったときだけ。 */
  let intervalMs = 60_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--transcripts') {
      mode = 'transcripts';
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        rootDir = next;
        i += 1;
      }
    } else if (arg === '--log') {
      mode = 'log';
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--log には dataDir が要る: --log <dataDir>');
      }
      dataDir = next;
      i += 1;
    } else if (arg === '--watch') {
      mode = 'watch';
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--watch には dataDir が要る: --watch <dataDir>');
      }
      dataDir = next;
      i += 1;
    } else if (arg === '--interval') {
      const next = argv[i + 1];
      const seconds = Number(next);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`--interval には秒数が要る（例 --interval 60）`);
      }
      intervalMs = seconds * 1000;
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--since' || arg === '--until') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} には日付が要る（例 ${arg} 2026-08-20）`);
      }
      if (arg === '--since') since = next;
      else until = next;
      i += 1;
    }
  }

  return { mode, rootDir, dataDir, json, since, until, intervalMs };
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 全ターンの文脈サイズを series をまたいで束ねる。p50/p90/p99/max はこの束の上で取る。 */
function allContextSizes(observation: Observation): number[] {
  const sizes: number[] = [];
  for (const s of observation.series) sizes.push(...s.contextSizes);
  return sizes;
}

function countAlarmsByKind(observation: Observation): Map<string, number> {
  const counts = new Map<string, number>();
  for (const alarm of observation.alarms) {
    counts.set(alarm.kind, (counts.get(alarm.kind) ?? 0) + 1);
  }
  return counts;
}

function renderReport(observation: Observation, title: string): string {
  const sizes = allContextSizes(observation);
  const max = sizes.length === 0 ? 0 : Math.max(...sizes);
  const alarmCounts = countAlarmsByKind(observation);
  const { totals } = observation;

  const lines: string[] = [];
  lines.push(`=== ${title} ===`);
  lines.push('');
  lines.push(`series (sessions)             ${fmt(totals.series)}`);
  lines.push(`turns                          ${fmt(totals.turns)}`);
  lines.push('');
  lines.push('-- tokens --');
  lines.push(`input                          ${fmt(totals.inputTokens)}`);
  lines.push(`cache creation                 ${fmt(totals.cacheCreationTokens)}`);
  lines.push(`cache read                     ${fmt(totals.cacheReadTokens)}`);
  lines.push(`output                         ${fmt(totals.outputTokens)}`);
  lines.push(`cache read ratio (of input側)  ${(totals.cacheReadRatio * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('-- context size (per turn) --');
  lines.push(`p50                            ${fmt(percentile(sizes, 0.5))}`);
  lines.push(`p90                            ${fmt(percentile(sizes, 0.9))}`);
  lines.push(`p99                            ${fmt(percentile(sizes, 0.99))}`);
  lines.push(`max                            ${fmt(max)}`);
  lines.push(
    `turns over limit (${fmt(observation.options.contextLimit)})   ${fmt(totals.turnsOverContextLimit)} (${pct(totals.turnsOverContextLimit, totals.turns)})`,
  );
  lines.push('');
  lines.push('-- compaction (usage から導いた発火) --');
  lines.push(`decreases                      ${fmt(totals.decreases)}`);
  lines.push(`compactionFirings              ${fmt(totals.compactionFirings)}`);
  lines.push('');
  lines.push('-- alarms --');
  lines.push(`quantity                       ${fmt(alarmCounts.get('quantity') ?? 0)}`);
  lines.push(`absence                        ${fmt(alarmCounts.get('absence') ?? 0)}`);

  return lines.join('\n');
}

async function runTranscripts(
  rootDir: string | undefined,
  json: boolean,
  options: ScanOptions,
): Promise<void> {
  const scan: TranscriptScanResult = await scanTranscripts(rootDir, options);
  const observation = observe(scan.turns, DEFAULT_OPTIONS);

  if (json) {
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderReport(observation, 'transcripts')}\n`);
  process.stdout.write('\n-- scan (第三者ファイル: 壊れていても投げずに数える) --\n');
  process.stdout.write(`files                          ${fmt(scan.files)}\n`);
  // 生の行数を必ず併記する。ADR-0001 の前の版の「88,711 ターン」はこちらの数なので、
  // 畳んだ数だけ出すと過去の計測と突き合わせられなくなる。
  process.stdout.write(`filesOutOfRange (期間で除外)   ${fmt(scan.filesOutOfRange)}\n`);
  process.stdout.write(`rawAssistantLines              ${fmt(scan.rawAssistantLines)}\n`);
  process.stdout.write(`duplicateLines (同 message.id) ${fmt(scan.duplicateLines)}\n`);
  process.stdout.write(`sessions (turns が1件以上)     ${fmt(scan.sessions)}\n`);
  process.stdout.write(`skippedNoUsage                 ${fmt(scan.skippedNoUsage)}\n`);
  process.stdout.write(`sidechainTurns (turns に含む)  ${fmt(scan.sidechainTurns)}\n`);
  process.stdout.write(`malformedLines                 ${fmt(scan.malformedLines)}\n`);
}

async function runLog(dataDir: string, json: boolean): Promise<void> {
  const source = await readLogSource(dataDir);
  const observation = observe(source.turns, DEFAULT_OPTIONS);

  if (json) {
    process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${renderReport(observation, 'log')}\n`);
  process.stdout.write('\n-- compaction: 申告 vs 導出 --\n');
  process.stdout.write(`reportedCompactions.length     ${fmt(source.reportedCompactions.length)}\n`);
  process.stdout.write(`compactionFirings (導出)       ${fmt(observation.totals.compactionFirings)}\n`);
  if (source.reportedCompactions.length !== observation.totals.compactionFirings) {
    process.stdout.write(
      '*** DISCREPANCY: 申告された圧縮の数と usage から導いた発火回数が食い違っている。' +
        '黙ってどちらかに寄せない（規則8）。人が見て判断すること。 ***\n',
    );
  }
}

/**
 * イベントログを繰り返し畳んで、警報を判断待ちの列に流す（要件 F1 → A6）。
 *
 * **書くのは警報が変わったときだけ。** `raiseAlarms` が「既に立っているなら
 * 何もしない」を守るので、毎分呼んでも列は荒れないし、滞留の時計（要件 A7）も
 * 巻き戻らない。
 *
 * **止まったら止まったと分かるように、毎回1行出す。** 黙って回る観測は、
 * 死んでいるのか静かなのかが区別できない（規則4 の趣旨）。
 */
async function runWatch(dataDir: string, intervalMs: number): Promise<void> {
  process.stdout.write(`watching ${dataDir}（${intervalMs / 1000} 秒ごと・Ctrl-C で止める）\n`);

  for (;;) {
    const at = new Date().toISOString();
    try {
      const source = await readLogSource(dataDir);
      const observation = observe(source.turns, DEFAULT_OPTIONS);
      const result = await raiseAlarms(dataDir, observation);
      process.stdout.write(
        `${at} turns=${source.turns.length} alarms=${observation.alarms.length}` +
          ` raised=${result.raised.length} pending=${result.alreadyPending.length}` +
          ` resolved=${result.resolved.length}\n`,
      );
    } catch (cause) {
      // **握りつぶさない。ただし止まらない**（規則2）——観測が1回読めなかったことで
      // 観測そのものが死ぬと、いちばん鳴ってほしいときに鳴らない。
      process.stderr.write(`${at} 観測に失敗: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main(): Promise<void> {
  const { mode, rootDir, dataDir, json, since, until, intervalMs } = parseArgs(process.argv.slice(2));

  if (mode === 'transcripts') {
    await runTranscripts(rootDir, json, {
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    });
    return;
  }
  if (mode === 'log') {
    if (dataDir === undefined) throw new Error('--log には dataDir が要る');
    await runLog(dataDir, json);
    return;
  }
  if (mode === 'watch') {
    if (dataDir === undefined) throw new Error('--watch には dataDir が要る');
    await runWatch(dataDir, intervalMs);
    return;
  }

  process.stderr.write(
    'usage: cli.js --transcripts [rootDir] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]\n' +
      '       cli.js --log <dataDir> [--json]\n' +
      '       cli.js --watch <dataDir> [--interval 秒]\n' +
      '         警報を判断待ちの列に流し続ける。**banto とは別のプロセスで走らせる**\n' +
      '         （規則4：観測を機構の中に置くと、機構が止まったとき観測も止まる）\n',
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
