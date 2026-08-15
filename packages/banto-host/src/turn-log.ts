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

  /** 台帳を読む。壊れた行は無視する（1行の破損で台帳全体を失わない）。 */
  readAll(): TurnLogEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const out: TurnLogEntry[] = [];
    for (const line of fs.readFileSync(this.file, "utf-8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as TurnLogEntry);
      } catch {
        // 途中で死んだ行があっても、残りは読める（I2: 台帳ごと落とさない）
      }
    }
    return out;
  }
}
