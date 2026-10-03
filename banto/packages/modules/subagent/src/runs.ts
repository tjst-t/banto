// **サブエージェントに頼んだ仕事の記録**（決定・2026-09-24、ユーザー「launcher から一覧や状態を見られる UI」）。
//
// サブエージェントの実行は Subagent Module の持ち物（アーキ仕様 §4.1）——core には返り値の転記しか渡らない
// ので、**何を頼み、いま何をしていて、どう終わったか**を人が見る口はここにしか無い（モックの設計も
// 「中身は Module の Canvas で見る」）。走っている仕事はメモリに、終わった仕事はこの Module の置き場の
// `runs.jsonl` に1行ずつ残す。**エージェント自身の会話の記録は写さない**（それはエージェントの置き場にある
// ——規則3）。残すのは banto 側から見えたこと（頼んだ文・状態・呼んだ tool の題・最後の返答・使用量）だけ。

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  /**
   * **頼んだ Thread**（追加・2026-10-03）。host が AI のターンの呼び出しに刻んだ印（`dev.banto/thread`）を写す。
   * AI が止める口（`cancelSubagent`）は、これと同じ Thread からの呼び出しだけを通す。刻印の無い呼び出しで頼んだものは持たない
   */
  requestedBy?: { projectId: string; threadId: string };
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

/** 一覧を1回で返す既定の件数（画面は「もっと見る」で増やす） */
export const RUNS_PAGE = 10;

export interface RunPage {
  /** 走っているもの（全部）→ 終わったもの（新しい順に limit 件まで） */
  runs: RunSummary[];
  /** 覚えている終わった仕事の総数 */
  finishedTotal: number;
}

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
      // 前の版は消さずに足し続けていた——上限を超えた分はここで詰める（下の compact）
      this.compact();
    }
  }

  /**
   * **覚える数（limit）を超えた古い記録はファイルからも消す**（決定・2026-10-01、ユーザー要望「増え続けると重くなる」）。
   * 以前はメモリだけ limit 件に絞り、ファイルは足し続けていた（1件あたり十数 KB、起こすたびに全部読む）。
   * 起こしたときと、上限を超えてから limit 件足すごとに、覚えている分だけで書き直す（一時ファイル→rename）
   * ——ファイルは多くても limit の2倍の行。毎回は書き直さない
   */
  private compact(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim() !== "").length;
    if (lines <= this.finished.length) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.finished.map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  start(input: Pick<RunRecord, "agent" | "agentTitle" | "prompt" | "model" | "effort" | "resumedFrom" | "requestedBy">): {
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
    if (this.finished.length > this.limit) {
      this.finished = this.finished.slice(-this.limit);
      this.appendedSinceCompact += 1;
      if (this.appendedSinceCompact >= this.limit) {
        this.appendedSinceCompact = 0;
        this.compact();
      }
    }
  }

  private appendedSinceCompact = 0;

  /** 人が画面から止める（AI の口は、頼んだ Thread を確かめてから呼ぶ）。走っていなければ、そう言う */
  cancel(id: string): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.record.lastProgress = "止めています…";
    r.abort.abort();
    return true;
  }

  /** 走っているもの（新しい順・全部）→ 終わったもの（新しい順・limit 件まで）——画面は「もっと見る」で limit を増やす */
  page(limit = RUNS_PAGE): RunPage {
    const all = this.list();
    const running = all.filter((r) => r.status === "running");
    const finished = all.filter((r) => r.status !== "running");
    return { runs: [...running, ...finished.slice(0, Math.max(0, limit))], finishedTotal: finished.length };
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
    // 同じ時刻なら後から足したほうを先に（並べ替えは安定なので、逆順にしてから並べる）
    const finished = [...this.finished].reverse().sort((a, b) => b.startedAt - a.startedAt);
    return [...running, ...finished].map(summarize);
  }

  get(id: string): RunRecord | undefined {
    return this.running.get(id)?.record ?? this.finished.find((r) => r.id === id);
  }
}
