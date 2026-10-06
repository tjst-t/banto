// **段の記録**（v4-modules.md §4.5「記録と再開」）——Dynamic Workflows の「流し直しで再開する」を借りた形。
//
// 1件の手順は、段の呼び出し（サブエージェント・コマンド・Backlog・知らせ・人への問い）が**決まった順に**起きるように
// 書く。段には順に番号が付き、始める前に「始めた」、終わったら結果を、この記録に追記する。Factory が起き直したら手順を
// 最初から流し直し、終わった段は記録した結果を返す——同じ仕事を2回しない。記録は1件ごとに JSON Lines 1つ。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JournalLine =
  | { n: number; phase: "start"; key: string; at: string }
  | { n: number; phase: "launched"; replyId: string; subagentRunId?: string; at: string }
  | { n: number; phase: "end"; ok: true; value: unknown; at: string }
  | { n: number; phase: "end"; ok: false; error: string; at: string };

export interface StepRecord {
  n: number;
  key: string;
  startedAt: string;
  launched?: { replyId: string; subagentRunId?: string };
  end?: { ok: true; value: unknown; at: string } | { ok: false; error: string; at: string };
}

export class Journal {
  private steps = new Map<number, StepRecord>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let line: JournalLine;
      try {
        line = JSON.parse(raw) as JournalLine;
      } catch {
        // 最後の行が書きかけで切れた（書いている途中で落ちた）——そこから先は無かったものとする
        break;
      }
      this.apply(line);
    }
  }

  get(n: number): StepRecord | undefined {
    return this.steps.get(n);
  }

  all(): StepRecord[] {
    return [...this.steps.values()].sort((a, b) => a.n - b.n);
  }

  start(n: number, key: string): void {
    this.write({ n, phase: "start", key, at: new Date().toISOString() });
  }

  launched(n: number, replyId: string, subagentRunId?: string): void {
    this.write({ n, phase: "launched", replyId, ...(subagentRunId ? { subagentRunId } : {}), at: new Date().toISOString() });
  }

  end(n: number, outcome: { ok: true; value: unknown } | { ok: false; error: string }): void {
    this.write({ n, phase: "end", ...outcome, at: new Date().toISOString() } as JournalLine);
  }

  /** `n` から後（`n` を含む）を消す——「その段からやり直す」 */
  truncateFrom(n: number): void {
    for (const k of [...this.steps.keys()]) if (k >= n) this.steps.delete(k);
    const lines: JournalLine[] = [];
    for (const s of this.all()) {
      lines.push({ n: s.n, phase: "start", key: s.key, at: s.startedAt });
      if (s.launched) lines.push({ n: s.n, phase: "launched", ...s.launched, at: s.startedAt });
      if (s.end) lines.push({ n: s.n, phase: "end", ...s.end } as JournalLine);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    renameSync(tmp, this.file);
  }

  private write(line: JournalLine): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    this.apply(line);
  }

  private apply(line: JournalLine): void {
    if (line.phase === "start") {
      this.steps.set(line.n, { n: line.n, key: line.key, startedAt: line.at });
      return;
    }
    const s = this.steps.get(line.n);
    if (!s) return;
    if (line.phase === "launched") s.launched = { replyId: line.replyId, ...(line.subagentRunId ? { subagentRunId: line.subagentRunId } : {}) };
    else s.end = line.ok ? { ok: true, value: line.value, at: line.at } : { ok: false, error: line.error, at: line.at };
  }
}
