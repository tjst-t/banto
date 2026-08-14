/**
 * 職人が抱える**子プロセスの pid** を突き止める（inc-0066）。
 *
 * 職人の実体は2階建てになっている。工房が起こすのは node のホスト（190〜215MB）で、
 * そのホストがさらに子として実処理のプロセスを起こす——Claude Agent SDK なら
 * `@anthropic-ai/claude-agent-sdk-linux-x64/claude`（Bun の単一実行ファイル）。
 * 2026-08-14 未明の OOM で 11GB を抱えていたのは**この子の側**だった。
 *
 * ところが台帳に載っていたのはホストの pid だけで、子の pid はどこにも残っていない。
 * そのため OOM ダンプに出てくる pid から**どの職人だったか**を引けず、犯人を同定
 * できないまま終わった（inc-0066）。ここはその穴を塞ぐためだけにある。
 *
 * **なぜ `/proc` を走査するのか。** 子を起こしているのは SDK の内側で、工房からは
 * `ChildProcess` が見えない（`claude-agent-driver` が握っているのはホストの分だけ）。
 * 実測でも `claude` の親はホストの pid で、SDK は pid を外へ出さない。だから
 * 「ホストの pid を親に持つプロセスを探す」以外に手が無い。
 *
 * D6: node 標準のみ（`/proc` の読み取り。無い環境では `ps` に落とす）。
 * I2: 見つからなかったことを空配列で表さない。**理由を添えて残す**——「子が居ない」と
 *     「走査できなかった」を混ぜると、次の事故でまた同定できない。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";

/** 突き止めた子プロセス1つ分。 */
export interface ChildProcessInfo {
  pid: number;
  /** 親の pid。台帳のホスト pid と繋がっていることを人が確かめられるように残す。 */
  ppid: number;
  /** `/proc/<pid>/comm`（カーネルが15文字で切る）。例: `claude`。 */
  comm: string;
  /** `cmdline` の先頭（長いので切る）。どの実行ファイルかを人が見て分かるため。 */
  cmd?: string;
  /** 最初に見つけた時刻（ISO-8601）。 */
  firstSeenAt: string;
}

/** 1人の職人についての走査結果。台帳とイベントの両方にこの形で載る。 */
export interface ChildProcessRecord {
  /** 走査を終えた時刻（ISO-8601）。 */
  at: string;
  children: ChildProcessInfo[];
  /**
   * 突き止められなかった理由（I2）。`children` が空のときは**必ず**入る。
   * 空配列だけを見て「子は居なかった」と読ませないため。
   */
  error?: string;
  /** 上限（`maxChildren`）で打ち切ったか。 */
  truncated?: boolean;
}

export interface ChildPidProbeOptions {
  /** 諦めるまで（既定 20 秒）。子が起きるのは指示を渡したあとなので、少し待つ。 */
  timeoutMs?: number;
  /** 走査の間隔（既定 500ms）。 */
  intervalMs?: number;
  /**
   * 木が落ち着いたと見なすまでの猶予（既定 1000ms）。**最後に何かが現れてから**測る。
   *
   * **回数ではなく時間で持つ。** 「増えない走査が2回続いたら畳む」だと、猶予が
   * `intervalMs` に引きずられる——500ms×2＝1秒のつもりが、走査を 100ms に速めた
   * とたん 200ms に縮む。速くするための旋盤が、黙って機構を弱めていた（inc-0066）。
   */
  settleMs?: number;
  /** 台帳を太らせないための上限（既定 16）。 */
  maxChildren?: number;
  /**
   * 打ち切りの合図（工房を終うときに使う）。中断したら、そこまでに見つけた分を
   * 理由つきで返す——途中まで分かっていたことまで捨てない。
   */
  signal?: AbortSignal;
  /**
   * プロセス表の読み口（既定は `/proc`、駄目なら `ps`）。
   *
   * **差し替えられるようにしてあるのは、打ち切りの条件を試験するため。** 本物のプロセスで
   * 「孫が遅れて現れる」を作ると、現れる時刻が盤面の混み具合で動く＝**負荷で落ちる試験**に
   * なる（実際にそれで間欠に落ちていた）。走査の何回目に何が見えるかを台本にできれば、
   * 時間ではなく**筋書き**で確かめられる。
   */
  readTable?: () => { rows: ProcRow[] } | { error: string };
  /**
   * いまの時刻（既定 `Date.now`）。**`readTable` と対で試験のためにある。**
   * 打ち切りは時間で測るので、時計まで台本にできないと「速い機械では通り、混んでいる
   * 機械では落ちる」試験に逆戻りする。
   */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_INTERVAL_MS = 500;
/** 既定の猶予。従来の「500ms 間隔 × 2回」と同じ長さ＝実運用の振る舞いは変えない。 */
const DEFAULT_SETTLE_MS = 1_000;
const DEFAULT_MAX_CHILDREN = 16;

/** `cmdline` をこの長さで切る。台帳は人が読むものなので、1行に収まる程度に。 */
const CMD_MAX_LENGTH = 200;

/** プロセス表の1行（pid・親・名前だけ）。 */
export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
}

/**
 * `/proc/<pid>/stat` の1行から pid・comm・ppid を取り出す。
 *
 * 書式は `pid (comm) state ppid ...`。**comm には空白も `)` も入りうる**ので、
 * 素朴に空白で割ると ppid の位置がずれる（`(node --import ...)` のような名前が実在する）。
 * 最後の `)` を境にするのが定石。
 */
export function parseProcStat(raw: string): ProcRow | undefined {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close <= open) return undefined;
  const pid = Number(raw.slice(0, open).trim());
  const comm = raw.slice(open + 1, close);
  // `) ` の次が state、その次が ppid（全体の4番目の項）
  const rest = raw.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return undefined;
  return { pid, ppid, comm };
}

/**
 * いまのプロセス表を1枚撮る。
 *
 * 走査中に消えるプロセスは普通にあるので、個別の読み取り失敗は飛ばす。
 * `/proc` ごと読めないときだけ理由を返す（I2）。
 */
function snapshotProcTable(): { rows: ProcRow[] } | { error: string } {
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch (err) {
    // Linux 以外（`/proc` が無い・形が違う）では `ps` に落とす
    return snapshotViaPs(err);
  }

  const rows: ProcRow[] = [];
  for (const name of names) {
    // 数字のディレクトリだけがプロセス
    if (name.length === 0 || name.charCodeAt(0) < 0x30 || name.charCodeAt(0) > 0x39) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // 走査中に終わったプロセス。これは異常ではない
    }
    const row = parseProcStat(raw);
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    return { error: "/proc を読めましたが1件も解釈できませんでした（形式が想定と違います）" };
  }
  return { rows };
}

/** `/proc` が無いときの逃げ道。出力は小さいので `ps` を1回だけ叩く。 */
function snapshotViaPs(procError: unknown): { rows: ProcRow[] } | { error: string } {
  let out: string;
  try {
    out = childProcess.execFileSync("ps", ["-eo", "pid=,ppid=,comm="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return {
      error:
        `プロセス表を読めませんでした（/proc: ${String(procError)} ／ ps: ${String(err)}）`,
    };
  }
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: (m[3] ?? "").trim() });
  }
  if (rows.length === 0) return { error: "ps の出力を解釈できませんでした" };
  return { rows };
}

/**
 * `rootPid` の子孫をすべて挙げる（孫も含む）。
 *
 * 直接の子だけにしないのは、ランタイムがラッパを1枚挟んでも同定できるようにするため。
 * 自分自身は含めない。
 */
export function descendantsOf(rootPid: number, rows: ProcRow[]): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const found: ProcRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue; // pid の巡回（あり得ないが、無限ループは避ける）
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** `cmdline` の先頭。読めなければ undefined（あれば嬉しい程度のもの）。 */
function readCmdline(pid: number): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
  const text = raw.replace(/\0/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > CMD_MAX_LENGTH ? `${text.slice(0, CMD_MAX_LENGTH)}…` : text;
}

/**
 * 走査の間の待ち。
 *
 * **タイマーは unref する。** 記録のための処理が、プロセスの終わりを最大で timeoutMs
 * 引き留めるのは割に合わない（工房は常駐なので実運用では影響が無い）。合図が来たら
 * すぐ起きる——終うときに待たせないため。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `rootPid`（＝台帳に載っているホストの pid）の子孫を突き止める。
 *
 * 子が起きるのは**指示を渡したあと**なので、一発で見に行っても間に合わない。
 * 見つかるまで待ち、見つかったあとも**木が葉まで落ち着くまで**様子を見る。
 *
 * **畳む条件は「新しい子が増えない」ではなく「最後に現れてから `settleMs` 経った」。**
 * 職人は起きてから `esbuild` や `claude` を次々に作り、孫・ひ孫が遅れて現れる。
 * 最初の1枚を見つけた時点から回数で数えると、いちばん外側のラッパだけを記録して
 * 畳みかねない——それでは OOM のときに「誰が食べていたか」を答えられない（inc-0066）。
 * 現れるたびに猶予を測り直すので、木が伸びている間は畳まない。
 *
 * **職人の起動は止めない。** ここが失敗しても呼び出し側は捨て置ける形で返す（I2 の
 * 「握り潰さない」は、理由を `error` に残すことで果たす）。
 */
export async function probeChildPids(
  rootPid: number,
  opts: ChildPidProbeOptions = {}
): Promise<ChildProcessRecord> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
  const maxChildren = opts.maxChildren ?? DEFAULT_MAX_CHILDREN;
  const signal = opts.signal;
  const now = opts.now ?? Date.now;
  // 関数越しに読む。直に `signal.aborted` を見ると、TS が最初の判定で「もう false」と
  // 決めてしまい、await を跨いだ2度目の判定を無意味と見なす（実際は変わりうる）
  const aborted = (): boolean => signal?.aborted === true;

  const found = new Map<number, ChildProcessInfo>();
  const deadline = now() + timeoutMs;
  /** 最後に何かが現れた時刻。**現れるたびに測り直す**＝木が伸びている間は畳まない。 */
  let lastAppearedAt = now();
  let truncated = false;
  let rounds = 0;

  const readTable = opts.readTable ?? snapshotProcTable;

  for (;;) {
    rounds++;
    const table = readTable();
    if ("error" in table) {
      // 走査そのものができない。待っても変わらないので、理由を持って戻る
      return { at: new Date().toISOString(), children: [...found.values()], error: table.error };
    }

    let moved = 0;
    for (const row of descendantsOf(rootPid, table.rows)) {
      const known = found.get(row.pid);
      if (known) {
        /**
         * **同じ pid でも `comm` が変わったら書き直す**（fork と exec の間で捕まえた分）。
         *
         * `fork` した子は、`exec` するまで親の `comm`・`cmdline` を着たままでいる。
         * その隙に走査が当たると「親と同じ名前の子」が1件記録され、以後この pid は
         * `found` に居るという理由で二度と見直されない——`sleep` や `claude` が
         * **`sh` のまま台帳に載る**。OOM のあとに「誰が食べていたか」を答えるのが
         * inc-0066 の目的なので、着替え終えた姿に更新しないと目的を果たさない。
         *
         * 実測（2026-08-14）: 検証コンテナで `worker-child-pids.spec.ts` が
         * 18回中3回この形で落ちた（ホストでは10回中0回——器の方が遅く、隙が広い）。
         * 落ちない機械でも台帳の中身は同じだけ狂うので、試験ではなく機構を直す（P6）。
         */
        if (known.comm === row.comm) continue;
        known.comm = row.comm;
        // 読めなかったとき（既に消えた等）は前に読めたものを残す——消して情報を減らさない
        const recmd = readCmdline(row.pid);
        if (recmd) known.cmd = recmd;
        moved++;
        continue;
      }
      if (found.size >= maxChildren) {
        truncated = true;
        break;
      }
      const info: ChildProcessInfo = {
        pid: row.pid,
        ppid: row.ppid,
        comm: row.comm,
        firstSeenAt: new Date().toISOString(),
      };
      const cmd = readCmdline(row.pid);
      if (cmd) info.cmd = cmd;
      found.set(row.pid, info);
      moved++;
    }

    // 現れた／着替えた、のどちらも「木がまだ動いている」合図として猶予を測り直す
    if (moved > 0) lastAppearedAt = now();
    // 何か見つかっていて、そこから `settleMs` のあいだ何も現れなければ落ち着いたと見なす。
    // **孫が遅れて現れる間は畳まない**——猶予は現れるたびに測り直している
    if (found.size > 0 && now() - lastAppearedAt >= settleMs) break;
    if (aborted()) break;
    if (now() >= deadline) break;
    await sleep(intervalMs, signal);
    if (aborted()) break;
  }

  const at = new Date().toISOString();
  const children = [...found.values()];
  if (aborted() && children.length === 0) {
    // I2: 「打ち切った」と「子が居なかった」を混ぜない
    return { at, children, error: `pid ${rootPid} の子プロセスの走査を打ち切りました（${rounds}回の走査）` };
  }
  if (children.length === 0) {
    // I2: 空配列は「子が居ない」ではなく「見つけられなかった」。次の事故で人が
    //     「記録漏れ」と「そもそも子を持たないランタイム」を区別できるようにする
    return {
      at,
      children,
      error:
        `pid ${rootPid} の子プロセスを ${timeoutMs}ms（${rounds}回の走査）以内に見つけられませんでした。` +
        "子を持たないランタイムか、既に終わっていたか、走査が間に合わなかったかのいずれかです。",
    };
  }
  return { at, children, ...(truncated ? { truncated: true } : {}) };
}
