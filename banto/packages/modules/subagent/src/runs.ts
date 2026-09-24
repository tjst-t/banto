// **サブエージェントに頼んだ仕事の記録**（決定・2026-09-24、ユーザー「launcher から一覧や状態を見られる UI」）。
//
// サブエージェントの実行は Subagent Module の持ち物（アーキ仕様 §4.1）——core には返り値の転記しか渡らない
// ので、**何を頼み、いま何をしていて、どう終わったか**を人が見る口はここにしか無い（モックの設計も
// 「中身は Module の Canvas で見る」）。走っている仕事はメモリに、終わった仕事はこの Module の置き場の
// `runs.jsonl` に1行ずつ残す。**エージェント自身の会話の記録は写さない**（それはエージェントの置き場にある
// ——規則3）。残すのは banto 側から見えたこと（頼んだ文・状態・呼んだ tool の題・最後の返答・使用量）だけ。

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunResult } from "./acp-run.js";

export type RunStatus = "running" | "done" | "cancelled" | "error";

export interface RunStep {
  at: number;
  title: string;
  kind?: string;
}

export interface RunRecord {
  id: string;
  agent: string;
  agentTitle: string;
  prompt: string;
  model?: string;
  effort?: string;
  /** 続きから頼んだときの元の session id */
  resumedFrom?: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  /** 走っている間の最後の様子（`ツール：…`・`作業中（…）` など） */
  lastProgress?: string;
  toolCalls: string[];
  /** 呼んだ tool の順と時刻と種類（ACP の `kind`：read・edit・execute…）——画面の「経過」 */
  steps: RunStep[];
  sessionId?: string;
  stopReason?: string;
  text?: string;
  usage?: RunResult["usage"];
  cost?: RunResult["cost"];
  context?: RunResult["context"];
  permissions?: RunResult["permissions"];
  notes?: string[];
  error?: string;
}

/** 一覧に出す分（本文は詳細で取る——一覧を軽くする） */
export type RunSummary = Pick<
  RunRecord,
  "id" | "agent" | "agentTitle" | "status" | "startedAt" | "finishedAt" | "lastProgress" | "cost" | "model"
> & { promptHead: string; toolCount: number; lastStep?: RunStep };

const HEAD = 80;

export class RunLog {
  private readonly running = new Map<string, { record: RunRecord; abort: AbortController }>();
  private finished: RunRecord[] = [];

  constructor(
    private readonly file: string,
    private readonly limit = 200,
  ) {
    if (existsSync(file)) {
      // 壊れた行は読み飛ばさず止める——記録が黙って欠けるほうが困る（規則2）
      this.finished = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const r = JSON.parse(line) as Omit<RunRecord, "steps"> & { steps?: RunStep[] };
          return { ...r, steps: r.steps ?? [] };
        })
        .slice(-limit);
    }
  }

  start(input: Pick<RunRecord, "agent" | "agentTitle" | "prompt" | "model" | "effort" | "resumedFrom">): {
    id: string;
    signal: AbortSignal;
  } {
    const id = randomUUID();
    const abort = new AbortController();
    this.running.set(id, { record: { ...input, id, status: "running", startedAt: Date.now(), toolCalls: [], steps: [] }, abort });
    return { id, signal: abort.signal };
  }

  progress(id: string, message: string): void {
    const r = this.running.get(id);
    if (r) r.record.lastProgress = message;
  }

  toolCall(id: string, title: string, kind?: string): void {
    const r = this.running.get(id);
    if (!r) return;
    r.record.toolCalls.push(title);
    r.record.steps.push({ at: Date.now(), title, ...(kind ? { kind } : {}) });
  }

  /** 書きかけの返答（走っている間だけ。終わったら返り値の全文で置き換わる） */
  text(id: string, textSoFar: string): void {
    const r = this.running.get(id);
    if (r) r.record.text = textSoFar;
  }

  finish(id: string, outcome: { result: RunResult } | { error: string }): void {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    const base = { ...r.record, finishedAt: Date.now() };
    delete base.lastProgress;
    const record: RunRecord =
      "result" in outcome
        ? {
            ...base,
            status: outcome.result.stopReason === "cancelled" ? "cancelled" : "done",
            sessionId: outcome.result.sessionId,
            stopReason: outcome.result.stopReason,
            text: outcome.result.text,
            toolCalls: outcome.result.toolCalls,
            ...(outcome.result.model ? { model: outcome.result.model } : {}),
            ...(outcome.result.usage ? { usage: outcome.result.usage } : {}),
            ...(outcome.result.cost ? { cost: outcome.result.cost } : {}),
            ...(outcome.result.context ? { context: outcome.result.context } : {}),
            permissions: outcome.result.permissions,
            notes: outcome.result.notes,
          }
        : { ...base, status: r.abort.signal.aborted ? "cancelled" : "error", error: outcome.error };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.finished.push(record);
    if (this.finished.length > this.limit) this.finished = this.finished.slice(-this.limit);
  }

  /** 人が画面から止める。走っていなければ、そう言う */
  cancel(id: string): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.record.lastProgress = "止めています…";
    r.abort.abort();
    return true;
  }

  /** 走っているもの（新しい順）→ 終わったもの（新しい順） */
  list(): RunSummary[] {
    const summarize = (r: RunRecord): RunSummary => ({
      id: r.id,
      agent: r.agent,
      agentTitle: r.agentTitle,
      status: r.status,
      startedAt: r.startedAt,
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      ...(r.lastProgress ? { lastProgress: r.lastProgress } : {}),
      ...(r.cost ? { cost: r.cost } : {}),
      ...(r.model ? { model: r.model } : {}),
      promptHead: r.prompt.length > HEAD ? `${r.prompt.slice(0, HEAD)}…` : r.prompt,
      toolCount: r.toolCalls.length,
      ...(r.status === "running" && r.steps.length ? { lastStep: r.steps[r.steps.length - 1] } : {}),
    });
    const running = [...this.running.values()].map((r) => r.record).sort((a, b) => b.startedAt - a.startedAt);
    const finished = [...this.finished].sort((a, b) => b.startedAt - a.startedAt);
    return [...running, ...finished].map(summarize);
  }

  get(id: string): RunRecord | undefined {
    return this.running.get(id)?.record ?? this.finished.find((r) => r.id === id);
  }
}
