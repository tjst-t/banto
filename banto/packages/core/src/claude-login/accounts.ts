// **Claude のアカウントの台帳と置き場**（決定・2026-10-18、ユーザー。`docs/specs/v4-security.md` §2「Claude のアカウントを
// 複数持つ」の 3.・7.・8.）。
//
// アカウント1つ＝置き場（`.credentials.json`、中身は CLI と同じ `claudeAiOauth`）1つ。最初の1つは今の `~/.claude`
// （人が host で `claude` を使うこともあるので、置き場は人の CLI のもの）。足したものは banto だけが触る
// `<データ置き場>/claude-accounts/<id>/.credentials.json`（フォルダ 0700・ファイル 0600）。
//
// 台帳 `<データ置き場>/claude-accounts.json` に持つのは秘密ではないものだけ——id・表示名・メールアドレス・契約の種類と
// 上限の段・足した日時・既定の並び・最後に読んだ使用率。**トークンは台帳に書かない**。置き場の道は id と種類から
// 決まるので持たない（規則3）。
//
// 使用率は中継が返事の見出しから読み、メモリに持ってファイルへは間引いて書く。リセットの時刻を過ぎた値は「分からない」
// に戻す（分からないものは使える扱い——使えば見出しで分かる）。

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceCredentialsFile, type OauthFields } from "./refresh.js";
import { DEFAULT_THRESHOLDS, type UsageThresholds } from "./select.js";

/** 最初の1つ（`~/.claude`）の id。外せない（並びから抜くだけ） */
export const HOST_ACCOUNT_ID = "host";
const HOST_ACCOUNT_LABEL = "このマシンの Claude Code のログイン";
const LEDGER_FILE = "claude-accounts.json";
const ACCOUNTS_DIR = "claude-accounts";
/** 使用率をファイルへ書くのは、この間隔に1回まで（返事のたびに書かない） */
const USAGE_WRITE_INTERVAL_MS = 60_000;
/** 使用率の見出しの頭（`-5h-utilization` 等が続く。#397 で本物の返事から確かめた） */
const RATELIMIT_HEADER = "anthropic-ratelimit-unified";

/** 窓1つ（5時間・週）の使用率 */
export interface UsageWindow {
  /** 0〜1 */
  utilization: number;
  /** この窓がリセットされる時刻（ISO） */
  resetsAt?: string;
  status?: string;
}

/** 最後に読んだ使用率。どの欄も「無い」は分からない */
export interface AccountUsage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** `anthropic-ratelimit-unified-status`（allowed・allowed_warning・rejected） */
  status?: string;
  /** `-status` の効く時刻（`anthropic-ratelimit-unified-reset`）。過ぎたら status は分からない */
  statusResetsAt?: string;
  /** `-representative-claim`——rejected のとき、どの窓が尽きたか */
  representativeClaim?: string;
  readAt: string;
}

export interface ClaudeAccount {
  id: string;
  /** `host`＝今の `~/.claude`（人の CLI の置き場）、`banto`＝banto だけが触る置き場 */
  kind: "host" | "banto";
  /** 表示名（既定はメールアドレス） */
  label: string;
  email?: string;
  /** 契約の種類と上限の段——秘密ではない */
  subscriptionType?: string;
  rateLimitTier?: string;
  addedAt: string;
  usage?: AccountUsage;
}

interface Ledger {
  version: 1;
  accounts: ClaudeAccount[];
  /** banto 全体の既定の並び（アカウントの id の優先順） */
  defaultOrder: string[];
  /**
   * **Project の並び**（§2 の 5.）。鍵は Project の id。無ければ「既定のまま」。外したアカウントは抜き、空になったら
   * 消す（既定に戻る）。前からある台帳には無い
   */
  projectOrders?: Record<string, string[]>;
  /** 切り替えの閾値（0〜1、5時間と週で別々、§2 の 6.）。無ければ既定（95%・95%）。前からある台帳には無い */
  thresholds?: UsageThresholds;
}

export interface ClaudeAccountStoreDeps {
  /** host のデータの置き場 */
  dataDir: string;
  /** 最初の1つの置き場（ふだんは `hostClaudeCredentialsPath()`。E2E は偽物を指す） */
  hostCredentialsPath: string;
  now?: () => Date;
}

export class ClaudeAccountStore {
  private ledger: Ledger;
  private readonly now: () => Date;
  private lastUsageWriteAt = 0;
  private usageWriteTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: ClaudeAccountStoreDeps) {
    this.now = deps.now ?? (() => new Date());
    const loaded = loadLedger(this.ledgerPath);
    if (loaded) {
      this.ledger = loaded;
    } else {
      // **移り方**（§2 の 8.）：最初の起動で `~/.claude` を1つ目に載せ、既定の並びをそれだけにする——足すまで今と同じに動く
      this.ledger = {
        version: 1,
        accounts: [{ id: HOST_ACCOUNT_ID, kind: "host", label: HOST_ACCOUNT_LABEL, addedAt: this.now().toISOString() }],
        defaultOrder: [HOST_ACCOUNT_ID],
      };
      this.write();
    }
  }

  private get ledgerPath(): string {
    return join(this.deps.dataDir, LEDGER_FILE);
  }

  list(): ClaudeAccount[] {
    return this.ledger.accounts.map((a) => this.view(a));
  }

  get(id: string): ClaudeAccount | undefined {
    const a = this.ledger.accounts.find((x) => x.id === id);
    return a ? this.view(a) : undefined;
  }

  defaultOrder(): string[] {
    return [...this.ledger.defaultOrder];
  }

  /** 既定の並びを決める（台帳にあるアカウントだけ・重ねない。空でもよい——使えるアカウントが無いと中継が理由を返す） */
  setDefaultOrder(ids: string[]): void {
    this.checkOrder(ids, "既定の並び");
    this.ledger.defaultOrder = [...ids];
    this.write();
  }

  /** その Project の並び。決めていなければ undefined（既定のまま） */
  projectOrder(projectId: string): string[] | undefined {
    const o = this.ledger.projectOrders?.[projectId];
    return o ? [...o] : undefined;
  }

  /** その Project で使う並び：決めていればそれ、無ければ既定の並び */
  orderFor(projectId: string): string[] {
    return this.projectOrder(projectId) ?? this.defaultOrder();
  }

  /**
   * **Project の並びを決める**（§2 の 5.）。`undefined` で「既定のまま」に戻す。決めるなら1つ以上（1つなら固定、
   * 2つ以上ならその順に切り替える）
   */
  setProjectOrder(projectId: string, ids: string[] | undefined): void {
    const orders = { ...(this.ledger.projectOrders ?? {}) };
    if (ids === undefined) {
      delete orders[projectId];
    } else {
      if (ids.length === 0) throw new Error("Project の並びには1つ以上のアカウントを入れてください（既定のままにするなら並びを渡さない）");
      this.checkOrder(ids, "Project の並び");
      orders[projectId] = [...ids];
    }
    this.ledger.projectOrders = orders;
    this.write();
  }

  /** 決めてある Project の並びの全部（設定の画面——外すと並びから消える Project を出すため） */
  projectOrders(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.ledger.projectOrders ?? {}).map(([k, v]) => [k, [...v]]));
  }

  /** **表示名を変える**（既定はメールアドレス）。空にはしない */
  setLabel(id: string, label: string): ClaudeAccount {
    const a = this.ledger.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Claude のアカウント ${id} は台帳にありません`);
    const trimmed = label.trim();
    if (!trimmed) throw new Error("名前を空にはできません");
    a.label = trimmed;
    this.write();
    return this.view(a);
  }

  thresholds(): UsageThresholds {
    return { ...(this.ledger.thresholds ?? DEFAULT_THRESHOLDS) };
  }

  /** **閾値を決める**（0 より大きく 1 以下。5時間と週で別々） */
  setThresholds(t: UsageThresholds): void {
    for (const [name, v] of [["5時間", t.fiveHour], ["週", t.sevenDay]] as const) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1) throw new Error(`${name}の閾値は 0 より大きく 1 以下で渡してください`);
    }
    this.ledger.thresholds = { fiveHour: t.fiveHour, sevenDay: t.sevenDay };
    this.write();
  }

  /** 覚えている使用率（リセットの時刻を過ぎたものも含めた生の値。選ぶ側が「分からない」に戻す） */
  usageOf(id: string): AccountUsage | undefined {
    return this.ledger.accounts.find((x) => x.id === id)?.usage;
  }

  private checkOrder(ids: string[], what: string): void {
    if (new Set(ids).size !== ids.length) throw new Error(`${what}に同じアカウントが2回あります`);
    const unknown = ids.find((id) => !this.ledger.accounts.some((a) => a.id === id));
    if (unknown) throw new Error(`Claude のアカウント ${unknown} は台帳にありません`);
  }

  /** そのアカウントの置き場（`.credentials.json`） */
  credentialsPathOf(id: string): string {
    const a = this.ledger.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Claude のアカウント ${id} は台帳にありません`);
    return a.kind === "host" ? this.deps.hostCredentialsPath : join(this.accountDir(id), ".credentials.json");
  }

  /**
   * **アカウントを足す**：banto だけが触る置き場を作り（フォルダ 0700・ファイル 0600）、台帳と既定の並びの末尾に載せる。
   * 中身は CLI と同じ `claudeAiOauth` の形
   */
  add(input: { email: string; label?: string; subscriptionType?: string; rateLimitTier?: string; oauth: Record<string, unknown> }): ClaudeAccount {
    const id = `acc-${randomBytes(6).toString("hex")}`;
    const root = join(this.deps.dataDir, ACCOUNTS_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const dir = this.accountDir(id);
    mkdirSync(dir, { mode: 0o700 });
    // umask で緩まないように明示する
    chmodSync(dir, 0o700);
    const path = join(dir, ".credentials.json");
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ claudeAiOauth: input.oauth }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    const account: ClaudeAccount = {
      id,
      kind: "banto",
      label: input.label ?? input.email,
      email: input.email,
      ...(input.subscriptionType ? { subscriptionType: input.subscriptionType } : {}),
      ...(input.rateLimitTier ? { rateLimitTier: input.rateLimitTier } : {}),
      addedAt: this.now().toISOString(),
    };
    this.ledger.accounts.push(account);
    this.ledger.defaultOrder.push(id);
    this.write();
    return this.view(account);
  }

  /**
   * **同じメールアドレスの足したアカウント**（ログインし直しの見分け、§2 の 4. の 3.）。`~/.claude` のものは台帳に
   * メールアドレスを持たず、置き場も人の CLI のものなので、ここでは引かない
   */
  findByEmail(email: string): ClaudeAccount | undefined {
    const key = email.trim().toLowerCase();
    const a = this.ledger.accounts.find((x) => x.kind === "banto" && x.email?.trim().toLowerCase() === key);
    return a ? this.view(a) : undefined;
  }

  /**
   * **ログインし直した**：置き場を新しいトークンで置き換え（取り直し役と同じ書き込み用の鍵の中で）、契約の種類を
   * 読み直したものにする。表示名と並びはそのまま
   */
  async replaceLogin(
    id: string,
    input: { email: string; subscriptionType?: string; rateLimitTier?: string; oauth: OauthFields },
  ): Promise<ClaudeAccount> {
    const a = this.ledger.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Claude のアカウント ${id} は台帳にありません`);
    if (a.kind !== "banto") throw new Error("このマシンの Claude Code のログインは、banto からは置き換えません");
    await replaceCredentialsFile(this.credentialsPathOf(id), input.oauth);
    a.email = input.email;
    if (input.subscriptionType) a.subscriptionType = input.subscriptionType;
    else delete a.subscriptionType;
    if (input.rateLimitTier) a.rateLimitTier = input.rateLimitTier;
    else delete a.rateLimitTier;
    this.write();
    return this.view(a);
  }

  /** **外す**：置き場を消し、台帳と並びから抜く。`~/.claude` のものは外せない（置き場は人の CLI のもの） */
  remove(id: string): void {
    const a = this.ledger.accounts.find((x) => x.id === id);
    if (!a) throw new Error(`Claude のアカウント ${id} は台帳にありません`);
    if (a.kind === "host") throw new Error("このマシンの Claude Code のログインは外せません（並びから抜くことはできます）");
    this.ledger.accounts = this.ledger.accounts.filter((x) => x.id !== id);
    this.ledger.defaultOrder = this.ledger.defaultOrder.filter((x) => x !== id);
    // Project の並びからも抜き、空になったら既定に戻す（§2 の 5.）
    if (this.ledger.projectOrders) {
      const orders: Record<string, string[]> = {};
      for (const [projectId, order] of Object.entries(this.ledger.projectOrders)) {
        const kept = order.filter((x) => x !== id);
        if (kept.length > 0) orders[projectId] = kept;
      }
      this.ledger.projectOrders = orders;
    }
    this.write();
    rmSync(this.accountDir(id), { recursive: true, force: true });
  }

  /**
   * **返事の見出しから使用率を覚える**。見出しが無い返事（上流の手前で断った等）では何も変えない。書くのは間引く
   */
  recordUsage(id: string, headers: Headers): void {
    const a = this.ledger.accounts.find((x) => x.id === id);
    if (!a) return;
    const read = usageFromHeaders(headers, this.now());
    if (!read) return;
    // 見出しに無かった窓は前に読んだものを残す（リセットを過ぎれば読むときに消える）
    const fiveHour = read.fiveHour ?? a.usage?.fiveHour;
    const sevenDay = read.sevenDay ?? a.usage?.sevenDay;
    a.usage = {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(read.status ? { status: read.status } : {}),
      ...(read.statusResetsAt ? { statusResetsAt: read.statusResetsAt } : {}),
      ...(read.representativeClaim ? { representativeClaim: read.representativeClaim } : {}),
      readAt: read.readAt,
    };
    this.scheduleUsageWrite();
  }

  /**
   * **`/api/oauth/usage` で読み直した使用率を覚える**（§2 の 7.——使っていないアカウントも、設定を開いたときに読み直す）。
   * 窓の率と時刻だけを置き換え、見出しでしか分からない status（上限で断っているか）は前に読んだものを残す
   */
  recordUsageRead(id: string, read: { fiveHour?: UsageWindow; sevenDay?: UsageWindow }): void {
    const a = this.ledger.accounts.find((x) => x.id === id);
    if (!a) return;
    const prev = a.usage;
    a.usage = {
      ...(read.fiveHour ? { fiveHour: read.fiveHour } : {}),
      ...(read.sevenDay ? { sevenDay: read.sevenDay } : {}),
      ...(prev?.status ? { status: prev.status } : {}),
      ...(prev?.statusResetsAt ? { statusResetsAt: prev.statusResetsAt } : {}),
      ...(prev?.representativeClaim ? { representativeClaim: prev.representativeClaim } : {}),
      readAt: this.now().toISOString(),
    };
    this.scheduleUsageWrite();
  }

  /** 間引いて溜めた使用率を、いま書く（止めるとき・試験） */
  flush(): void {
    if (this.usageWriteTimer) {
      clearTimeout(this.usageWriteTimer);
      this.usageWriteTimer = undefined;
    }
    this.write();
    this.lastUsageWriteAt = this.now().getTime();
  }

  private scheduleUsageWrite(): void {
    if (this.usageWriteTimer) return;
    const wait = this.lastUsageWriteAt + USAGE_WRITE_INTERVAL_MS - this.now().getTime();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.usageWriteTimer = setTimeout(() => {
      this.usageWriteTimer = undefined;
      try {
        this.flush();
      } catch (err) {
        console.warn("[claude-login] 使用率を台帳に書けませんでした:", err);
      }
    }, wait);
    this.usageWriteTimer.unref();
  }

  private accountDir(id: string): string {
    return join(this.deps.dataDir, ACCOUNTS_DIR, id);
  }

  /** 外に出す形：リセットの時刻を過ぎた使用率は「分からない」に戻す */
  private view(a: ClaudeAccount): ClaudeAccount {
    const { usage, ...rest } = a;
    const fresh = usage ? freshUsage(usage, this.now()) : undefined;
    return { ...rest, ...(fresh ? { usage: fresh } : {}) };
  }

  private write(): void {
    // 書きかけを読ませない（別名に書いて置き換える）
    const tmp = `${this.ledgerPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.ledger, null, 2), { mode: 0o600 });
    renameSync(tmp, this.ledgerPath);
  }
}

/** リセットの時刻を過ぎた窓・status を落とす。何も残らなければ undefined */
export function freshUsage(usage: AccountUsage, now: Date): AccountUsage | undefined {
  const live = (resetsAt: string | undefined) => resetsAt === undefined || Date.parse(resetsAt) > now.getTime();
  const out: AccountUsage = { readAt: usage.readAt };
  if (usage.fiveHour && live(usage.fiveHour.resetsAt)) out.fiveHour = usage.fiveHour;
  if (usage.sevenDay && live(usage.sevenDay.resetsAt)) out.sevenDay = usage.sevenDay;
  if (usage.status && live(usage.statusResetsAt)) {
    out.status = usage.status;
    if (usage.statusResetsAt) out.statusResetsAt = usage.statusResetsAt;
    if (usage.representativeClaim) out.representativeClaim = usage.representativeClaim;
  }
  return out.fiveHour || out.sevenDay || out.status ? out : undefined;
}

/** `anthropic-ratelimit-unified-*` の見出しを読む。1つも無ければ undefined */
export function usageFromHeaders(headers: Headers, now: Date): AccountUsage | undefined {
  const h = (suffix: string) => headers.get(`${RATELIMIT_HEADER}${suffix}`) ?? undefined;
  const resetIso = (v: string | undefined) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? new Date(n * 1000).toISOString() : undefined;
  };
  const windowOf = (key: "5h" | "7d"): UsageWindow | undefined => {
    const u = Number(h(`-${key}-utilization`));
    if (h(`-${key}-utilization`) === undefined || !Number.isFinite(u)) return undefined;
    const resetsAt = resetIso(h(`-${key}-reset`));
    const status = h(`-${key}-status`);
    return { utilization: u, ...(resetsAt ? { resetsAt } : {}), ...(status ? { status } : {}) };
  };
  const fiveHour = windowOf("5h");
  const sevenDay = windowOf("7d");
  const status = h("-status");
  if (!fiveHour && !sevenDay && !status) return undefined;
  const statusResetsAt = resetIso(h("-reset"));
  const representativeClaim = h("-representative-claim");
  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(status ? { status } : {}),
    ...(statusResetsAt ? { statusResetsAt } : {}),
    ...(representativeClaim ? { representativeClaim } : {}),
    readAt: now.toISOString(),
  };
}

function loadLedger(path: string): Ledger | undefined {
  if (!existsSync(path)) return undefined;
  // 壊れていたら止まる（規則2）——黙って作り直すと、足したアカウントと並びが消える
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Claude のアカウントの台帳が JSON ではありません：${path}`);
  }
  const l = parsed as Partial<Ledger> | null;
  const ok =
    typeof l === "object" &&
    l !== null &&
    l.version === 1 &&
    Array.isArray(l.accounts) &&
    l.accounts.every((a) => typeof a?.id === "string" && (a.kind === "host" || a.kind === "banto") && typeof a.label === "string") &&
    Array.isArray(l.defaultOrder) &&
    l.defaultOrder.every((id) => typeof id === "string" && l.accounts!.some((a) => a.id === id)) &&
    (l.projectOrders === undefined ||
      (typeof l.projectOrders === "object" &&
        l.projectOrders !== null &&
        Object.values(l.projectOrders).every((o) => Array.isArray(o) && o.every((id) => typeof id === "string" && l.accounts!.some((a) => a.id === id))))) &&
    (l.thresholds === undefined || (typeof l.thresholds?.fiveHour === "number" && typeof l.thresholds?.sevenDay === "number"));
  if (!ok) throw new Error(`Claude のアカウントの台帳が壊れています：${path}`);
  return l as Ledger;
}

/**
 * **`/api/oauth/usage` の返事を読む**（#397 の実測：`five_hour`・`seven_day` ごとに `utilization`（**0〜100**——見出しは 0〜1）と
 * `resets_at`（ISO、使っていない窓は null））。形が違えば投げる（黙って「分からない」にしない）
 */
export function usageFromUsageApi(body: unknown): { fiveHour?: UsageWindow; sevenDay?: UsageWindow } {
  if (typeof body !== "object" || body === null) throw new Error("使用率の返事が JSON のオブジェクトではありません");
  const windowOf = (key: "five_hour" | "seven_day"): UsageWindow | undefined => {
    const w = (body as Record<string, unknown>)[key];
    if (w === null || w === undefined) return undefined;
    const { utilization, resets_at } = w as { utilization?: unknown; resets_at?: unknown };
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) throw new Error(`使用率の返事の ${key}.utilization が数ではありません`);
    // 使っていない窓（resets_at が null）は分からない扱い——率 0 を「リセットの無い値」として残すと消えない
    if (resets_at === null || resets_at === undefined) return undefined;
    if (typeof resets_at !== "string" || !Number.isFinite(Date.parse(resets_at))) throw new Error(`使用率の返事の ${key}.resets_at が時刻ではありません`);
    return { utilization: utilization / 100, resetsAt: new Date(resets_at).toISOString() };
  };
  const fiveHour = windowOf("five_hour");
  const sevenDay = windowOf("seven_day");
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}
