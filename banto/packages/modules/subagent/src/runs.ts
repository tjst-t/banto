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

/** 経過の1件の状態（ACP の `ToolCallStatus`）。**前の版の記録には無い**——仕事が終わっていれば済みとして見せる */
export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * **経過の1件**（改訂・2026-10-21、アーキ仕様 §4.1「仕事の画面で、いま何をしているかを分かるようにする」）。tool の呼び出し
 * ごとに1件（`toolCallId` で引き当て、`tool_call_update` で題・説明・触ったファイル・状態を書き換える）か、途中の発言1つ
 * （種類 `message`。tool の呼び出しを挟むたびに区切る。題がその文）
 */
export interface RunStep {
  at: number;
  title: string;
  /** ACP の `kind`（read・edit・execute…）か `message`（途中の発言） */
  kind?: string;
  toolCallId?: string;
  status?: StepStatus;
  /** 終わった時刻（completed・failed が届いたとき） */
  finishedAt?: number;
  /** tool の引数の `description`（Claude の Bash の「テストを流す」など）。エージェントが持たせたときだけ */
  description?: string;
  /** 触ったファイル（`locations`。作業場所からの相対、外は絶対パス） */
  files?: string[];
  /** 大きさの上限で切った */
  truncated?: true;
  /** **走っている間だけ**の版（何番目の書き換えで最後に変わったか）。画面の差分取り（`sinceStep`）に使い、終われば消す */
  v?: number;
}

/** やること一覧の1項目（ACP の `plan` の entry） */
export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 触ったファイル（書いた・読んだ回数と最後の時刻） */
export interface TouchedFile {
  path: string;
  wrote: number;
  read: number;
  lastAt: number;
}

/** tool の呼び出しの始まり（`acp-run.ts` が ACP の `tool_call` から作る） */
export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: StepStatus;
  description?: string;
  files?: string[];
}

/** **記録の大きさの上限**（アーキ仕様 §4.1。数字は最初の値） */
export const STEPS_MAX = 1000;
export const STEP_TITLE_MAX = 300;
export const STEP_DESCRIPTION_MAX = 200;
export const MESSAGE_MAX = 2000;
export const STEP_BYTES_MAX = 16 * 1024;

/** 1行に収めて max 字で切る（越えたら「…」） */
export function clipLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 呼び名の長さの上限（字）。カードの題が畳むのと同じ長さ（Shell の `label` と同じ決まり） */
export const LABEL_MAX = 80;

/** 呼び名を1行に収めて `LABEL_MAX` 字で切る。空白だけなら無いのと同じ（カードの題も頼んだ文に戻る） */
export function labelOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const line = clipLine(raw, LABEL_MAX);
  return line === "" ? undefined : line;
}

/** 書いた（edit・delete・move）か読んだ（read）か。ほかの種類（search・execute・fetch…）は数えない */
function touchOf(kind: string | undefined): "wrote" | "read" | undefined {
  if (kind === "edit" || kind === "delete" || kind === "move") return "wrote";
  if (kind === "read") return "read";
  return undefined;
}

export interface RunRecord {
  id: string;
  agent: string;
  agentTitle: string;
  prompt: string;
  /** **呼び名**（追加・2026-10-21、`runSubagent` の `label`。1行・`LABEL_MAX` 字に整えたもの）。一覧・カード・サイドバーの題。無ければ頼んだ文の頭 */
  label?: string;
  model?: string;
  effort?: string;
  /** 続きから頼んだときの元の session id */
  resumedFrom?: string;
  /**
   * **頼んだ Thread**（追加・2026-10-03）。host が AI のターンの呼び出しに刻んだ印（`dev.banto/thread`）を写す。
   * AI が止める口（`cancelSubagent`）は、これと同じ Thread からの呼び出しだけを通す。刻印の無い呼び出しで頼んだものは持たない
   */
  requestedBy?: { projectId: string; threadId: string };
  /**
   * **頼んだ Module**（追加・2026-10-06）。Module が中継で頼んだとき host が刻む印（`dev.banto/callerModule`）を写す。
   * `cancelSubagent` は、同じ Module（接続名）からの呼び出しだけを通す
   */
  requestedByModule?: { name: string; conn: string };
  /** 作業場所（Project の根の中。頼むときに選べる——既定は根） */
  cwd?: string;
  /** 決まった形で返させたなら、その形に合った JSON（`schema`） */
  structured?: unknown;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  /** 走っている間の最後の様子（`ツール：…`・`作業中（…）` など） */
  lastProgress?: string;
  toolCalls: string[];
  /** 経過——呼んだ tool と途中の発言を順に（新しい `STEPS_MAX` 件まで） */
  steps: RunStep[];
  /** 上限を越えて畳んだ古い経過の数（画面の「ほか n 件」。経過の番号は `stepsOmitted + 何番目`） */
  stepsOmitted?: number;
  /** 走っている間の経過の版（書き換えるたびに1つ進む）。画面は `getRun` の `sinceStep` にこれを渡して差分を取る */
  stepVersion?: number;
  /** やること一覧（`plan` の最新。置き換えで持つ） */
  plan?: PlanEntry[];
  /** 触ったファイル（tool の種類で書いた・読んだを数える） */
  files?: TouchedFile[];
  /**
   * **起こし直しのあと続けた仕事**（追加・2026-10-21）。起こし直しより前の経過・やること・触ったファイルを持たない
   * ——画面はそう断る
   */
  continuedAfterRestart?: true;
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
  "id" | "agent" | "agentTitle" | "label" | "status" | "startedAt" | "finishedAt" | "lastProgress" | "cost" | "model"
> & {
  promptHead: string;
  toolCount: number;
  lastStep?: RunStep;
  /** 走っている間の「いまやっていること」（動いている tool の説明か題。無ければ最後の発言の頭） */
  current?: { kind: string; title: string };
  /** やること一覧の進み（済んだ数／全部） */
  plan?: { done: number; total: number };
};

const HEAD = 80;

/** 一覧を1回で返す既定の件数（画面は「もっと見る」で増やす） */
export const RUNS_PAGE = 10;

export interface RunPage {
  /** 走っているもの（全部）→ 終わったもの（新しい順に limit 件まで） */
  runs: RunSummary[];
  /** 覚えている終わった仕事の総数 */
  finishedTotal: number;
}

function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i];
  return undefined;
}

/** いまやっていること：動いている tool の最後（説明があれば説明）、無ければ最後の発言の頭 */
function currentOf(r: RunRecord): { kind: string; title: string } | undefined {
  const tool = findLast(r.steps, (s) => s.kind !== "message" && (s.status === "pending" || s.status === "in_progress"));
  if (tool) return { kind: tool.kind ?? "other", title: tool.description ?? tool.title };
  const said = findLast(r.steps, (s) => s.kind === "message");
  return said ? { kind: "message", title: clipLine(said.title, 120) } : undefined;
}

const bytesOf = (step: RunStep) => Buffer.byteLength(JSON.stringify(step));

/** 1件を `STEP_BYTES_MAX` に収める。越えたら触ったファイルを後ろから落とし、それでも越えれば題を詰める（切った印を付ける） */
function fitStep(step: RunStep): void {
  if (bytesOf(step) <= STEP_BYTES_MAX) return;
  step.truncated = true;
  // 越えた割合だけまとめて落とす（1つずつ量り直さない）
  while (step.files && step.files.length > 0 && bytesOf(step) > STEP_BYTES_MAX) {
    const keep = Math.floor((step.files.length * STEP_BYTES_MAX) / bytesOf(step)) - 1;
    step.files.length = Math.max(0, Math.min(step.files.length - 1, keep));
  }
  while (bytesOf(step) > STEP_BYTES_MAX && step.title.length > 0) step.title = step.title.slice(0, Math.floor(step.title.length / 2));
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

  start(
    input: Pick<RunRecord, "agent" | "agentTitle" | "prompt" | "label" | "model" | "effort" | "resumedFrom" | "requestedBy" | "requestedByModule" | "cwd"> & {
      /**
       * 起こし直しのあと続ける仕事は、前の id と頼んだ時刻のまま（追加・2026-10-05）。画面の一覧で同じ仕事が続いて見える
       */
      continues?: { id: string; startedAt: number; notes: string[] };
    },
  ): {
    id: string;
    signal: AbortSignal;
  } {
    const { continues, ...rest } = input;
    const id = continues?.id ?? randomUUID();
    const abort = new AbortController();
    this.running.set(id, {
      record: {
        ...rest,
        id,
        status: "running",
        startedAt: continues?.startedAt ?? Date.now(),
        toolCalls: [],
        steps: [],
        ...(continues ? { notes: continues.notes, continuedAfterRestart: true as const } : {}),
      },
      abort,
    });
    return { id, signal: abort.signal };
  }

  progress(id: string, message: string): void {
    const r = this.running.get(id);
    if (r) r.record.lastProgress = message;
  }

  /** tool の呼び出しが始まった——経過に1件足す（題は仮のことがある。本当の題は `toolUpdate` で届く） */
  toolCall(id: string, call: ToolCallView): void {
    const r = this.running.get(id);
    if (!r) return;
    const at = Date.now();
    r.record.toolCalls.push(clipLine(call.title, STEP_TITLE_MAX));
    const step: RunStep = { at, title: "", toolCallId: call.toolCallId, status: call.status ?? "pending" };
    this.push(r.record, step);
    this.applyTool(r.record, step, call, at);
  }

  /** tool の呼び出しの書き換え（`tool_call_update`）。届いた欄だけ変える。知らない呼び出しは何もしない */
  toolUpdate(id: string, toolCallId: string, changes: Partial<Omit<ToolCallView, "toolCallId">>): void {
    const r = this.running.get(id);
    if (!r) return;
    const step = findLast(r.record.steps, (s) => s.toolCallId === toolCallId);
    if (!step) return;
    // 走っている間の `toolCalls` は数を見るだけ（終われば `acp-run.ts` が本当の題で返した一覧に置き換わる）
    this.applyTool(r.record, step, changes, Date.now());
  }

  /** 途中の発言の一片。直前の経過が発言ならそこに足し、tool を挟んでいたら新しい1件にする */
  message(id: string, chunk: string): void {
    const r = this.running.get(id);
    if (!r || chunk === "") return;
    const last = r.record.steps.at(-1);
    if (last && last.kind === "message") {
      if (last.truncated) return;
      const joined = last.title + chunk;
      last.title = joined.length > MESSAGE_MAX ? `${joined.slice(0, MESSAGE_MAX)}…` : joined;
      if (joined.length > MESSAGE_MAX) last.truncated = true;
      this.bump(r.record, last);
      return;
    }
    const step: RunStep = { at: Date.now(), kind: "message", title: chunk.slice(0, MESSAGE_MAX) };
    if (chunk.length > MESSAGE_MAX) {
      step.title += "…";
      step.truncated = true;
    }
    this.push(r.record, step);
  }

  /** やること一覧（届くたびに丸ごと置き換える） */
  plan(id: string, entries: PlanEntry[]): void {
    const r = this.running.get(id);
    if (r) r.record.plan = entries.map((e) => ({ content: clipLine(e.content, STEP_TITLE_MAX), status: e.status }));
  }

  private push(record: RunRecord, step: RunStep): void {
    record.steps.push(step);
    if (record.steps.length > STEPS_MAX) {
      const over = record.steps.length - STEPS_MAX;
      record.steps.splice(0, over);
      record.stepsOmitted = (record.stepsOmitted ?? 0) + over;
    }
    this.bump(record, step);
  }

  private bump(record: RunRecord, step: RunStep): void {
    record.stepVersion = (record.stepVersion ?? 0) + 1;
    step.v = record.stepVersion;
  }

  /** 題・種類・状態・説明・触ったファイルを書き、新しく触ったファイルを数え、1件の大きさを上限に収める */
  private applyTool(record: RunRecord, step: RunStep, changes: Partial<Omit<ToolCallView, "toolCallId">>, at: number): void {
    if (changes.title !== undefined) step.title = clipLine(changes.title, STEP_TITLE_MAX);
    if (changes.kind !== undefined) step.kind = changes.kind;
    if (changes.description !== undefined) step.description = clipLine(changes.description, STEP_DESCRIPTION_MAX);
    if (changes.status !== undefined) {
      step.status = changes.status;
      if ((changes.status === "completed" || changes.status === "failed") && step.finishedAt === undefined) step.finishedAt = at;
    }
    if (changes.files !== undefined) {
      const before = new Set(step.files ?? []);
      const touch = touchOf(step.kind);
      for (const path of changes.files) {
        if (before.has(path) || !touch) continue;
        const files = (record.files ??= []);
        const found = files.find((f) => f.path === path);
        if (found) {
          found[touch] += 1;
          found.lastAt = at;
        } else {
          files.push({ path, wrote: touch === "wrote" ? 1 : 0, read: touch === "read" ? 1 : 0, lastAt: at });
        }
      }
      step.files = [...new Set([...(step.files ?? []), ...changes.files])];
    }
    fitStep(step);
    this.bump(record, step);
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
    // 版は走っている間の差分取りのためだけ——終わった仕事の画面は丸ごと読む
    delete base.stepVersion;
    base.steps = base.steps.map(({ v: _v, ...step }) => step);
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
            ...((outcome.result as { structured?: unknown }).structured !== undefined
              ? { structured: (outcome.result as { structured?: unknown }).structured }
              : {}),
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
      ...(r.label ? { label: r.label } : {}),
      status: r.status,
      startedAt: r.startedAt,
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      ...(r.lastProgress ? { lastProgress: r.lastProgress } : {}),
      ...(r.cost ? { cost: r.cost } : {}),
      ...(r.model ? { model: r.model } : {}),
      promptHead: r.prompt.length > HEAD ? `${r.prompt.slice(0, HEAD)}…` : r.prompt,
      toolCount: r.toolCalls.length,
      ...(r.status === "running" && r.steps.length ? { lastStep: r.steps[r.steps.length - 1] } : {}),
      ...(r.status === "running" && currentOf(r) ? { current: currentOf(r)! } : {}),
      ...(r.plan?.length ? { plan: { done: r.plan.filter((p) => p.status === "completed").length, total: r.plan.length } } : {}),
    });
    const running = [...this.running.values()].map((r) => r.record).sort((a, b) => b.startedAt - a.startedAt);
    // 同じ時刻なら後から足したほうを先に（並べ替えは安定なので、逆順にしてから並べる）
    const finished = [...this.finished].reverse().sort((a, b) => b.startedAt - a.startedAt);
    return [...running, ...finished].map(summarize);
  }

  /**
   * **画面に渡す1件**（`getRun`）。`sinceStep` を渡すと、走っている仕事なら**その版より後に変わった経過だけ**を返す
   * （`stepsSince` に受けた版。いまの状況の欄——やること・触ったファイル・返答…——は丸ごと）。終わった仕事は丸ごと
   * （`stepsSince` を付けない）。経過の1件には番号 `n`（`stepsOmitted + 何番目`）を付ける——画面は差分を番号で重ねる
   */
  view(id: string, sinceStep?: number): (Omit<RunRecord, "steps"> & { steps: (RunStep & { n: number })[]; stepsSince?: number }) | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    const omitted = record.stepsOmitted ?? 0;
    const numbered = record.steps.map((step, i) => ({ ...step, n: omitted + i }));
    if (sinceStep === undefined || record.status !== "running") return { ...record, steps: numbered };
    return { ...record, steps: numbered.filter((s) => (s.v ?? 0) > sinceStep), stepsSince: sinceStep };
  }

  get(id: string): RunRecord | undefined {
    // 同じ id が2つあれば新しいほう（起こし直しのあと続けた仕事は、前の id のまま——2026-10-05）
    return this.running.get(id)?.record ?? [...this.finished].reverse().find((r) => r.id === id);
  }
}
