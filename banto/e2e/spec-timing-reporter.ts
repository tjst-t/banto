// **回の終わりに、spec ファイルごとの所要時間を出す**（追加・2026-10-08）。
//
// list の reporter は試験ごとの秒数を流すだけで、どの spec が回を長くしているかは残らない（フル E2E が 58 分かかった
// とき、どこに時間を使ったか答えられなかった）。workers=1 で spec ファイルは並ばずに1本ずつ走るので、**ファイルの最初の
// 試験が始まってから最後の試験が終わるまで**をそのファイルの所要時間とする（beforeAll・後片づけの fixture も入る）。
// 中身は test-results/spec-timing.json にも残す。
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOP = 15;

interface Span {
  file: string;
  start: number;
  end: number;
  tests: number;
  failed: number;
}

export default class SpecTimingReporter implements Reporter {
  private spans = new Map<string, Span>();
  private runStart = Date.now();

  onBegin(): void {
    this.runStart = Date.now();
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    const file = relative(HERE, test.location.file);
    const span = this.spans.get(file);
    const start = result.startTime.getTime();
    if (!span) this.spans.set(file, { file, start, end: start, tests: 0, failed: 0 });
    else span.start = Math.min(span.start, start);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const span = this.spans.get(relative(HERE, test.location.file));
    if (!span) return;
    span.end = Math.max(span.end, result.startTime.getTime() + result.duration);
    span.tests++;
    if (result.status !== "passed" && result.status !== "skipped") span.failed++;
  }

  onEnd(result: FullResult): void {
    const spans = [...this.spans.values()].map((s) => ({ ...s, ms: s.end - s.start }));
    spans.sort((a, b) => b.ms - a.ms);
    const total = Date.now() - this.runStart;
    const inSpecs = spans.reduce((n, s) => n + s.ms, 0);
    const fmt = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}分` : `${(ms / 1000).toFixed(1)}秒`);
    const lines = [
      ``,
      `[e2e] spec ごとの所要時間（上位 ${Math.min(TOP, spans.length)} / ${spans.length} 本）`,
      ...spans.slice(0, TOP).map(
        (s, i) =>
          `  ${String(i + 1).padStart(2)}. ${fmt(s.ms).padStart(7)}  ${s.file}（${s.tests} 件${s.failed ? `・落ち ${s.failed}` : ""}）`,
      ),
      `[e2e] 回の合計 ${fmt(total)}（onBegin から。spec の中 ${fmt(inSpecs)}・spec の外 ${fmt(total - inSpecs)}）・結果 ${result.status}`,
    ];
    console.log(lines.join("\n"));
    const out = join(HERE, "test-results", "spec-timing.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ totalMs: total, status: result.status, specs: spans }, null, 2));
  }

  printsToStdio(): boolean {
    return false;
  }
}
