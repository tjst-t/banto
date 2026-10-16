// **しばらく開いていない Project**（決定・2026-10-16、アーキ仕様 §2.2「しばらく開いていない Project」・v4-frontend.md §6.43）。
//
// 「開いていない」は、人の操作・「今はしない」を押した・作った、のうち一番新しいものからの日数。用事（自動化・届いたもの）で
// 起きたことは数えない——用が済めば眠りに戻る（`project-sleep.ts` の「眠りに戻す」）ので、すぐまた勧めないための例外が要らない。
//
// 時刻は**観測であって人の意図ではないので Event Store に積まない**——`<dataDir>/project-activity.json`（Project ごとに
// `lastHumanAt`・`dismissedAt`）。同じ Project は1分に1回まで書く。ファイルが無ければ、会話の記録の人の最後の発言の時刻
// （無ければ作った日）から埋める。
//
// 候補を決める時計は1本（1時間ごとと起きたとき）。「動いている Service・公開中のもの」は実行場所に聞かないと分からないので、
// `GET /api/projects` のたびには計算せず、時計が決めて覚えた結果を添えるだけ。公開（Publish）は Service を公開するもので、
// 公開の道は Service が動いていなければ届かない——動いている Service を見れば「公開中で使われている」も外れる
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ProjectState } from "../project-thread/types.js";
import type { RunningItem } from "./project-move.js";

/** 何日開いていなければ聞く・眠らせるか。設定にはしない（要ると分かってから、§2.2） */
export const IDLE_DAYS = 14;
/** 時計の間隔 */
export const IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** 同じ Project の `lastHumanAt` を書く間隔の下限 */
const HUMAN_WRITE_INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** banto 全体の設定（instance の層だけ。Project では上書きさせない） */
export const AUTO_SLEEP_KEY = "projects.autoSleep";
export const AUTO_SLEEP_MODES = ["ask", "auto", "off"] as const;
export type AutoSleepMode = (typeof AUTO_SLEEP_MODES)[number];

export function isAutoSleepMode(v: unknown): v is AutoSleepMode {
  return typeof v === "string" && (AUTO_SLEEP_MODES as readonly string[]).includes(v);
}

/** 今の設定。無ければ既定の `ask`。書くときに確かめているので、知らない値は記録が壊れている——黙って既定にしない */
export function autoSleepModeOf(config: Pick<RuntimeConfigStore, "layerValue"> | undefined): AutoSleepMode {
  const v = config?.layerValue(AUTO_SLEEP_KEY);
  if (v === undefined) return "ask";
  if (!isAutoSleepMode(v)) throw new Error(`${AUTO_SLEEP_KEY} の値が不正です: ${JSON.stringify(v)}`);
  return v;
}

export interface ProjectActivityEntry {
  /** 人の操作（人のセッションから、その Project を指す変更の要求）の最後 */
  lastHumanAt?: string;
  /** 「今はしない」を押した最後 */
  dismissedAt?: string;
}

/** 「開いていない」を数え始める時刻——人の操作・「今はしない」・作った、のうち一番新しいもの */
export function lastSeenOf(entry: ProjectActivityEntry | undefined, createdAt: string): string {
  let latest = createdAt;
  for (const at of [entry?.lastHumanAt, entry?.dismissedAt]) {
    if (at !== undefined && Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}

/** 何日開いていないか（切り捨て） */
export function idleDaysOf(lastSeen: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(lastSeen)) / DAY_MS));
}

/**
 * **会話の記録から、Project ごとの人の最後の発言の時刻**を引く（ファイルが無いときに1回だけ）。人の発言は `message.appended`
 * の `role: "user"` で、機械から届いたものの印（`origin`）が無いもの
 */
export async function lastHumanMessages(
  events: AsyncIterable<{ type: string; payload: unknown; ts: string }>,
  projectOfThread: (threadId: string) => string | undefined,
): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  for await (const e of events) {
    if (e.type !== "message.appended") continue;
    const p = e.payload as { threadId?: unknown; role?: unknown; origin?: unknown };
    if (p.role !== "user" || p.origin !== undefined || typeof p.threadId !== "string") continue;
    const projectId = projectOfThread(p.threadId);
    if (projectId === undefined) continue;
    const prev = latest.get(projectId);
    if (prev === undefined || Date.parse(e.ts) > Date.parse(prev)) latest.set(projectId, e.ts);
  }
  return latest;
}

/** `<dataDir>/project-activity.json` の読み書き */
export class ProjectActivity {
  private entries: Record<string, ProjectActivityEntry> = {};
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  /**
   * 読む。ファイルが無ければ `seed`（Project ごとの人の最後の発言の時刻）で埋めて書く。読めない（壊れた）ファイルは
   * 脇へ退けて同じく埋め直す——観測なので埋め直せる。黙らずに残す
   */
  async load(seed: () => Promise<Map<string, string>>): Promise<void> {
    let text: string | undefined;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (text !== undefined) {
      try {
        this.entries = parseEntries(JSON.parse(text));
        return;
      } catch (err) {
        const aside = `${this.file}.broken-${Date.now()}`;
        console.error(`[host] ${this.file} が読めないので ${aside} へ退けて、会話の記録から埋め直します:`, err);
        await rename(this.file, aside);
      }
    }
    this.entries = {};
    for (const [projectId, at] of await seed()) this.entries[projectId] = { lastHumanAt: at };
    await this.save();
  }

  get(projectId: string): ProjectActivityEntry | undefined {
    return this.entries[projectId];
  }

  /** 人の操作。前に書いてから1分たっていなければ書かない。書いたら true */
  async noteHuman(projectId: string, now: Date): Promise<boolean> {
    const prev = this.entries[projectId]?.lastHumanAt;
    if (prev !== undefined && now.getTime() - Date.parse(prev) < HUMAN_WRITE_INTERVAL_MS) return false;
    this.entries[projectId] = { ...this.entries[projectId], lastHumanAt: now.toISOString() };
    await this.save();
    return true;
  }

  /** 「今はしない」 */
  async dismiss(projectIds: readonly string[], now: Date): Promise<void> {
    for (const id of projectIds) this.entries[id] = { ...this.entries[id], dismissedAt: now.toISOString() };
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.entries, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}

function parseEntries(raw: unknown): Record<string, ProjectActivityEntry> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("形がオブジェクトではありません");
  const out: Record<string, ProjectActivityEntry> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as { lastHumanAt?: unknown; dismissedAt?: unknown } | null;
    const entry: ProjectActivityEntry = {};
    for (const key of ["lastHumanAt", "dismissedAt"] as const) {
      const at = e?.[key];
      if (at === undefined) continue;
      if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error(`${id} の ${key} が時刻ではありません`);
      entry[key] = at;
    }
    out[id] = entry;
  }
  return out;
}

export interface ProjectIdleDeps {
  listProjects(): readonly ProjectState[];
  getProject(projectId: string): ProjectState | undefined;
  activity: ProjectActivity;
  mode(): AutoSleepMode;
  /** host が知っている動いているもの（眠らせるときに断る一覧と同じ） */
  hostActivity(projectId: string): RunningItem[];
  /** いま眠らせている途中か */
  sleepInProgress(projectId: string): boolean;
  /** 実行場所で動いているもの（Service・待たないコマンド・Terminal）。コンテナが止まっていれば空 */
  runningInPlace(projectId: string): Promise<RunningItem[]>;
  /** `by: "auto"` で眠らせる（断る条件は人が眠らせるときと同じ） */
  sleep(projectId: string): Promise<unknown>;
  /** 候補が変わった（画面に一覧を取り直させる） */
  onChange(): void;
  now?: () => Date;
}

/** 眠らせるか聞く印（`GET /api/projects` の各 Project の `idle`） */
export interface ProjectIdleMark {
  days: number;
  suggestSleep: true;
}

/** 候補から外す理由（無ければ候補）。日数は見ない——外すのは「使われている」もの */
export function idleExclusionOf(
  project: ProjectState,
  ctx: { sleepInProgress: boolean; hostActivity: readonly RunningItem[]; running: readonly RunningItem[] },
): string | undefined {
  if (project.status === "closed") return "閉じている";
  if (project.sleep) return "眠っている";
  if (ctx.sleepInProgress) return "眠らせている途中";
  if (project.move) return "別の実行場所へ移している";
  if (ctx.hostActivity.length > 0) return "動いているものがある";
  if (ctx.running.some((r) => r.kind === "service")) return "動いている Service がある";
  return undefined;
}

export class ProjectIdle {
  /** 時計が決めて覚えた候補（Project → 日数） */
  private readonly suggestions = new Map<string, number>();
  private checking: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ProjectIdleDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /**
   * **候補を決める**（時計の1刻み）。`only` を渡せば、その Project だけを見直す（ほかの覚えた候補はそのまま）。
   * `ask` なら覚え、`auto` なら眠らせ、`off` なら何もしない（覚えていた候補も消す）。同時には1本だけ走る
   */
  check(opts: { now?: Date; only?: readonly string[] } = {}): Promise<void> {
    // 失敗はここで残す（時計は次の刻みでまた見る）。呼んだ側は終わるのを待つだけ
    this.checking = this.checking
      .then(() => this.checkOnce(opts))
      .catch((err: unknown) => console.warn("[host] しばらく開いていない Project を確かめられませんでした:", err));
    return this.checking;
  }

  private async checkOnce(opts: { now?: Date; only?: readonly string[] }): Promise<void> {
    const now = opts.now ?? this.now();
    const mode = this.deps.mode();
    const only = opts.only ? new Set(opts.only) : undefined;
    const before = new Map(this.suggestions);
    for (const id of [...this.suggestions.keys()]) if (!only || only.has(id)) this.suggestions.delete(id);
    if (mode !== "off") {
      for (const project of this.deps.listProjects()) {
        if (only && !only.has(project.id)) continue;
        const days = idleDaysOf(lastSeenOf(this.deps.activity.get(project.id), project.createdAt), now);
        if (days < IDLE_DAYS) continue;
        if (!(await this.isCandidate(project))) continue;
        if (mode === "ask") {
          this.suggestions.set(project.id, days);
          continue;
        }
        try {
          await this.deps.sleep(project.id);
          console.log(`[host] ${days}日開いていない project ${project.id} を自動で眠らせました`);
        } catch (err) {
          // 確かめてから眠らせるまでの間に何か始まった等——次の刻みでまた見る（黙らない）
          console.warn(`[host] ${days}日開いていない project ${project.id} を自動で眠らせられませんでした:`, err instanceof Error ? err.message : err);
        }
      }
    }
    if (!sameMap(before, this.suggestions)) this.deps.onChange();
  }

  private async isCandidate(project: ProjectState): Promise<boolean> {
    const ctx = {
      sleepInProgress: this.deps.sleepInProgress(project.id),
      hostActivity: this.deps.hostActivity(project.id),
      running: [] as RunningItem[],
    };
    if (idleExclusionOf(project, ctx) !== undefined) return false;
    try {
      ctx.running = await this.deps.runningInPlace(project.id);
    } catch (err) {
      // 確かめられなければ聞かない・眠らせない（使われているかもしれない）
      console.warn(`[host] project ${project.id} で動いているものを確かめられないので、眠らせる候補にしません:`, err instanceof Error ? err.message : err);
      return false;
    }
    return idleExclusionOf(project, ctx) === undefined;
  }

  /** `GET /api/projects` に添える印。`ask` で、覚えた候補で、まだ起きている Project だけ */
  idleOf(projectId: string): ProjectIdleMark | undefined {
    const days = this.suggestions.get(projectId);
    if (days === undefined || this.deps.mode() !== "ask") return undefined;
    const project = this.deps.getProject(projectId);
    if (!project || project.status === "closed" || project.sleep) return undefined;
    return { days, suggestSleep: true };
  }

  /** **人の操作があった**——数え直し、その場で候補から外す */
  async noteHuman(projectId: string): Promise<void> {
    await this.deps.activity.noteHuman(projectId, this.now());
    if (this.suggestions.delete(projectId)) this.deps.onChange();
  }

  /** **「今はしない」**——`dismissedAt` を今に（さらに 14 日たったらまた聞く）、その場で候補から外す */
  async dismiss(projectIds: readonly string[]): Promise<void> {
    await this.deps.activity.dismiss(projectIds, this.now());
    let changed = false;
    for (const id of projectIds) changed = this.suggestions.delete(id) || changed;
    if (changed) this.deps.onChange();
  }

  /** 時計を回す（起きたときに1回、そのあと1時間ごと）。止める関数を返す */
  start(intervalMs = IDLE_CHECK_INTERVAL_MS): () => void {
    void this.check();
    const timer = setInterval(() => void this.check(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

function sameMap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
