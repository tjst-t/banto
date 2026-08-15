/**
 * T1: ターン台帳の集計レポート（CLI）。
 *
 * 台帳（`<BANTO_DATA_DIR>/turns.jsonl`、既定は `.banto/turns.jsonl`）を読み、
 * **日付ごと・スレッドごとのターン本数・busy 合計（durationMs の和）・source 別内訳**を
 * 標準出力へ出す。幹と枝は `threadKind` で見分けられる。
 *
 * T4 から**促しの回数**も出す：幹の行に「委譲の促し／閲覧の促しが出たターン本数」と
 * 「促されたあとも同じターンで触り続けた回数」。**促すだけで足りるのか、断る側へ
 * 寄せるのか**は、この数字が縮まるかどうかで決める（`--json` にも同じものが入る）。
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
  /**
   * **促しが出たターン本数**（T4）。種類別に数える——効き方が違うので混ぜない。
   * 促しは幹でしか出ないので、枝の行は 0 のまま。
   */
  nudgedTurns: { delegate: number; browse: number };
  /**
   * **閲覧の促しが効かなかった量**（T4）。促しが出たあとも同じターンで触り続けたぶん。
   *
   *   - `turns`: 促しが出たあと、さらに1回以上触ったターン本数
   *   - `calls`: その追加の呼び出し回数の合計（`browseCalls - browseNudgeAt` の和）
   *
   * ここが縮まらないなら「促すだけ」では足りない＝断る側へ寄せる根拠になる。
   * **古い台帳の行（T4 以前）には項目が無い**ので、その行は 0 として数える
   * ——「促したのに続けた」に化けさせない（I1）。
   */
  afterBrowseNudge: { turns: number; calls: number };
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
        nudgedTurns: { delegate: 0, browse: 0 },
        afterBrowseNudge: { turns: 0, calls: 0 },
      };
      threads.set(entry.threadId, stats);
    }
    stats.turns += 1;
    stats.busyMs += entry.durationMs;
    stats.bySource[entry.source] = (stats.bySource[entry.source] ?? 0) + 1;
    // T4: 促しが出たか（種類別）と、促されたあとも触り続けたか
    if (entry.nudges?.includes("delegate")) stats.nudgedTurns.delegate += 1;
    if (entry.nudges?.includes("browse")) stats.nudgedTurns.browse += 1;
    if (entry.browseNudgeAt !== undefined && entry.browseCalls !== undefined) {
      const after = entry.browseCalls - entry.browseNudgeAt;
      if (after > 0) {
        stats.afterBrowseNudge.turns += 1;
        stats.afterBrowseNudge.calls += after;
      }
    }
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

/**
 * 促しの表示（T4）。**幹の行には必ず出す**——「1回も促されていない」は良い報せで、
 * 出ていないと「そもそも数えていないのか」と区別が付かない。枝の行は促しが出ない
 * 前提なので、0 のときは黙る（出ていたら機構の不具合なので、そのときだけ見える）。
 */
function nudgeLine(thread: ThreadTurnStats): string {
  const { delegate, browse } = thread.nudgedTurns;
  if (delegate === 0 && browse === 0) {
    return thread.threadKind === "trunk" ? "  促し なし" : "";
  }
  const after =
    thread.afterBrowseNudge.turns > 0
      ? `(促し後も ${thread.afterBrowseNudge.calls}回/${thread.afterBrowseNudge.turns}ターン)`
      : "";
  return `  促し 委譲:${delegate} 閲覧:${browse}${after}`;
}

/**
 * 画面へ出す文字列を組み立てる（純粋関数）。**出力と表示を分ける**——ここを
 * `console.log` に直書きしていると、出た形を試験で確かめる手段が無い（I1: 出ているはず、
 * では確かめたことにならない）。
 */
export function renderTurnReport(summary: TurnSummary): string {
  const lines: string[] = [];
  for (const day of summary.days) {
    lines.push(day.date);
    for (const thread of day.threads) {
      const kind =
        thread.threadKind === "branch"
          ? `枝 →${thread.parentId ?? "?"}`
          : thread.threadKind === "trunk"
            ? "幹"
            : "?";
      lines.push(
        `  ${thread.threadId} [${kind}]  ${thread.turns}ターン  busy ${thread.busyMs}ms  ${sourceLine(thread.bySource)}${nudgeLine(thread)}`
      );
    }
  }
  lines.push(`合計: ${summary.total.turns}ターン / busy ${summary.total.busyMs}ms`);
  return lines.join("\n");
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
    console.log(renderTurnReport(summary));
  }
}

// 直接実行されたときだけ走る（試験から import されたときは集計関数だけを使う）
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
