/**
 * T1: ターン台帳の集計レポート（CLI）。
 *
 * 台帳（`<BANTO_DATA_DIR>/turns.jsonl`、既定は `.banto/turns.jsonl`）を読み、
 * **日付ごと・スレッドごとのターン本数・busy 合計（durationMs の和）・source 別内訳**を
 * 標準出力へ出す。幹と枝は `threadKind` で見分けられる。
 *
 * 集計は純粋関数 `summarize` に任せ、ここは読み出しと表示だけ（試験は関数を直接叩く）。
 * 台帳が無い・1行も無いときは「まだ1行も無い」と言って exit 0（落ちない）。
 *
 *   node --import tsx packages/banto-host/src/turn-report.ts [--since ISO日付] [--thread threadId] [--json]
 */
import { pathToFileURL } from "node:url";
import { TurnLog, defaultTurnLogPath, type TurnLogEntry } from "./turn-log.js";

/** 集計の絞り込み。 */
export interface TurnReportOptions {
  /** この ISO 日付（その日を含む）以降だけ数える。 */
  since?: string;
  /** このスレッドだけに絞る。 */
  thread?: string;
}

/** スレッド1本分の集計。 */
export interface ThreadTurnStats {
  threadId: string;
  threadKind?: "trunk" | "branch";
  parentId?: string;
  /** ターン本数。 */
  turns: number;
  /** busy 合計（durationMs の和）。 */
  busyMs: number;
  /** source 別のターン本数。 */
  bySource: Record<string, number>;
}

/** 日付1日分の集計。 */
export interface DayTurnSummary {
  date: string;
  threads: ThreadTurnStats[];
}

/** 台帳全体の集計。 */
export interface TurnSummary {
  days: DayTurnSummary[];
  total: { turns: number; busyMs: number };
}

/**
 * 台帳を日付×スレッド×source で集計する（純粋関数）。
 *
 * 日付・スレッドは昇順に並べ、出力が決定的になるようにする。`at` は ISO8601 なので
 * 日付は先頭10文字（`YYYY-MM-DD`）で切り出し、`since` はそのまま文字列比較できる。
 */
export function summarize(
  entries: readonly TurnLogEntry[],
  options: TurnReportOptions = {}
): TurnSummary {
  const byDate = new Map<string, Map<string, ThreadTurnStats>>();
  let totalTurns = 0;
  let totalBusyMs = 0;
  for (const entry of entries) {
    if (options.thread !== undefined && entry.threadId !== options.thread) continue;
    const date = entry.at.slice(0, 10);
    if (options.since !== undefined && date < options.since) continue;
    let threads = byDate.get(date);
    if (!threads) {
      threads = new Map();
      byDate.set(date, threads);
    }
    let stats = threads.get(entry.threadId);
    if (!stats) {
      stats = {
        threadId: entry.threadId,
        ...(entry.threadKind !== undefined ? { threadKind: entry.threadKind } : {}),
        ...(entry.parentId !== undefined ? { parentId: entry.parentId } : {}),
        turns: 0,
        busyMs: 0,
        bySource: {},
      };
      threads.set(entry.threadId, stats);
    }
    stats.turns += 1;
    stats.busyMs += entry.durationMs;
    stats.bySource[entry.source] = (stats.bySource[entry.source] ?? 0) + 1;
    totalTurns += 1;
    totalBusyMs += entry.durationMs;
  }
  const days: DayTurnSummary[] = [...byDate.keys()].sort().map((date) => ({
    date,
    threads: [...byDate.get(date)!.values()].sort((a, b) =>
      a.threadId.localeCompare(b.threadId)
    ),
  }));
  return { days, total: { turns: totalTurns, busyMs: totalBusyMs } };
}

function parseArgs(argv: string[]): TurnReportOptions & { json: boolean } {
  const out: TurnReportOptions & { json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") out.json = true;
    else if (arg === "--since") out.since = argv[++i];
    else if (arg === "--thread") out.thread = argv[++i];
    else {
      console.error(
        `usage: turn-report [--since ISO日付] [--thread threadId] [--json]\n  不明な引数: ${arg}`
      );
      process.exit(2);
    }
  }
  return out;
}

/** source 別内訳の表示（`worker:8 po:3` の形。決定的に並べる）。 */
function sourceLine(bySource: Record<string, number>): string {
  const parts = Object.entries(bySource)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, count]) => `${source}:${count}`);
  return parts.length > 0 ? parts.join(" ") : "—";
}

function printText(summary: TurnSummary): void {
  for (const day of summary.days) {
    console.log(day.date);
    for (const thread of day.threads) {
      const kind =
        thread.threadKind === "branch"
          ? `枝 →${thread.parentId ?? "?"}`
          : thread.threadKind === "trunk"
            ? "幹"
            : "?";
      console.log(
        `  ${thread.threadId} [${kind}]  ${thread.turns}ターン  busy ${thread.busyMs}ms  ${sourceLine(thread.bySource)}`
      );
    }
  }
  console.log(`合計: ${summary.total.turns}ターン / busy ${summary.total.busyMs}ms`);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const log = new TurnLog(defaultTurnLogPath());
  const entries = log.readAll();
  if (entries.length === 0) {
    console.log("まだ1行も無い（ターン台帳は空です）");
    return;
  }
  const summary = summarize(entries, options);
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printText(summary);
  }
}

// 直接実行されたときだけ走る（試験から import されたときは集計関数だけを使う）
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
