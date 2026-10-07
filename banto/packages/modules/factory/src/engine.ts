// **Factory の実行**（v4-modules.md §4.5）——Backlog のタスクを手順どおりに main まで運ぶ。
//
// 分け方（「手順のカスタマイズ」）：
//   - **Factory が必ず守る**（この file）：Backlog を in-progress にして done か ready に戻して終える・worktree を作って
//     片づける・main へは Project で1本の列から fast-forward で入る（入る直前に必ずテストを通す）・記録と再開
//   - **手順が自由にしてよい**（`procedure.ts`）：worktree ができてから「マージを頼む」までの段（実装・テスト・レビュー）
//
// 段はどれも `ItemPass.step` を通る（記録に残り、流し直したら記録を返す——`journal.ts`）。人への問い（`ask`）も段なので、
// 答えたあと Factory が起き直しても同じところから続く。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Journal, type StepRecord } from "./journal.js";
import type { AgentChoice, FactorySettings } from "./settings.js";

// ---- 外への口（試験は偽物を渡す） --------------------------------------------------------------------------

export interface RelayResult {
  text: string;
  isError: boolean;
  meta?: Record<string, unknown>;
  /** 宛先が返した構造（`structuredContent`） */
  structured?: Record<string, unknown>;
}

export interface FactoryPorts {
  /** 依存先の Module（役割で指す）の tool を host の中継で呼ぶ。`callId` は、いま処理している AI の呼び出しの印 */
  call(role: "subagent" | "backlog", tool: string, args: Record<string, unknown>, callId?: string): Promise<RelayResult>;
  /** コマンドを走らせる（Project のコンテナの中）。終了コードと出力（標準出力と標準エラーを混ぜたもの） */
  exec(argv: string[], opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{ code: number; out: string }>;
}

/** Subagent が返す仕事の結果（`runSubagent` の返り値の形のうち使うもの） */
export interface AgentResult {
  text: string;
  sessionId: string;
  structured?: unknown;
  subagentRunId?: string;
}

export interface TestResult {
  ok: boolean;
  code: number;
  tail: string;
}

/** 人の答え（`answerFactory`） */
export type Answer =
  | { action: "continue"; instruction?: string }
  /** レビューの指摘のところで止まったとき「このまま取り込む」。ほかの止まり方では「続ける」と同じ */
  | { action: "accept" }
  | { action: "retry"; stage?: string }
  | { action: "drop"; reason?: string };

// ---- 記録の形 ----------------------------------------------------------------------------------------------

export type ItemStatus = "queued" | "running" | "stopped" | "merging" | "done" | "dropped";

export interface TaskSnapshot {
  id: string;
  number: number | null;
  kind: string;
  title: string;
  body: string;
  doneWhen: string;
  parent?: { id: string; title: string; body: string };
}

export interface RunItem {
  task: TaskSnapshot;
  status: ItemStatus;
  stage: string;
  stageSince: string;
  worktree: string;
  branch: string;
  /** `notified`：頼んだ Thread に知らせが届いた（流し直しで同じ問いに戻ったとき、届け直さない） */
  stopped?: { reason: string; stage: string; since: string; notified?: boolean };
  /** いま走っているサブエージェントの仕事（Subagent の画面で開ける） */
  subagentRunId?: string;
  lastTest?: TestResult & { at: string };
  lastReview?: { verdict: string; items: unknown[]; at: string };
  finishedAt?: string;
  result?: string;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  settings: FactorySettings;
  items: RunItem[];
  /** 頼んだ Thread（host の刻印）。知らせの宛先の確かめに使うだけ */
  requestedBy?: { projectId: string; threadId: string };
  /** 知らせの札の指紋（札そのものは書かない）——起き直したあと host に問われたとき照らす */
  handleFingerprints: string[];
  finishedAt?: string;
  /** 知らせられなかったこと（札が無い・使い切った） */
  notifyErrors: string[];
}

// ---- 返事の受け箱 ------------------------------------------------------------------------------------------

export interface ModuleReply {
  replyId: string;
  from: string;
  title: string;
  text: string;
  final: boolean;
  lost: boolean;
}

/**
 * host が受け口に渡した返事を、**ファイルに残してから**受け取ったことにする——受け口が「受けた」と返したあと Factory が
 * 落ちても、返事は失われない
 */
export class ReplyBox {
  private readonly waiters = new Map<string, Array<(r: ModuleReply) => void>>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  receive(reply: ModuleReply): void {
    if (!/^[A-Za-z0-9_-]+$/.test(reply.replyId)) throw new Error("返事の印の形が違います");
    const path = join(this.dir, `${reply.replyId}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(reply));
    renameSync(`${path}.tmp`, path);
    for (const w of this.waiters.get(reply.replyId) ?? []) w(reply);
    this.waiters.delete(reply.replyId);
  }

  peek(replyId: string): ModuleReply | undefined {
    const path = join(this.dir, `${replyId}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ModuleReply) : undefined;
  }

  wait(replyId: string, signal: AbortSignal): Promise<ModuleReply> {
    const have = this.peek(replyId);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(replyId) ?? [];
      list.push(resolve);
      this.waiters.set(replyId, list);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  forget(replyId: string): void {
    rmSync(join(this.dir, `${replyId}.json`), { force: true });
  }
}

// ---- 手順の側から見える口 ----------------------------------------------------------------------------------

/** 手順（`procedure.ts`）に渡す口。どれも段として記録される */
export interface ProcedureContext {
  readonly task: TaskSnapshot;
  readonly settings: FactorySettings;
  /** worktree の場所（Project の根からの相対） */
  readonly worktree: string;
  readonly branch: string;
  /** いまの段の名前を変える（画面と一覧に出る） */
  stage(name: string): Promise<void>;
  /** サブエージェントに頼んで、終わるまで待つ（待たない形で頼み、返事は受け口で受ける） */
  agent(role: "implementer" | "reviewer", input: { prompt: string; sessionId?: string; schema?: Record<string, unknown> }): Promise<AgentResult>;
  /** テストのコマンドを worktree で走らせる */
  test(): Promise<TestResult>;
  /** 取り込む先のブランチより先にあるコミットの数 */
  commitsAhead(): Promise<number>;
  /**
   * **止まって人に聞く**。頼んだ Thread に知らせ、`answerFactory` の答えを待つ。返るのは「続ける」（指示つき）だけ——
   * 「やり直す」「やめる」は Factory が引き取る
   */
  ask(reason: string): Promise<{ instruction?: string; accept?: boolean }>;
}

export type Procedure = (ctx: ProcedureContext) => Promise<void>;

// ---- 中で使う合図 ------------------------------------------------------------------------------------------

/** 記録と流し直しが食い違った（手順が決まった順に段を呼んでいない） */
class Diverged extends Error {}
/** 人の答え（やり直す・やめる）を Factory が引き取る */
class Answered extends Error {
  constructor(
    readonly answer: Exclude<Answer, { action: "continue" } | { action: "accept" }>,
    /** 「やり直す」の段の指定が無いとき、この段の番号から（無ければいまの段の頭から） */
    readonly cutAt?: number,
  ) {
    super(`answered: ${answer.action}`);
  }
}
/** 段が失敗した（記録にも失敗として残る）。どの段か（番号）を持つ——「続ける」はその段からやり直す */
class StepFailed extends Error {
  constructor(
    message: string,
    readonly n: number,
  ) {
    super(message);
  }
}
/** 止めた（`cancelFactory`） */
class Cancelled extends Error {}

/** 1つ取る・返す——同時に走らせる件数と、マージの列 */
class Semaphore {
  private waiting: Array<() => void> = [];
  constructor(private free: number) {}
  tryAcquire(): boolean {
    if (this.free <= 0) return false;
    this.free--;
    return true;
  }
  async acquire(signal: AbortSignal): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => resolve();
      this.waiting.push(go);
      signal.addEventListener(
        "abort",
        () => {
          this.waiting = this.waiting.filter((w) => w !== go);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const now = () => new Date().toISOString();
const tail = (s: string, max = 6000) => (s.length > max ? `…${s.slice(-max)}` : s);

// ---- 本体 --------------------------------------------------------------------------------------------------

export interface FactoryEvents {
  /** 1件が止まって人を待っている。返すのは、頼んだ Thread に届いたか */
  itemStopped(run: RunRecord, item: RunItem): Promise<boolean>;
  /** 実行の全件が終わった（入った・やめた） */
  runFinished(run: RunRecord): Promise<void>;
}

interface LiveItem {
  run: RunRecord;
  item: RunItem;
  journal: Journal;
  abort: AbortController;
  /** 人の答えを待っている問い */
  pendingAnswer?: (a: Answer) => void;
  /** AI の呼び出しが待つ合図：最初のサブエージェントに頼めた・止まった・終わった・順番待ちになった */
  settled: { promise: Promise<void>; resolve: () => void };
  /** 走っているコマンドを止める */
  execAbort?: AbortController;
  cancelReason?: string;
}

export class Factory {
  private readonly runs = new Map<string, RunRecord>();
  private readonly live = new Map<string, LiveItem>(); // `${runId}/${taskId}`
  private slots: Semaphore | undefined;
  private readonly mergeLock = new Semaphore(1);
  /** いま処理している AI の呼び出しの印（実行ごと）——その間の中継は、その呼び出しの仕事として承認が出る */
  private readonly callIds = new Map<string, string>();

  constructor(
    private readonly deps: {
      dataDir: string;
      projectRoot: string;
      ports: FactoryPorts;
      procedure: Procedure;
      events: FactoryEvents;
      replies: ReplyBox;
    },
  ) {}

  private runDir(runId: string) {
    return join(this.deps.dataDir, "runs", runId);
  }

  private save(run: RunRecord): void {
    const dir = this.runDir(run.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json.tmp"), JSON.stringify(run, null, 2));
    renameSync(join(dir, "run.json.tmp"), join(dir, "run.json"));
  }

  /** 起きたとき：終わっていない実行を読み、流し直して続ける */
  resumeAll(): RunRecord[] {
    const base = join(this.deps.dataDir, "runs");
    if (!existsSync(base)) return [];
    const resumed: RunRecord[] = [];
    for (const id of readdirSync(base)) {
      const file = join(base, id, "run.json");
      if (!existsSync(file)) continue;
      const run = JSON.parse(readFileSync(file, "utf8")) as RunRecord;
      this.runs.set(run.id, run);
      if (run.finishedAt) continue;
      resumed.push(run);
      for (const item of run.items) if (item.status !== "done" && item.status !== "dropped") this.startItem(run, item);
    }
    return resumed;
  }

  /** host が受け口に渡した返事（`receiveReply`）。ファイルに残してから受けたことにする */
  receiveReply(reply: ModuleReply): void {
    this.deps.replies.receive(reply);
  }

  /** 1件の段の記録（画面の「何が起きたか」）。ファイルから読み直す */
  journalOf(runId: string, taskId: string): StepRecord[] {
    return new Journal(join(this.runDir(runId), `${taskId}.jsonl`)).all();
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** いま流れている（終わっていない）実行にそのタスクがあるか */
  activeRunOf(taskId: string): RunRecord | undefined {
    return [...this.runs.values()].find(
      (r) => !r.finishedAt && r.items.some((i) => i.task.id === taskId && i.status !== "done" && i.status !== "dropped"),
    );
  }

  /** 流す。返すのは記録だけ——走らせるのは裏で */
  start(input: { tasks: TaskSnapshot[]; settings: FactorySettings; requestedBy?: RunRecord["requestedBy"] }): RunRecord {
    const run: RunRecord = {
      id: randomUUID(),
      createdAt: now(),
      settings: input.settings,
      items: input.tasks.map((task) => ({
        task,
        status: "queued",
        stage: "順番待ち",
        stageSince: now(),
        worktree: join(".worktrees", `factory-${task.id}`),
        branch: `factory/${task.id}`,
      })),
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      handleFingerprints: [],
      notifyErrors: [],
    };
    this.runs.set(run.id, run);
    this.save(run);
    for (const item of run.items) this.startItem(run, item);
    return run;
  }

  /** AI の呼び出しの間だけ、その印を中継に添える（承認がその会話に出る） */
  async withCall<T>(runId: string, callId: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (callId) this.callIds.set(runId, callId);
    try {
      return await fn();
    } finally {
      if (callId && this.callIds.get(runId) === callId) this.callIds.delete(runId);
    }
  }

  /** 走り出した各件が、最初のサブエージェントに頼めた・止まった・終わった・順番待ちになるまで待つ */
  async settled(runId: string): Promise<void> {
    await Promise.all([...this.live.values()].filter((l) => l.run.id === runId).map((l) => l.settled.promise));
  }

  recordHandle(run: RunRecord, fingerprint: string): void {
    if (!run.handleFingerprints.includes(fingerprint)) run.handleFingerprints.push(fingerprint);
    this.save(run);
  }

  noteNotifyError(run: RunRecord, message: string): void {
    run.notifyErrors.push(`${now()} ${message}`);
    this.save(run);
  }

  /** 止まっている1件に答える。止まっていなければ理由を投げる */
  answer(runId: string, taskId: string, answer: Answer): void {
    const live = this.live.get(`${runId}/${taskId}`);
    if (!live || live.item.status !== "stopped" || !live.pendingAnswer) {
      const item = this.runs.get(runId)?.items.find((i) => i.task.id === taskId);
      throw new Error(
        item ? `${taskId} は止まっていません（いま：${item.status}・${item.stage}）` : `実行 ${runId} に ${taskId} はありません`,
      );
    }
    const resolve = live.pendingAnswer;
    live.pendingAnswer = undefined;
    live.settled = deferred();
    resolve(answer);
  }

  /** 止める（実行ごと、か1件）。走っているサブエージェントとコマンドも止め、Backlog は ready に戻す */
  async cancel(runId: string, taskId: string | undefined, reason: string): Promise<string[]> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`実行 ${runId} はありません`);
    const targets = [...this.live.values()].filter((l) => l.run.id === runId && (!taskId || l.item.task.id === taskId));
    if (taskId && targets.length === 0) throw new Error(`${taskId} は走っていません`);
    for (const l of targets) {
      l.cancelReason = reason;
      if (l.pendingAnswer) {
        const resolve = l.pendingAnswer;
        l.pendingAnswer = undefined;
        resolve({ action: "drop", reason });
        continue;
      }
      if (l.item.subagentRunId) {
        await this.deps.ports
          .call("subagent", "cancelSubagent", { runId: l.item.subagentRunId }, this.callIds.get(runId))
          .catch(() => undefined);
      }
      l.execAbort?.abort(new Cancelled(reason));
      l.abort.abort(new Cancelled(reason));
    }
    return targets.map((l) => l.item.task.id);
  }

  // ---- 1件 -------------------------------------------------------------------------------------------------

  private startItem(run: RunRecord, item: RunItem): void {
    const journal = new Journal(join(this.runDir(run.id), `${item.task.id}.jsonl`));
    const live: LiveItem = { run, item, journal, abort: new AbortController(), settled: deferred() };
    this.live.set(`${run.id}/${item.task.id}`, live);
    void this.runItem(live).finally(() => {
      live.settled.resolve();
      this.live.delete(`${run.id}/${item.task.id}`);
      void this.maybeFinish(run);
    });
  }

  private setStage(live: LiveItem, stage: string, status?: ItemStatus): void {
    if (live.item.stage !== stage || (status && live.item.status !== status)) {
      live.item.stage = stage;
      live.item.stageSince = now();
      if (status) live.item.status = status;
      this.save(live.run);
    }
  }

  private async runItem(live: LiveItem): Promise<void> {
    const { item, run } = live;
    if (!this.slots) this.slots = new Semaphore(run.settings.concurrency);
    let holding = false;
    const acquire = async () => {
      if (holding) return;
      if (this.slots!.tryAcquire()) {
        holding = true;
        return;
      }
      live.settled.resolve(); // 順番待ちのあいだ AI の呼び出しを待たせない
      await this.slots!.acquire(live.abort.signal);
      holding = true;
    };
    const release = () => {
      if (!holding) return;
      holding = false;
      this.slots!.release();
    };
    try {
      for (;;) {
        const pass = new ItemPass(this, live, this.deps.ports, this.deps.replies, { acquire, release });
        try {
          await acquire();
          await pass.run(this.deps.procedure);
          item.status = "done";
          item.finishedAt = now();
          item.result = "取り込みました";
          this.setStage(live, "終わった", "done");
          return;
        } catch (err) {
          if (err instanceof Answered && err.answer.action === "retry") {
            pass.rewind(err.answer.stage, err.cutAt);
            continue;
          }
          if (err instanceof Answered && err.answer.action === "drop") {
            await this.dropItem(live, err.answer.reason ?? "人がやめると答えました");
            return;
          }
          if (live.cancelReason || err instanceof Cancelled) {
            await this.dropItem(live, live.cancelReason ?? "止めました");
            return;
          }
          if (err instanceof Diverged) {
            // 記録と食い違う——流し直しで続けられない。人に聞いて、やり直すかやめるか
            const answer = await pass.askOutsideJournal(`記録と手順が食い違いました：${err.message}`);
            item.status = "running";
            delete item.stopped;
            this.save(run);
            if (answer.action === "drop") {
              await this.dropItem(live, answer.reason ?? "人がやめると答えました");
              return;
            }
            pass.rewind(answer.action === "retry" ? answer.stage : undefined, 1);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      // ここに来るのは想定外の失敗（記録が書けない等）。止まったことにして残す
      item.status = "stopped";
      item.stopped = { reason: `Factory の中の失敗：${err instanceof Error ? err.message : String(err)}`, stage: item.stage, since: now() };
      this.save(run);
    } finally {
      release();
    }
  }

  private async dropItem(live: LiveItem, reason: string): Promise<void> {
    const { item, run } = live;
    // Backlog を ready に戻す（中継が断っても、やめたことは残す）
    const r = await this.deps.ports
      .call("backlog", "updateItem", { id: item.task.id, status: "ready" }, this.callIds.get(run.id))
      .catch((err: unknown) => ({ text: String(err), isError: true }));
    item.status = "dropped";
    item.finishedAt = now();
    item.result =
      `やめました：${reason}。worktree（${item.worktree}）とブランチ ${item.branch} は残してあります` +
      (r.isError ? `。Backlog を ready に戻せませんでした：${r.text.slice(0, 200)}` : "");
    delete item.stopped;
    this.setStage(live, "やめた", "dropped");
  }

  private async maybeFinish(run: RunRecord): Promise<void> {
    if (run.finishedAt) return;
    if (!run.items.every((i) => i.status === "done" || i.status === "dropped")) return;
    run.finishedAt = now();
    this.save(run);
    await this.deps.events.runFinished(run).catch((err: unknown) => this.noteNotifyError(run, String(err)));
  }

  // ItemPass が使う
  /** @internal */ callIdOf(runId: string): string | undefined {
    return this.callIds.get(runId);
  }
  /** @internal */ saveRun(run: RunRecord): void {
    this.save(run);
  }
  /** @internal */ stageOf(live: LiveItem, stage: string, status?: ItemStatus): void {
    this.setStage(live, stage, status);
  }
  /** @internal */ get root(): string {
    return this.deps.projectRoot;
  }
  /** @internal */ async stopped(live: LiveItem): Promise<boolean> {
    return this.deps.events.itemStopped(live.run, live.item).catch((err: unknown) => {
      this.noteNotifyError(live.run, String(err));
      return false;
    });
  }
  /** @internal */ mergeQueue(): Semaphore {
    return this.mergeLock;
  }
}

// ---- 1回の流し（記録を先頭から読み直しながら進む） ----------------------------------------------------------

class ItemPass implements ProcedureContext {
  private n = 0;
  private implementerSession: string | undefined;

  constructor(
    private readonly factory: Factory,
    private readonly live: LiveItem,
    private readonly ports: FactoryPorts,
    private readonly replies: ReplyBox,
    private readonly slot: { acquire(): Promise<void>; release(): void },
  ) {}

  get task() {
    return this.live.item.task;
  }
  get settings() {
    return this.live.run.settings;
  }
  get worktree() {
    return this.live.item.worktree;
  }
  get branch() {
    return this.live.item.branch;
  }
  private get abs() {
    return join(this.factory.root, this.worktree);
  }
  private get signal() {
    return this.live.abort.signal;
  }

  /**
   * **段**。記録にあればそれを返し（失敗も同じく投げ直す）、無ければ走らせて記録する。鍵が記録と違えば食い違い
   */
  private async step<T>(key: string, fn: (prev: StepRecord | undefined, n: number) => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.signal.reason;
    const n = ++this.n;
    const prev = this.live.journal.get(n);
    if (prev && prev.key !== key) throw new Diverged(`${n} 番目の段が、記録では「${prev.key}」、いまは「${key}」`);
    if (prev?.end) {
      if (prev.end.ok) return prev.end.value as T;
      throw new StepFailed(prev.end.error, n);
    }
    if (!prev) this.live.journal.start(n, key);
    let value: T;
    try {
      value = await fn(prev, n);
    } catch (err) {
      if (err instanceof Answered || err instanceof Cancelled || err instanceof Diverged || this.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.live.journal.end(n, { ok: false, error: message });
      throw new StepFailed(message, n);
    }
    this.live.journal.end(n, { ok: true, value: value === undefined ? null : value });
    return value;
  }

  /** 中継で呼ぶ。断られたら投げる */
  private async call(role: "subagent" | "backlog", tool: string, args: Record<string, unknown>): Promise<RelayResult> {
    const r = await this.ports.call(role, tool, args, this.factory.callIdOf(this.live.run.id));
    if (r.isError) throw new Error(`${role} の ${tool} が断りました：${r.text.slice(0, 500)}`);
    return r;
  }

  private git(args: string[], cwd = this.abs) {
    return this.ports.exec(["git", ...args], { cwd, signal: this.signal });
  }

  async stage(name: string): Promise<void> {
    await this.step(`stage:${name}`, async () => name);
    this.factory.stageOf(this.live, name, "running");
  }

  async agent(
    role: "implementer" | "reviewer",
    input: { prompt: string; sessionId?: string; schema?: Record<string, unknown> },
  ): Promise<AgentResult> {
    const choice: AgentChoice = role === "implementer" ? this.settings.implementer : this.settings.reviewer;
    const result = await this.step<AgentResult>(`agent:${role}`, async (prev, n) => {
      let replyId = prev?.launched?.replyId;
      if (!replyId) {
        const r = await this.call("subagent", "runSubagent", {
          agent: choice.agent,
          ...(choice.model ? { model: choice.model } : {}),
          ...(choice.effort ? { effort: choice.effort } : {}),
          prompt: input.prompt,
          cwd: this.worktree,
          runInBackground: true,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.schema ? { schema: input.schema } : {}),
        });
        const id = r.meta?.["dev.banto/replyId"];
        if (typeof id !== "string") throw new Error("Subagent が返事の印を返しませんでした（返事を受ける口が無い？）");
        replyId = id;
        let subagentRunId: string | undefined;
        try {
          subagentRunId = (JSON.parse(r.text) as { runId?: string }).runId;
        } catch {
          // 走らせた仕事の id が読めなくても続ける（止めるときに使えないだけ）
        }
        this.live.journal.launched(n, replyId, subagentRunId);
        this.live.item.subagentRunId = subagentRunId;
        this.factory.saveRun(this.live.run);
      } else {
        this.live.item.subagentRunId = prev?.launched?.subagentRunId;
      }
      // 最初のサブエージェントに頼めた——AI の呼び出し（runFactory）はここまで待つ（承認をその会話で出すため）
      this.live.settled.resolve();
      const reply = await this.replies.wait(replyId, this.signal);
      delete this.live.item.subagentRunId;
      if (reply.lost) throw new Error(`${reply.title}：${reply.text}`);
      let body: { text?: string; sessionId?: string; structured?: unknown; error?: string; stopReason?: string; runId?: string };
      try {
        body = JSON.parse(reply.text) as typeof body;
      } catch {
        throw new Error(`サブエージェントの返事が読めません：${reply.text.slice(0, 300)}`);
      }
      if (body.error) throw new Error(`サブエージェントの仕事が失敗しました：${body.error}`);
      if (body.stopReason === "cancelled") throw new Error("サブエージェントの仕事が止められました");
      return {
        text: body.text ?? "",
        sessionId: body.sessionId ?? "",
        ...(body.structured !== undefined ? { structured: body.structured } : {}),
        ...(body.runId ? { subagentRunId: body.runId } : {}),
      };
    });
    if (role === "implementer") this.implementerSession = result.sessionId;
    if (role === "reviewer" && result.structured && typeof result.structured === "object") {
      const s = result.structured as { verdict?: string; items?: unknown[] };
      this.live.item.lastReview = { verdict: String(s.verdict), items: s.items ?? [], at: now() };
      this.factory.saveRun(this.live.run);
    }
    return result;
  }

  async test(): Promise<TestResult> {
    const result = await this.step<TestResult>("test", async () => {
      const ctl = new AbortController();
      this.live.execAbort = ctl;
      const onAbort = () => ctl.abort(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const r = await this.ports.exec(["/bin/sh", "-c", this.settings.testCommand], {
          cwd: this.abs,
          timeoutMs: this.settings.testTimeoutMinutes * 60_000,
          signal: ctl.signal,
        });
        return { ok: r.code === 0, code: r.code, tail: tail(r.out) };
      } finally {
        this.signal.removeEventListener("abort", onAbort);
        delete this.live.execAbort;
      }
    });
    this.live.item.lastTest = { ...result, at: now() };
    this.factory.saveRun(this.live.run);
    return result;
  }

  async commitsAhead(): Promise<number> {
    return this.step("commits-ahead", async () => {
      const r = await this.git(["rev-list", "--count", `${this.settings.targetBranch}..HEAD`]);
      if (r.code !== 0) throw new Error(`git rev-list が失敗しました：${r.out.slice(0, 300)}`);
      return Number(r.out.trim());
    });
  }

  async ask(reason: string): Promise<{ instruction?: string; accept?: boolean }> {
    const answer = await this.step<Answer>("ask", async (prev) => this.waitForAnswer(reason, prev !== undefined));
    this.live.item.status = "running";
    delete this.live.item.stopped;
    this.factory.saveRun(this.live.run);
    if (answer.action === "accept") return { accept: true };
    if (answer.action === "continue") return answer.instruction ? { instruction: answer.instruction } : {};
    throw new Answered(answer);
  }

  /**
   * 記録に残さずに聞く（記録と手順が食い違ったとき——その記録はもう使えない）。起き直すたびに同じ食い違いでここへ来るので、
   * 前の走行で届いた同じ理由の知らせは届け直さない（答えたら止まった印は消すので、残っているのは前の走行のものだけ）
   */
  async askOutsideJournal(reason: string): Promise<Answer> {
    return this.waitForAnswer(reason, true);
  }

  /**
   * 止まって人の答えを待つ。`replayed` は流し直しで、始めたが答えの無かった問いに戻ってきたとき——前の走行で知らせが
   * 届いていれば届け直さない（host を起こし直したあとの札は最後の1回しか使えない。届いていなければ届ける。追加・
   * 2026-10-07、resume-factory）
   */
  private async waitForAnswer(reason: string, replayed = false): Promise<Answer> {
    const { item } = this.live;
    // 前の走行の同じ止まり方（流し直しの間に段の印が status を running に戻すので、止まった印の理由で見る）
    const before = replayed && item.stopped?.reason === reason ? item.stopped : undefined;
    const notified = before?.notified === true;
    item.status = "stopped";
    item.stopped = { reason, stage: item.stage, since: before?.since ?? now(), ...(notified ? { notified } : {}) };
    this.factory.saveRun(this.live.run);
    // 人を待つ間は枠を空ける（ほかの件を進める）
    this.slot.release();
    const answered = new Promise<Answer>((resolve) => (this.live.pendingAnswer = resolve));
    this.live.settled.resolve();
    // 知らせと答えは並べて待つ——起き直したあとの知らせは host の問いまで待つことがあり（server.ts）、その間に来た答えを
    // 止めない（answerFactory が返らなくなる）。答えたあとに届く前だった知らせは、Factory の口が捨てる
    const stop = item.stopped;
    if (!notified) {
      void this.factory.stopped(this.live).then((ok) => {
        if (!ok || item.stopped !== stop) return;
        stop.notified = true;
        this.factory.saveRun(this.live.run);
      });
    }
    const answer = await answered;
    if (answer.action !== "drop") await this.slot.acquire();
    return answer;
  }

  /**
   * 「その段からやり直す」——段の名前があればその段の最後の印の直後から、無ければ `cutAt` から、それも無ければ
   * いまの段（最後の印）の直後から、記録を消す
   */
  rewind(stage: string | undefined, cutAt?: number): void {
    const steps = this.live.journal.all();
    let cut: number;
    if (stage) {
      const marker = [...steps].reverse().find((s) => s.key === `stage:${stage}`);
      if (!marker) throw new Error(`段「${stage}」はまだありません`);
      cut = marker.n + 1;
    } else if (cutAt !== undefined) {
      cut = cutAt;
    } else {
      const marker = [...steps].reverse().find((s) => s.key.startsWith("stage:"));
      cut = marker ? marker.n + 1 : 1;
    }
    this.live.journal.truncateFrom(cut);
  }

  // ---- Factory が必ず守る流れ ----------------------------------------------------------------------------

  async run(procedure: Procedure): Promise<void> {
    const { item } = this.live;
    // 1. 始める：Backlog を in-progress に・worktree を作る・準備のコマンド
    await this.stage("始める");
    await this.step("backlog:in-progress", async () => {
      await this.call("backlog", "updateItem", { id: item.task.id, status: "in-progress" });
      return true;
    });
    await this.step("worktree", async () => {
      if (!existsSync(this.abs)) {
        const r = await this.git(
          ["worktree", "add", this.worktree, "-b", this.branch, this.settings.targetBranch],
          this.factory.root,
        );
        if (r.code !== 0) throw new Error(`worktree を作れませんでした：${r.out.slice(0, 500)}`);
      }
      return this.worktree;
    });
    if (this.settings.prepareCommand) {
      await this.step("prepare", async () => {
        const r = await this.ports.exec(["/bin/sh", "-c", this.settings.prepareCommand], { cwd: this.abs, signal: this.signal });
        if (r.code !== 0) throw new Error(`準備のコマンドが失敗しました（終了コード ${r.code}）：${tail(r.out, 1500)}`);
        return r.code;
      });
    }
    // 2. 手順（実装・テスト・レビュー）——失敗した段は人に聞く。「続ける」はその段からやり直す
    await this.guarded(() => procedure(this));
    // 3. マージの列
    await this.merge();
    // 4. 片づけ
    await this.step("backlog:done", async () => {
      await this.call("backlog", "updateItem", { id: item.task.id, status: "done", resolution: `Factory が取り込みました（${item.branch}）` });
      return true;
    });
    await this.step("cleanup", async () => {
      const removed = await this.git(["worktree", "remove", "--force", this.worktree], this.factory.root);
      const deleted = await this.git(["branch", "-D", this.branch], this.factory.root);
      return { worktree: removed.code === 0, branch: deleted.code === 0 };
    });
  }

  /**
   * 段の失敗を人に聞く。「続ける」は失敗した段からやり直す（記録をそこまで巻き戻して流し直す）
   */
  private async guarded(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof StepFailed)) throw err;
      const answer = await this.step<Answer>("ask", async (prev) => this.waitForAnswer(`段が失敗しました：${err.message}`, prev !== undefined));
      this.live.item.status = "running";
      delete this.live.item.stopped;
      if (answer.action === "continue" || answer.action === "accept") throw new Answered({ action: "retry" }, err.n);
      throw new Answered(answer, answer.action === "retry" && !answer.stage ? err.n : undefined);
    }
  }

  /** **マージの列**——Project で1本。最新の取り込み先に rebase → テスト → fast-forward。動いていたら rebase から */
  private async merge(): Promise<void> {
    const target = this.settings.targetBranch;
    this.factory.stageOf(this.live, "マージ待ち", "merging");
    this.slot.release();
    const lock = this.factory.mergeQueue();
    const queue = {
      held: false,
      async acquire(signal: AbortSignal) {
        await lock.acquire(signal);
        this.held = true;
      },
      release() {
        if (!this.held) return;
        this.held = false;
        lock.release();
      },
    };
    await queue.acquire(this.signal);
    try {
      await this.stage("マージ");
      this.factory.stageOf(this.live, "マージ", "merging");
      // 流し始めた設定に無い（前の版で流した）実行は既定の回数
      const conflictLimit = this.settings.limits.conflictFixes ?? 2;
      let conflicts = 0;
      for (let attempt = 0; ; attempt++) {
        const rebased = await this.step<{ ok: boolean; out: string }>("rebase", async () => {
          const r = await this.git(["rebase", target]);
          if (r.code === 0) return { ok: true, out: "" };
          await this.git(["rebase", "--abort"]);
          return { ok: false, out: tail(r.out, 2000) };
        });
        if (!rebased.ok && conflicts < conflictLimit) {
          // **競合はまず実装役に解かせる**（2026-10-07、本物の受け入れで発覚）——並べて流した2件が同じファイルの末尾に足すだけで
          // 競合する（関数を1つずつ足す件どうしでほぼ毎回）。人に聞くのは、解かせても解けなかったときだけ
          conflicts++;
          await this.resolveConflict(queue, rebased.out, conflicts);
          continue;
        }
        if (!rebased.ok) {
          await this.askMerge(queue, `${conflicts > 0 ? `実装役に ${conflicts} 回解かせても ` : ""}${target} に rebase できませんでした（競合）。`
            + `worktree（${this.worktree}）で直してコミットしてから「続ける」と答えてください：${rebased.out}`);
          conflicts = 0;
          continue;
        }
        const t = await this.test();
        if (!t.ok) {
          await this.askMerge(queue, `取り込む直前のテストが落ちました（終了コード ${t.code}）：${tail(t.tail, 2000)}`);
          continue;
        }
        const ff = await this.step<{ ok: boolean; moved?: boolean; out: string }>("fast-forward", async () => this.fastForward());
        if (ff.ok) return;
        if (ff.moved && attempt < this.settings.limits.rebaseRetries) continue;
        await this.askMerge(
          queue,
          ff.moved
            ? `${target} が動き続けて取り込めませんでした（${attempt + 1} 回）`
            : `${target} に fast-forward できませんでした：${ff.out}`,
        );
      }
    } finally {
      queue.release();
    }
  }

  /**
   * **競合を実装役に解かせる**。その間はマージの列を空ける（ほかの件を取り込めるように）。実装役の同じ会話に頼み、終わったら
   * worktree が rebase の途中で残っていないか確かめる（残っていれば畳む——次の rebase がやり直す）
   */
  private async resolveConflict(
    queue: { acquire(signal: AbortSignal): Promise<void>; release(): void },
    out: string,
    n: number,
  ): Promise<void> {
    const target = this.settings.targetBranch;
    queue.release();
    try {
      const prompt =
        `取り込む先の ${target} が先に進み、あなたの変更と競合しました（${n} 回目）。このフォルダで次をしてください：\n` +
        `1. \`git rebase ${target}\` を実行し、競合を解く。${target} に入った変更を消さず、両方が活きる形にする\n` +
        "2. `git add` と `git rebase --continue` で rebase を終える（途中で残さない）\n" +
        `3. テスト（\`${this.settings.testCommand}\`）を通す。直したら新しいコミットにしてよい\n\n` +
        `rebase したときの出力：\n\`\`\`\n${tail(out, 3000)}\n\`\`\``;
      const session = this.implementerSession;
      await this.agent("implementer", session ? { prompt, sessionId: session } : { prompt: `${taskHeader(this.task)}\n\n${prompt}` });
      await this.step("rebase-leftover", async () => {
        const inProgress = await this.git(["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]);
        if (inProgress.code === 0) {
          await this.git(["rebase", "--abort"]);
          return { aborted: true };
        }
        return { aborted: false };
      });
    } finally {
      await queue.acquire(this.signal);
    }
  }

  /** マージの段で止まって聞く。「続ける」は rebase からもう一度 */
  private async askMerge(queue: { acquire(signal: AbortSignal): Promise<void>; release(): void }, reason: string): Promise<void> {
    // 人を待つ間はマージの列を空ける（ほかの件を取り込めるように）
    const answer = await this.step<Answer>("ask", async (prev) => {
      queue.release();
      try {
        return await this.waitForAnswer(reason, prev !== undefined);
      } finally {
        await queue.acquire(this.signal);
      }
    });
    this.live.item.status = "merging";
    delete this.live.item.stopped;
    this.factory.saveRun(this.live.run);
    if (answer.action !== "continue" && answer.action !== "accept") throw new Answered(answer);
  }

  /**
   * 取り込む先のブランチを、この worktree の HEAD まで進める。どこかの作業ツリーで checkout されていれば、そこで
   * `merge --ff-only`（作業ツリーも揃える）。されていなければ ref を compare-and-swap で動かす
   */
  private async fastForward(): Promise<{ ok: boolean; moved?: boolean; out: string }> {
    const target = this.settings.targetBranch;
    const head = (await this.git(["rev-parse", "HEAD"])).out.trim();
    const old = (await this.git(["rev-parse", `refs/heads/${target}`])).out.trim();
    const ancestor = await this.git(["merge-base", "--is-ancestor", old, head]);
    if (ancestor.code !== 0) return { ok: false, moved: true, out: `${target} が先に進んでいます` };
    const list = await this.git(["worktree", "list", "--porcelain"], this.factory.root);
    let checkedOut: string | undefined;
    let path: string | undefined;
    for (const line of list.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line === `branch refs/heads/${target}`) checkedOut = path;
    }
    if (checkedOut) {
      const r = await this.git(["merge", "--ff-only", this.branch], checkedOut);
      if (r.code === 0) return { ok: true, out: "" };
      const now2 = (await this.git(["rev-parse", `refs/heads/${target}`])).out.trim();
      return { ok: false, moved: now2 !== old, out: tail(r.out, 1500) };
    }
    const r = await this.git(["update-ref", `refs/heads/${target}`, head, old], this.factory.root);
    if (r.code === 0) return { ok: true, out: "" };
    return { ok: false, moved: true, out: tail(r.out, 500) };
  }

  /** 実装役の会話（手順が続きを頼むときに使う） */
  get lastImplementerSession(): string | undefined {
    return this.implementerSession;
  }
}

/** 実装役の会話が無いとき（別の手順で流した等）に、どのタスクかを伝える頭書き */
function taskHeader(task: TaskSnapshot): string {
  return `あなたは Backlog のタスク「${task.title}」（${task.id}）を実装した担当の代わりです。このフォルダ（git の worktree）にその変更があります。`;
}
