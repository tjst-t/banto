/**
 * T1: ターンの台帳（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * `turn_start`/`turn_end` は WS へ broadcast されるだけでどこにも残らないため、
 * 「幹のターンが1日に何本回り、どの出所から来て、どれだけ塞いだか」を機械的に
 * 数えられない。ここに追記専用の JSONL を1本残し、T2 以降の受け入れ基準を
 * 数字で書けるようにする。
 *
 * **観測を足すだけ**——ターンの順序・直列化・エラーの扱いは1文字も変えない。
 * 書き込みが失敗しても会話は壊さない（計測のために会話を落とすのは本末転倒）：
 * 失敗は console.error に出すだけで握り潰す。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * そのターンで番頭が道具を何回呼んだか（T4）。
 *
 * **閾値を決める材料**。「幹で調べ物が始まったら促す」の線をどこに引くかは、幹の
 * ターンが実際に何回道具を呼んでいるかを見ないと決められない——ここが無いと、
 * その材料が永久に手に入らない（数字は当てずっぽうで置かない）。
 */
export interface TurnToolCounts {
  /** そのターンの道具呼び出し回数（全部）。 */
  total: number;
  /** うち `file.*` / `git.*`（自分の手で調べ物・手仕事をした回数）。 */
  browse: number;
  /**
   * そのターンで出た促しの種類（T4）。**促しは幹でしか出ない**ので、枝の行では常に空。
   * 出ていないターンでは省略（空配列を毎行書かない）。
   */
  nudges?: readonly TurnNudgeKind[];
  /**
   * 閲覧の促しが出た**時点**の `browse` 回数（＝その時の閾値）。
   *
   * `browse - browseNudgeAt` が「**促されたあとも幹で触り続けた回数**」になる。
   * 促しを「断る側へ寄せるか」の判断は、この差が縮まるかどうかで測る。
   */
  browseNudgeAt?: number;
}

/**
 * 促しの種類（T4）。**委譲と閲覧は別に数える**——効き方が違うので、混ぜると
 * 「どちらの促しが効いていないのか」が読めなくなる。
 */
export type TurnNudgeKind = "delegate" | "browse";

/** ターン1本分の記録。1ターン＝1行。 */
export interface TurnLogEntry {
  /** ターンが**始まった**時刻（ISO8601）。 */
  at: string;
  threadId: string;
  /** 幹か枝か。取れないときは省略してよい。 */
  threadKind?: "trunk" | "branch";
  /** 枝なら親の幹の id（あれば）。 */
  parentId?: string;
  /**
   * 誰が起こしたターンか。既存の呼び出しで使われる値は
   * `worker` / `kobo` / `env` / `system` / `thread`（他の幹からの言伝）で、
   * これに `po`（PO の発話）と `nudge`（枝からの相談）が足される。
   * 渡ってこなかったときは `unknown`。
   */
  source: string;
  /** turn_start から turn_end までの実測ミリ秒。 */
  durationMs: number;
  /** 失敗せずに終わったら true。 */
  ok: boolean;
  /** 失敗したときだけ。 */
  errorMessage?: string;
  /** そのターンの道具呼び出し回数（T4）。数えが取れなかったときは省略。 */
  toolCalls?: number;
  /** うち `file.*` / `git.*` の回数（T4）。数えが取れなかったときは省略。 */
  browseCalls?: number;
  /**
   * そのターンで出た促しの種類（T4）。出なかったターンでは省略。
   *
   * **促しが効いたかを後から数えるための項目**。「促すだけ」で足りるのか、断る側へ
   * 寄せるのかは計測が出てから決める——ここが無いと、その判断が永久にできない。
   */
  nudges?: TurnNudgeKind[];
  /** 閲覧の促しが出た時点の `browseCalls`（T4）。出なかったターンでは省略。 */
  browseNudgeAt?: number;
}

/**
 * 読みのときに見つかった不具合1件（fix: task-0162）。
 *
 * ホストは OOM killer に殺されることがあり、**書き込みの途中で死ぬと最終行が千切れる**。
 * 黙って飛ばすと壊れたことに誰も気づけない（I2）ので、何行目がどう読めなかったかを
 * ここに残して警告に出す。
 */
export interface TurnLogReadProblem {
  /** 何行目か（1始まり）。ファイルごと読めなかったときだけ 0。 */
  line: number;
  kind:
    | /** JSON として読めない行（途中のどこか）。 */ "unparsable"
    | /** 末尾に改行が無く、しかも JSON として読めない＝書き込みの途中で死んだ行。 */ "truncated"
    | /** 末尾に改行が無いが中身は読める＝改行だけ落ちた疑い。行自体は返す。 */ "no-trailing-newline"
    | /** ファイルそのものが読めなかった。 */ "unreadable";
  /** 人が読む理由（パースの例外など）。 */
  detail: string;
  /** その行の抜粋（長ければ切る）。ファイルごと読めなかったときは無い。 */
  preview?: string;
}

/** 読みの結果。読めた行と、読めなかった行の記録。 */
export interface TurnLogReadResult {
  entries: TurnLogEntry[];
  problems: TurnLogReadProblem[];
}

/** 台帳の既定の置き場。`dataDir()`（bin.ts）と同じ規則。 */
export function defaultTurnLogPath(): string {
  return path.join(
    process.env["BANTO_DATA_DIR"] ?? path.join(process.cwd(), ".banto"),
    "turns.jsonl"
  );
}

/**
 * 追記専用の JSONL 台帳。書くのはホスト（server.ts）、読むのはレポート（turn-report.ts）
 * と試験だけ。同期の `appendFileSync` でよい——ターン1本の終わりに1行、呼ばれる頻度は
 * 高くない。
 */
export class TurnLog {
  /**
   * @param counts そのターンの道具呼び出し回数を引く口（T4）。**書く直前にここで足す**
   *   ——数えを持っているのは会話ごとの器（`TrunkWorkNudge`・bin.ts のクロージャ）で、
   *   台帳を書くホストはそれを知らない。引けない会話（試験・数えを渡していない
   *   呼び出し元）では単に項目が出ないだけで、台帳は今までどおり書ける。
   */
  constructor(
    private readonly file: string,
    private readonly counts?: (threadId: string) => TurnToolCounts | undefined
  ) {}

  /** 1ターン＝1行で追記する。失敗しても呼び出し側（会話）は壊さない。 */
  append(entry: TurnLogEntry): void {
    const counted = this.counts?.(entry.threadId);
    const line: TurnLogEntry =
      counted === undefined
        ? entry
        : {
            ...entry,
            toolCalls: counted.total,
            browseCalls: counted.browse,
            // 促しが出なかったターンでは項目ごと出さない（空配列を毎行書かない）
            ...(counted.nudges !== undefined && counted.nudges.length > 0
              ? { nudges: [...counted.nudges] }
              : {}),
            ...(counted.browseNudgeAt !== undefined
              ? { browseNudgeAt: counted.browseNudgeAt }
              : {}),
          };
    try {
      // ディレクトリが無ければ作る（初回起動時）
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(line) + "\n", "utf-8");
    } catch (err) {
      // 観測のための台帳。書けなくても会話を止めない——黙らせるのは I2 に反するので
      // console.error には出す（計測が会話を壊すのは本末転倒）
      console.error(`[banto] ターン台帳へ書けませんでした: ${String(err)}`);
    }
  }

  /**
   * 台帳を読む。読めた行は全件返しつつ、読めなかった行は**必ず警告に出す**。
   *
   * 集計側（turn-report）は行の配列だけあればよいので `readAll()` はそのまま残し、
   * 何が起きたかを機械的に見たい呼び出し側（試験）のためにこちらを足す。
   */
  read(): TurnLogReadResult {
    if (!fs.existsSync(this.file)) return { entries: [], problems: [] };
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf-8");
    } catch (err) {
      // 読めなくてもホストは立つ（起動を止めるのは本末転倒）。ただし黙らない（I2）
      const problem: TurnLogReadProblem = {
        line: 0,
        kind: "unreadable",
        detail: String(err),
      };
      this.warn([problem]);
      return { entries: [], problems: [problem] };
    }

    const entries: TurnLogEntry[] = [];
    const problems: TurnLogReadProblem[] = [];
    const lines = raw.split("\n");
    /**
     * 末尾に改行が無い＝書き込みの途中でプロセスが殺された疑い（OOM killer）。
     * `split("\n")` の最後は改行で終わっていれば空文字列になるので、空でなければ千切れ。
     */
    const truncatedIndex =
      lines.length > 0 && lines[lines.length - 1]!.length > 0 ? lines.length - 1 : -1;

    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const lineNo = index + 1;
      let entry: TurnLogEntry;
      try {
        entry = JSON.parse(line) as TurnLogEntry;
      } catch (err) {
        // 途中で死んだ行があっても、残りは読める（I2: 台帳ごと落とさない）
        problems.push({
          line: lineNo,
          kind: index === truncatedIndex ? "truncated" : "unparsable",
          detail: String(err),
          preview: preview(line),
        });
        continue;
      }
      if (index === truncatedIndex) {
        /**
         * 読めてはいるが改行が無い＝最後の1バイトだけ落ちた形。中身は揃っているので
         * 捨てない（1行を惜しんで実データを失わない）が、千切れた疑いは警告に出す。
         */
        problems.push({
          line: lineNo,
          kind: "no-trailing-newline",
          detail: "末尾に改行がありません（書き込みの途中で止まった疑い）",
          preview: preview(line),
        });
      }
      entries.push(entry);
    }

    if (problems.length > 0) this.warn(problems);
    return { entries, problems };
  }

  /** 台帳を読む。壊れた行は飛ばすが、飛ばしたことは警告に出る（1行の破損で台帳全体を失わない）。 */
  readAll(): TurnLogEntry[] {
    return this.read().entries;
  }

  /** 読めなかった行を console.error に出す（既存のログの流儀に合わせる）。 */
  private warn(problems: readonly TurnLogReadProblem[]): void {
    // 壊れた行が大量にあるときに console を埋めない。先頭だけ出して残りは件数で示す
    const shown = problems.slice(0, WARN_LIMIT);
    for (const p of shown) {
      const where = p.line > 0 ? `${p.line}行目` : "ファイル全体";
      console.error(
        `[banto] ターン台帳の${where}を読めませんでした（${this.file}, ${REASON[p.kind]}）: ` +
          `${p.detail}${p.preview === undefined ? "" : ` / 行の中身: ${p.preview}`}`
      );
    }
    if (problems.length > shown.length) {
      console.error(
        `[banto] ターン台帳の読めない行は他に ${problems.length - shown.length} 行あります（${this.file}）`
      );
    }
  }
}

/** 1回の読みで個別に出す警告の上限。これを超えた分は件数だけ出す。 */
const WARN_LIMIT = 10;

const REASON: Record<TurnLogReadProblem["kind"], string> = {
  unparsable: "JSON として読めない行",
  truncated: "千切れた最終行",
  "no-trailing-newline": "最終行に改行が無い",
  unreadable: "ファイルを読めない",
};

/** 警告に載せる行の抜粋。長い行で console を埋めない。 */
function preview(line: string): string {
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`;
}

const PREVIEW_LIMIT = 120;
