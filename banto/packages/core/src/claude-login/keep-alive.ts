// **空いた会話のキャッシュの温め直し**（cache keep-alive。決定・2026-10-20、ユーザー。`docs/specs/v4-architecture.md` §3.1
// 「温め直し（中継）」）。
//
// 本体の会話（Runner）の要求は中継を通る。中継はターンの中で入力の量（`input + cache_read + cache_creation`）が最大の要求の
// 本文・認証以外の見出し・通したアカウントを覚え、host がターンの終わりに「この会話は温めてよい」と渡したら、最後の要求の
// 開始から 50・100・150・200 分に、同じ本文を `max_tokens: 0`・`stream` 無しで同じアカウントへ送る（API の pre-warm——prefill
// だけ走り、キャッシュの寿命1時間が数え直される）。
//
// **不変条件：温め直しはキャッシュが当たっているときだけ**——外れた（`cache_creation` が入力の1割を超えた）・失敗した・
// 余白を割った・押し出された会話は、その1回で止めて再開しない。**送り直さない**（中継の送り直しの道に乗せない）。
//
// 覚えた本文はメモリだけ（Buffer）。ログには1回1行（Project・Thread・アカウント・`cache_read`・使用率）だけ——本文には tool の
// 結果（秘密を含みうる）が入るので、断片も出さない。起こし直すと全部消える（その会話は温めない）。

/** 温め直す時刻（最後の本物の要求の開始から、分）。4時間まで（§3.1「境目を 4時間にした理由」） */
export const KEEP_ALIVE_MINUTES = [50, 100, 150, 200] as const;
/** 送る時刻を散らす幅（分。起こし直し・多くの会話が同時に空いたときに一斉に送らない） */
const JITTER_MINUTES = 5;
/** これより入力の少ない会話は温めない（書き直しても安い） */
export const KEEP_ALIVE_MIN_INPUT_TOKENS = 50_000;
/** 外れたとみなす `cache_creation` の割合（入力の量に対して） */
const MISS_RATIO = 0.1;
/** 同時に温める会話の数（段0の値から出した仮の値。測り直してから決める） */
export const KEEP_ALIVE_MAX_ENTRIES = 20;
/** 5時間の窓で温め直しに使う入力の量（読み出し。段0の換算で使用率 約5%。仮の値） */
export const KEEP_ALIVE_WINDOW_TOKENS = 20_000_000;
const WINDOW_MS = 5 * 60 * 60_000;
/** 覚える本文の上限（1本・合計） */
export const KEEP_ALIVE_BODY_LIMIT = 32 * 1024 * 1024;
export const KEEP_ALIVE_TOTAL_LIMIT = 256 * 1024 * 1024;

/** 応答の usage（`message_start` の `message.usage`、または stream でない応答の `usage`） */
export interface CacheUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function inputTotal(u: CacheUsage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** キャッシュに当たった（`cache_creation` が入力の1割以下） */
export function cacheHit(u: CacheUsage): boolean {
  return u.cacheCreationTokens <= inputTotal(u) * MISS_RATIO;
}

/** 応答の JSON の usage を読む（形が違えば undefined） */
export function usageFromJson(usage: unknown): CacheUsage | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (typeof u.input_tokens !== "number") return undefined;
  return { inputTokens: n(u.input_tokens), cacheReadTokens: n(u.cache_read_input_tokens), cacheCreationTokens: n(u.cache_creation_input_tokens) };
}

/** 中継が覚えておく、本体の要求1つ（ターンの中の候補） */
export interface ObservedRequest {
  projectId: string;
  threadId: string;
  /** 均すの固定の鍵（Project＋セッション） */
  key: string;
  sessionId: string | undefined;
  /** 上流のパス（`/v1/messages?beta=true` など） */
  path: string;
  /** 返事をしたアカウント */
  accountId: string;
  /** 中継が要求を受けた時刻（ミリ秒）。温め直しの時刻の基準 */
  startedAt: number;
  /** 応答の usage（読めなかった——2xx でない・形が違う——なら無い） */
  usage?: CacheUsage;
  /** 本文（中継が持てたときだけ。持てなければ候補にしない） */
  body?: Buffer;
  /** 認証と Thread の印を除いた見出し */
  headers?: Record<string, string>;
}

/** 温め直し1回の送り先と中身 */
export interface WarmRequest {
  projectId: string;
  threadId: string;
  key: string;
  accountId: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export type WarmOutcome = { kind: "ok"; usage: CacheUsage; utilization: string } | { kind: "failed"; reason: string };

/** 余白（固定のアカウントの使用率が閾値より 15 ポイント以上下か） */
export type MarginCheck = { ok: true } | { ok: false; reason: string };

/** ターンの終わりに host が渡す「この会話は温めてよい」 */
export interface WarmTicket {
  /** その会話のいまのセッション（覚えた要求のセッションと違えば温めない——ターンの途中の Clear 等） */
  sessionId: string;
  /** 送る前に変わっていないかを確かめる印（モデル・effort・Module の集合・resume-point 等を host が詰める） */
  fingerprint: string;
}

/** その会話のキャッシュの様子（#473 冷める前の要約が読む） */
export interface CacheState {
  sessionId: string | undefined;
  /** 最後の本物の要求か温め直しの時刻と、それが当たったか */
  lastAt: number;
  lastHit: boolean;
  /** 最後に当たった時刻 */
  lastHitAt?: number;
  /** いま温めている（次の温め直しの予定がある） */
  warming: boolean;
  /** 温め直しの回数（このターンのあとの） */
  warms: number;
  /** 温め直しが途中で止まった理由（失敗・外れた・余白を割った・押し出された）。次のターンが始まると消える */
  abandoned?: string;
}

export interface CacheKeepAliveDeps {
  /** 1回送る（送り直さない）。中継が付ける：認証の付け直し・使用率を台帳に覚える・固定の寿命を延ばす */
  send(req: WarmRequest): Promise<WarmOutcome>;
  /** そのアカウントの余白 */
  margin(accountId: string): MarginCheck;
  /** host：送る前に、まだ温めてよいか（ターンが走っていない・印が変わっていない） */
  stillWarmable?(threadId: string, fingerprint: string): boolean;
  now?: () => number;
  /** 0〜1（散らす幅） */
  random?: () => number;
  /** 1分のミリ秒（E2E だけが縮める） */
  minuteMs?: number;
  log?: (line: string) => void;
  /** 時計を回すか（試験は回さず `runDue` を呼ぶ） */
  timers?: boolean;
}

interface Entry {
  req: WarmRequest;
  sessionId: string | undefined;
  inputTokens: number;
  /** 最後の本物の要求の開始 */
  baseAt: number;
  fingerprint: string;
  /** 送った回数 */
  sent: number;
  dueAt: number;
  /** いま送っている */
  inFlight: boolean;
}

interface Collect {
  lastRequestAt?: number;
  best?: ObservedRequest & { body: Buffer; headers: Record<string, string>; usage: CacheUsage };
}

export class CacheKeepAlive {
  /** 温めている会話（Thread ごとに1つ。鍵は持つ要求の `key`） */
  private readonly entries = new Map<string, Entry>();
  /** ターンの中で集めている候補（Thread ごと。ターンが始まってから終わるまで） */
  private readonly collecting = new Map<string, Collect>();
  private readonly states = new Map<string, CacheState>();
  /** 5時間の窓の中で温め直しに使った入力の量 */
  private spent: Array<{ at: number; tokens: number }> = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly minuteMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: CacheKeepAliveDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.minuteMs = deps.minuteMs ?? 60_000;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** **ターンが始まった**：その会話の温め直しを止め、候補を集め始める（人が戻った・届いたもので起きた・Fork の最初のターン） */
  turnStarted(threadId: string): void {
    this.drop(threadId);
    const state = this.states.get(threadId);
    if (state) {
      delete state.abandoned;
      state.warming = false;
      state.warms = 0;
    }
    this.collecting.set(threadId, {});
  }

  /** **中継が本体の要求の返事を読んだ**（usage が読めなくても、時刻の基準として呼ぶ） */
  observe(o: ObservedRequest): void {
    if (o.usage) {
      const hit = cacheHit(o.usage);
      const prev = this.states.get(o.threadId);
      this.states.set(o.threadId, {
        sessionId: o.sessionId,
        lastAt: o.startedAt,
        lastHit: hit,
        ...(hit ? { lastHitAt: o.startedAt } : prev?.lastHitAt !== undefined ? { lastHitAt: prev.lastHitAt } : {}),
        warming: prev?.warming ?? false,
        warms: prev?.warms ?? 0,
        ...(prev?.abandoned ? { abandoned: prev.abandoned } : {}),
      });
    }
    const c = this.collecting.get(o.threadId);
    if (!c) return;
    c.lastRequestAt = Math.max(c.lastRequestAt ?? 0, o.startedAt);
    // 入力の量が最大のものだけを持つ（ターンの終わりの小さな副要求で上書きしない）
    if (!o.usage || !o.body || !o.headers || o.body.length > KEEP_ALIVE_BODY_LIMIT) return;
    if (c.best && inputTotal(c.best.usage) >= inputTotal(o.usage)) return;
    c.best = { ...o, body: o.body, headers: o.headers, usage: o.usage };
  }

  /**
   * **ターンが終わった**。host が「温めてよい」（`ticket`）を渡したときだけ、そのターンで入力が最大の要求を温める。
   * 閉じた Fork・眠っている Project・読むだけの回・スイッチがオフは、host が渡さない
   */
  turnEnded(threadId: string, ticket: WarmTicket | undefined): void {
    const c = this.collecting.get(threadId);
    this.collecting.delete(threadId);
    if (!ticket || !c?.best || c.lastRequestAt === undefined) return;
    const best = c.best;
    const input = inputTotal(best.usage);
    if (input < KEEP_ALIVE_MIN_INPUT_TOKENS) return;
    if (best.sessionId !== ticket.sessionId) return;
    const body = warmBody(best.body);
    if (!body) {
      this.log(`[claude-login] 温め直しません（本文が JSON として読めません）project=${best.projectId} thread=${threadId}`);
      return;
    }
    if (body.length > KEEP_ALIVE_BODY_LIMIT) return;
    const entry: Entry = {
      req: { projectId: best.projectId, threadId, key: best.key, accountId: best.accountId, path: best.path, headers: warmHeaders(best.headers), body },
      sessionId: best.sessionId,
      inputTokens: input,
      baseAt: c.lastRequestAt,
      fingerprint: ticket.fingerprint,
      sent: 0,
      dueAt: 0,
      inFlight: false,
    };
    entry.dueAt = this.dueAt(entry);
    this.entries.set(threadId, entry);
    const state = this.states.get(threadId);
    if (state) state.warming = true;
    this.enforceLimits();
    this.arm();
  }

  /** **止める**（閉じた・Clear・やり直し・眠らせた・モデル等を変えた）。再開はしない——次のターンの終わりからまた数える */
  stop(threadId: string): void {
    this.drop(threadId);
  }

  /** その Project の会話を全部止める（眠らせた） */
  stopProject(projectId: string): void {
    for (const [threadId, e] of this.entries) if (e.req.projectId === projectId) this.drop(threadId);
  }

  /** その会話のキャッシュの様子（無ければ undefined） */
  cacheOf(threadId: string): CacheState | undefined {
    const s = this.states.get(threadId);
    return s ? { ...s } : undefined;
  }

  /** 温めている会話の数（観測と試験） */
  warmingCount(): number {
    return this.entries.size;
  }

  /** 止めるとき */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** **時刻の来たものを送る**（時計から。試験は直に呼ぶ） */
  async runDue(): Promise<void> {
    const now = this.now();
    const due = [...this.entries.entries()].filter(([, e]) => !e.inFlight && e.dueAt <= now).sort((a, b) => a[1].dueAt - b[1].dueAt);
    for (const [threadId, entry] of due) {
      if (this.entries.get(threadId) !== entry) continue;
      await this.warm(threadId, entry);
    }
    this.arm();
  }

  private async warm(threadId: string, entry: Entry): Promise<void> {
    const { req } = entry;
    if (this.deps.stillWarmable && !this.deps.stillWarmable(threadId, entry.fingerprint)) {
      this.drop(threadId);
      return;
    }
    const margin = this.deps.margin(req.accountId);
    if (!margin.ok) {
      this.abandon(threadId, `余白がありません（${margin.reason}）`);
      return;
    }
    if (this.spentInWindow() + entry.inputTokens > KEEP_ALIVE_WINDOW_TOKENS) {
      this.abandon(threadId, "5時間の窓の上限に達しました");
      return;
    }
    entry.inFlight = true;
    let outcome: WarmOutcome;
    try {
      outcome = await this.deps.send(req);
    } catch (err) {
      outcome = { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      entry.inFlight = false;
    }
    const at = this.now();
    // 送っている間に止められた（ターンが始まった等）——結果はキャッシュの様子にだけ映し、予定は作らない
    const still = this.entries.get(threadId) === entry;
    if (outcome.kind === "failed") {
      this.log(`[claude-login] 温め直しに失敗しました project=${req.projectId} thread=${threadId} account=${req.accountId}: ${outcome.reason}`);
      if (still) this.abandon(threadId, `失敗しました（${outcome.reason}）`);
      return;
    }
    const usage = outcome.usage;
    this.spent.push({ at, tokens: inputTotal(usage) });
    const hit = cacheHit(usage);
    this.log(
      `[claude-login] 温め直し project=${req.projectId} thread=${threadId} account=${req.accountId} cache_read=${usage.cacheReadTokens} cache_creation=${usage.cacheCreationTokens} 使用率=${outcome.utilization}`,
    );
    const state = this.states.get(threadId);
    if (state && state.sessionId === entry.sessionId) {
      state.lastAt = at;
      state.lastHit = hit;
      if (hit) state.lastHitAt = at;
      state.warms = entry.sent + 1;
    }
    if (!still) return;
    if (!hit) {
      this.abandon(threadId, "外れました（キャッシュが冷えていました）");
      return;
    }
    entry.sent++;
    if (entry.sent >= KEEP_ALIVE_MINUTES.length) {
      this.entries.delete(threadId);
      if (state) state.warming = false;
      return;
    }
    entry.dueAt = this.dueAt(entry);
  }

  /** 次の温め直しの時刻（最後の本物の要求から、0〜5分散らす） */
  private dueAt(entry: Entry): number {
    const minutes = KEEP_ALIVE_MINUTES[entry.sent]!;
    return entry.baseAt + (minutes + this.random() * JITTER_MINUTES) * this.minuteMs;
  }

  private spentInWindow(): number {
    const from = this.now() - WINDOW_MS;
    this.spent = this.spent.filter((s) => s.at > from);
    return this.spent.reduce((sum, s) => sum + s.tokens, 0);
  }

  /**
   * **上限**：同時に 20 本・覚えた本文の合計 256MB・5時間の窓で 2,000万トークン（これから送る分の見込みを含める）。超えたら
   * 最後の要求が古い会話からやめる
   */
  private enforceLimits(): void {
    const over = () => {
      if (this.entries.size > KEEP_ALIVE_MAX_ENTRIES) return true;
      let bytes = 0;
      let planned = 0;
      for (const e of this.entries.values()) {
        bytes += e.req.body.length;
        planned += (KEEP_ALIVE_MINUTES.length - e.sent) * e.inputTokens;
      }
      return bytes > KEEP_ALIVE_TOTAL_LIMIT || this.spentInWindow() + planned > KEEP_ALIVE_WINDOW_TOKENS;
    };
    while (this.entries.size > 0 && over()) {
      let oldest: [string, Entry] | undefined;
      for (const pair of this.entries) if (!oldest || pair[1].baseAt < oldest[1].baseAt) oldest = pair;
      this.abandon(oldest![0], "上限から押し出されました");
    }
  }

  /** 途中で止める（再開しない・要約もしない——#473 は `abandoned` を読む） */
  private abandon(threadId: string, reason: string): void {
    const entry = this.entries.get(threadId);
    this.entries.delete(threadId);
    const state = this.states.get(threadId);
    if (state) {
      state.warming = false;
      state.abandoned = reason;
    }
    if (entry) this.log(`[claude-login] 温め直しをやめました project=${entry.req.projectId} thread=${threadId}: ${reason}`);
  }

  private drop(threadId: string): void {
    this.entries.delete(threadId);
    this.collecting.delete(threadId);
    const state = this.states.get(threadId);
    if (state) state.warming = false;
  }

  /** 一番早い予定に時計を合わせる */
  private arm(): void {
    if (this.deps.timers === false) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let next: number | undefined;
    for (const e of this.entries.values()) if (!e.inFlight && (next === undefined || e.dueAt < next)) next = e.dueAt;
    if (next === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.runDue().catch((err: unknown) => console.warn("[claude-login] 温め直しの時計が例外を投げました:", err));
      },
      Math.min(Math.max(0, next - this.now()), 2 ** 31 - 1),
    );
    this.timer.unref();
  }
}

/** 覚えた本文を温め直しの本文にする：`max_tokens` を 0 にし `stream` を外す（キャッシュの前方一致に入らない2つ） */
function warmBody(body: Buffer): Buffer | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>), max_tokens: 0 };
  delete out.stream;
  return Buffer.from(JSON.stringify(out));
}

/** stream を外すので、stream を求める見出しも外す（長さは送るときに付け直る） */
function warmHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k === "accept" && v.includes("text/event-stream")) continue;
    if (k === "x-stainless-helper-method" && v === "stream") continue;
    out[k] = v;
  }
  return out;
}
