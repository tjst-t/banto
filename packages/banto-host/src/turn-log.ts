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
  constructor(private readonly file: string) {}

  /** 1ターン＝1行で追記する。失敗しても呼び出し側（会話）は壊さない。 */
  append(entry: TurnLogEntry): void {
    try {
      // ディレクトリが無ければ作る（初回起動時）
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf-8");
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
