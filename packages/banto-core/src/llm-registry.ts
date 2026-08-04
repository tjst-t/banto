/**
 * LLM Catalog — LLM プロバイダ・モデル・キーの一元管理（ADR-0004 / spec §3.5）。
 *
 * banto の一級機能。番頭・職人・Kobo はすべてここを通じてモデルを得る。
 *
 * 出どころは2つに分かれる。
 *   - どのモデル・どの鍵が存在するか … pi の models.json / auth.json
 *   - tier・既定・使用可・キーの並び順 … banto のオーバーレイ
 *
 * 番頭は具体モデルを持ち、職人は tier で指定する。tier は難度の軸、制約
 * （vision / local / free）は候補を絞る条件で、互いに直交する。番頭が出すのは
 * モデル名ではなく (tier, 制約) なので、モデルが入れ替わっても判断はそのまま使える。
 *
 * D3: 状態の真実は一箇所。並び順と役割の許可は設定、キーの上限は実行時状態。
 * D5: 判断は無い。tier → モデルの解決は表で引くだけ。
 * I2: 制約は決して緩めない。満たせないなら解決せずに返す。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ModelTier = "reasoning" | "standard" | "fast";

export const MODEL_TIERS: readonly ModelTier[] = ["reasoning", "standard", "fast"] as const;

export const TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  reasoning: "高精度",
  standard: "通常",
  fast: "高速",
};

/** 番頭がタスクをどの tier に入れるか決めるときに読む基準。設定で書き換えられる。 */
export const DEFAULT_TIER_DESCRIPTIONS: Readonly<Record<ModelTier, string>> = {
  reasoning: "設計判断・仕様の壁・外に出す文面。読み違えると後戻りが大きいもの。コスト高。",
  standard: "調査から実装まで一貫して任せる通常作業。迷ったらここ。",
  fast: "要約・分類・カード選別など、間違えても安く作り直せるもの。長文は不得意。",
};

/**
 * 候補を絞る条件。tier と直交し、**決して緩めない**。
 * local を要求したのに外へ出るモデルを返す、といったことが起きてはならない。
 */
export interface ModelConstraints {
  /** 画像を読む必要がある */
  vision?: boolean;
  /** 外に出さない（ローカル実行のみ） */
  local?: boolean;
  /** 有料キーを使わない */
  free?: boolean;
}

export const CONSTRAINT_KEYS: readonly (keyof ModelConstraints)[] = [
  "vision",
  "local",
  "free",
] as const;

export type KeyScope = "host" | "worker";

/** キーの実行時状態。設定ではないのでオーバーレイには保存しない。 */
export type KeyState = "ok" | "limited" | "untested";

export interface LlmKeyInfo {
  /** auth.json 上のプロバイダ名 = キー名 */
  name: string;
  /** 番頭がこのキーを使ってよい */
  host: boolean;
  /** 職人がこのキーを使ってよい */
  worker: boolean;
  state: KeyState;
  /** state === "limited" のとき、いつまで待つか（ISO 8601） */
  limitedUntil?: string;
}

export interface LlmProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  hasAuth: boolean;
  modelCount: number;
  /** 外に出ない（ローカル実行）。URL からは判別できないので設定で持つ */
  local: boolean;
  /** 上から順に消費する。並び順そのものが優先順位 */
  keys: LlmKeyInfo[];
}

export interface LlmModelInfo {
  providerId: string;
  id: string;
  name: string;
  tier: ModelTier;
  vision: boolean;
  /** 有料キーを使わない */
  free: boolean;
  /** 番頭が使ってよい */
  hostUsable: boolean;
  /** 職人が使ってよい */
  workerUsable: boolean;
}

export interface LlmTierInfo {
  tier: ModelTier;
  label: string;
  description: string;
  /** この tier の第一候補。制約で落ちたら同じ tier の次の候補に降りる */
  pick?: { provider: string; model: string };
}

export interface LlmDefaults {
  /** 番頭は連続した会話なので具体モデルで持つ */
  host?: { provider: string; model: string };
  /** 職人はタスクごとに起動するので tier で指定する */
  workerTier: ModelTier;
}

/** pi の設定ファイルが banto の外で変わったかどうか。 */
export interface LlmFileState {
  changed: boolean;
  loadedAt: string;
  loadedHash: string;
  currentHash: string;
}

export interface LlmCatalogData {
  providers: LlmProviderInfo[];
  models: LlmModelInfo[];
  tiers: LlmTierInfo[];
  defaults: LlmDefaults;
  files: LlmFileState;
}

/**
 * pi のモデル解決を委譲する口。banto-core は pi に依存しないため、
 * 利用側（bin.ts）が pi の ModelRegistry / getModel / getModels を渡す。
 */
export interface LlmModelResolver {
  find(provider: string, modelId: string): ResolvedModel | undefined;
  getKnownModels(provider: string): Array<{ id: string; name?: string; input?: string[] }> | undefined;
}

export interface ResolvedModel {
  provider: string;
  id: string;
  name: string;
  input: string[];
}

/** 解決の結果。なぜそれが選ばれたかを呼び出し側が説明できるだけの情報を返す。 */
export interface LlmResolution {
  model: ResolvedModel;
  tier: ModelTier;
  requestedTier: ModelTier;
  /** 要求した tier に候補が無く、別の tier に落ちた */
  usedFallbackTier: boolean;
  /** 第一候補が制約で落ち、同じ tier の次の候補に降りた */
  droppedPick: boolean;
  key?: LlmKeyInfo;
}

export interface LlmCatalogOptions {
  authJsonPath: string;
  modelsJsonPath: string;
  overlayPath: string;
  resolver: LlmModelResolver;
  migration?: {
    hostProvider?: string;
    hostModel?: string;
    workerProvider?: string;
    workerModel?: string;
  };
}

interface AuthJson {
  [key: string]: { type: string; key: string } | undefined;
}

interface ModelsJson {
  providers: Record<
    string,
    {
      name?: string;
      baseUrl?: string;
      models?: Array<{ id: string; name?: string; input?: string[] }>;
    }
  >;
}

interface ModelOverlay {
  free?: boolean;
  hostUsable?: boolean;
  workerUsable?: boolean;
}

interface ProviderOverlay {
  local?: boolean;
  /** auth.json のキー名を消費したい順に並べたもの。無い名前は無視、載っていない名前は末尾 */
  keyOrder?: string[];
  keyScopes?: Record<string, { host?: boolean; worker?: boolean }>;
}

interface Overlay {
  tiers?: Record<string, Record<string, ModelTier>>;
  tierDescriptions?: Partial<Record<ModelTier, string>>;
  picks?: Partial<Record<ModelTier, { provider: string; model: string }>>;
  defaults?: {
    host?: { provider: string; model: string };
    workerTier?: ModelTier;
    /** 旧形式。読み込み時に workerTier + picks へ移す */
    worker?: { provider: string; model: string };
  };
  models?: Record<string, Record<string, ModelOverlay>>;
  providers?: Record<string, ProviderOverlay>;
}

function isModelTier(value: unknown): value is ModelTier {
  return value === "reasoning" || value === "standard" || value === "fast";
}

export class LlmCatalog {
  private readonly authJsonPath: string;
  private readonly modelsJsonPath: string;
  private readonly overlayPath: string;
  private readonly resolver: LlmModelResolver;
  private migration: LlmCatalogOptions["migration"];
  private overlay: Overlay | null = null;

  /** キーの上限は実行時状態。プロセスが落ちれば消えてよい（D3） */
  private readonly keyRuntime = new Map<string, { state: KeyState; limitedUntil?: string }>();

  /** 読み込んだ時点の pi 設定ファイルのハッシュ。外部変更の検知に使う */
  private loadedHash = "";
  private loadedAt = "";

  constructor(options: LlmCatalogOptions) {
    this.authJsonPath = options.authJsonPath;
    this.modelsJsonPath = options.modelsJsonPath;
    this.overlayPath = options.overlayPath;
    this.resolver = options.resolver;
    this.migration = options.migration;
  }

  // ── 読み出し ──────────────────────────────────────────────────────────

  providers(): LlmProviderInfo[] {
    this.ensureLoaded();
    const auth = this.readAuth();
    const models = this.readModelsJson();
    const result: LlmProviderInfo[] = [];
    const seen = new Set<string>();

    for (const [rawName, value] of Object.entries(models.providers)) {
      const id = rawName.replace(/_/g, "-");
      seen.add(id);
      result.push({
        id,
        name: value.name ?? rawName,
        baseUrl: value.baseUrl ?? "",
        hasAuth: auth.has(id),
        modelCount: Array.isArray(value.models) ? value.models.length : 0,
        local: this.overlay!.providers?.[id]?.local ?? false,
        keys: this.keysOf(id, auth.names),
      });
    }

    for (const name of auth.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      result.push({
        id: name,
        name,
        baseUrl: "",
        hasAuth: true,
        modelCount: 0,
        local: this.overlay!.providers?.[name]?.local ?? false,
        keys: this.keysOf(name, auth.names),
      });
    }

    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  models(): LlmModelInfo[] {
    this.ensureLoaded();
    const modelsJson = this.readModelsJson();
    const auth = this.readAuth();
    const result: LlmModelInfo[] = [];

    for (const [rawProvider, value] of Object.entries(modelsJson.providers)) {
      const providerId = rawProvider.replace(/_/g, "-");
      if (!Array.isArray(value.models)) continue;
      const hasAuth = auth.has(providerId);
      for (const m of value.models) {
        const ov = this.overlay!.models?.[providerId]?.[m.id];
        result.push({
          providerId,
          id: m.id,
          name: m.name ?? m.id,
          tier: this.getTier(providerId, m.id),
          vision: Array.isArray(m.input) && m.input.includes("image"),
          // 鍵が要らないなら有料キーは消費しない
          free: ov?.free ?? !hasAuth,
          hostUsable: ov?.hostUsable ?? true,
          workerUsable: ov?.workerUsable ?? true,
        });
      }
    }

    return result.sort((a, b) => {
      const pc = a.providerId.localeCompare(b.providerId);
      return pc !== 0 ? pc : a.id.localeCompare(b.id);
    });
  }

  tiers(): LlmTierInfo[] {
    this.ensureLoaded();
    return MODEL_TIERS.map((tier) => {
      const pick = this.overlay!.picks?.[tier];
      return {
        tier,
        label: TIER_LABELS[tier],
        description: this.overlay!.tierDescriptions?.[tier] ?? DEFAULT_TIER_DESCRIPTIONS[tier],
        ...(pick ? { pick: { ...pick } } : {}),
      };
    });
  }

  defaults(): LlmDefaults {
    this.ensureLoaded();
    const host = this.overlay!.defaults?.host;
    return {
      ...(host ? { host: { ...host } } : {}),
      workerTier: this.overlay!.defaults?.workerTier ?? "standard",
    };
  }

  catalog(): LlmCatalogData {
    return {
      providers: this.providers(),
      models: this.models(),
      tiers: this.tiers(),
      defaults: this.defaults(),
      files: this.fileState(),
    };
  }

  getTier(providerId: string, modelId: string): ModelTier {
    this.ensureLoaded();
    return this.overlay!.tiers?.[providerId]?.[modelId] ?? "standard";
  }

  // ── 書き込み（banto のオーバーレイのみ。pi の設定ファイルは書き換えない） ──

  setTier(providerId: string, modelId: string, tier: ModelTier): void {
    this.ensureLoaded();
    const before = this.getTier(providerId, modelId);
    if (before === tier) return;
    // 第一候補のまま tier を移すと、元の tier の第一候補が居なくなる
    const pick = this.overlay!.picks?.[before];
    if (pick && pick.provider === providerId && pick.model === modelId) {
      throw new Error(
        `${providerId}/${modelId} は「${TIER_LABELS[before]}」の第一候補です。` +
          `先に同じ tier の別のモデルを第一候補にしてから tier を変えてください。`
      );
    }
    this.overlay!.tiers ??= {};
    this.overlay!.tiers[providerId] ??= {};
    this.overlay!.tiers[providerId]![modelId] = tier;
    this.saveOverlay();
  }

  setTierDescription(tier: ModelTier, description: string): void {
    this.ensureLoaded();
    this.overlay!.tierDescriptions ??= {};
    this.overlay!.tierDescriptions[tier] = description;
    this.saveOverlay();
  }

  /** 番頭の既定モデル。使えないモデルは既定にできないので、同時に使用可にする */
  setHostDefault(provider: string, model: string): void {
    this.ensureLoaded();
    this.setModelOverlay(provider, model, { hostUsable: true });
    this.overlay!.defaults ??= {};
    this.overlay!.defaults.host = { provider, model };
    this.saveOverlay();
  }

  setWorkerTier(tier: ModelTier): void {
    this.ensureLoaded();
    this.overlay!.defaults ??= {};
    this.overlay!.defaults.workerTier = tier;
    this.saveOverlay();
  }

  /** その tier の第一候補にする。職人が使えないモデルは候補にならないので同時に使用可にする */
  setPick(provider: string, model: string): void {
    this.ensureLoaded();
    const tier = this.getTier(provider, model);
    this.setModelOverlay(provider, model, { workerUsable: true });
    this.overlay!.picks ??= {};
    this.overlay!.picks[tier] = { provider, model };
    this.saveOverlay();
  }

  /**
   * モデルを役割ごとに使用可/不可にする。
   * 番頭の既定・tier の第一候補になっているものは外せない（外すと解決先を失う）。
   */
  setUsable(provider: string, model: string, scope: KeyScope, usable: boolean): void {
    this.ensureLoaded();
    if (!usable) {
      const host = this.overlay!.defaults?.host;
      if (scope === "host" && host?.provider === provider && host?.model === model) {
        throw new Error(`${provider}/${model} は番頭の既定モデルです。先に別のモデルを既定にしてください。`);
      }
      if (scope === "worker") {
        const tier = this.getTier(provider, model);
        const pick = this.overlay!.picks?.[tier];
        if (pick?.provider === provider && pick?.model === model) {
          throw new Error(
            `${provider}/${model} は「${TIER_LABELS[tier]}」の第一候補です。先に別のモデルを第一候補にしてください。`
          );
        }
      }
    }
    this.setModelOverlay(provider, model, scope === "host" ? { hostUsable: usable } : { workerUsable: usable });
    this.saveOverlay();
  }

  setProviderLocal(providerId: string, local: boolean): void {
    this.ensureLoaded();
    this.overlay!.providers ??= {};
    this.overlay!.providers[providerId] ??= {};
    this.overlay!.providers[providerId]!.local = local;
    this.saveOverlay();
  }

  setModelFree(provider: string, model: string, free: boolean): void {
    this.ensureLoaded();
    this.setModelOverlay(provider, model, { free });
    this.saveOverlay();
  }

  // ── キー（並び順と役割は設定、上限は実行時状態） ─────────────────────

  /** キーを消費したい順に並べ替える。auth.json は書き換えない */
  setKeyOrder(providerId: string, order: string[]): void {
    this.ensureLoaded();
    this.overlay!.providers ??= {};
    this.overlay!.providers[providerId] ??= {};
    this.overlay!.providers[providerId]!.keyOrder = [...order];
    this.saveOverlay();
  }

  /** その役割がこのキーを使ってよいか。最後の1本は外せない（使える鍵が無くなる） */
  setKeyScope(providerId: string, keyName: string, scope: KeyScope, allowed: boolean): void {
    this.ensureLoaded();
    const auth = this.readAuth();
    const keys = this.keysOf(providerId, auth.names);
    if (!keys.some((k) => k.name === keyName)) {
      throw new Error(`${providerId} に ${keyName} というキーがありません。`);
    }
    if (!allowed && !keys.some((k) => k.name !== keyName && k[scope])) {
      const label = scope === "host" ? "番頭" : "職人";
      throw new Error(`${providerId} で${label}が使えるキーが無くなります。先に別のキーを許可してください。`);
    }
    this.overlay!.providers ??= {};
    this.overlay!.providers[providerId] ??= {};
    this.overlay!.providers[providerId]!.keyScopes ??= {};
    const scopes = this.overlay!.providers[providerId]!.keyScopes!;
    scopes[keyName] = { ...scopes[keyName], [scope]: allowed };
    this.saveOverlay();
  }

  /** レート上限に当たったキーを、指定時刻まで候補から外す */
  markKeyLimited(providerId: string, keyName: string, until: Date): void {
    this.keyRuntime.set(`${providerId}/${keyName}`, {
      state: "limited",
      limitedUntil: until.toISOString(),
    });
  }

  markKeyOk(providerId: string, keyName: string): void {
    this.keyRuntime.set(`${providerId}/${keyName}`, { state: "ok" });
  }

  /**
   * そのプロバイダで、いまその役割が使えるキー。
   * 並び順の上から見て、役割が許されていて上限に来ていない最初のもの。
   */
  resolveKey(providerId: string, scope: KeyScope): LlmKeyInfo | undefined {
    this.ensureLoaded();
    const auth = this.readAuth();
    return this.keysOf(providerId, auth.names).find((k) => k[scope] && k.state !== "limited");
  }

  private keysOf(providerId: string, authNames: string[]): LlmKeyInfo[] {
    // auth.json は「プロバイダ名 → 鍵」の形なので、いまは 1 プロバイダ 1 鍵。
    // 複数鍵を持てるようにするのは auth.json 側のデータモデル変更（D1・ADR待ち）。
    const names = authNames.filter((n) => n === providerId);
    const ov = this.overlay!.providers?.[providerId];
    const order = ov?.keyOrder ?? [];
    const sorted = [...names].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    const now = Date.now();
    return sorted.map((name) => {
      const scopes = ov?.keyScopes?.[name];
      const runtime = this.keyRuntime.get(`${providerId}/${name}`);
      let state: KeyState = runtime?.state ?? "untested";
      let limitedUntil = runtime?.limitedUntil;
      // 待ち時間が過ぎたら自動で候補に戻す
      if (state === "limited" && limitedUntil && Date.parse(limitedUntil) <= now) {
        state = "ok";
        limitedUntil = undefined;
      }
      return {
        name,
        host: scopes?.host ?? true,
        worker: scopes?.worker ?? true,
        state,
        ...(limitedUntil ? { limitedUntil } : {}),
      };
    });
  }

  // ── 解決 ──────────────────────────────────────────────────────────────

  /**
   * 職人へ振るときの解決。番頭は具体モデルを持つのでここは通らない。
   *
   * 制約は決して緩めない。満たせるモデルが無ければ解決せず undefined を返す。
   * tier だけは、要求した tier に候補が無いとき隣に落ちる（usedFallbackTier で分かる）。
   */
  resolveForWorker(tier?: ModelTier, constraints: ModelConstraints = {}): LlmResolution | undefined {
    this.ensureLoaded();
    const requestedTier = tier ?? this.defaults().workerTier;
    const providers = new Map(this.providers().map((p) => [p.id, p]));
    const models = this.models();

    const candidatesOf = (t: ModelTier): LlmModelInfo[] =>
      models.filter((m) => {
        if (!m.workerUsable || m.tier !== t) return false;
        const p = providers.get(m.providerId);
        if (constraints.vision && !m.vision) return false;
        if (constraints.local && !p?.local) return false;
        if (constraints.free && !m.free) return false;
        return true;
      });

    // 要求した tier → 隣の tier の順に見る。制約はどの段でも緩めない
    const order: ModelTier[] = [requestedTier, ...MODEL_TIERS.filter((t) => t !== requestedTier)];
    for (const t of order) {
      const cands = candidatesOf(t);
      if (cands.length === 0) continue;
      const pick = this.overlay!.picks?.[t];
      const preferred = pick
        ? cands.find((c) => c.providerId === pick.provider && c.id === pick.model)
        : undefined;
      const chosen = preferred ?? cands[0]!;
      const resolved = this.resolver.find(chosen.providerId, chosen.id);
      if (!resolved) continue;
      const key = this.resolveKey(chosen.providerId, "worker");
      return {
        model: resolved,
        tier: t,
        requestedTier,
        usedFallbackTier: t !== requestedTier,
        droppedPick: Boolean(pick) && preferred === undefined,
        ...(key ? { key } : {}),
      };
    }
    return undefined;
  }

  /** 番頭の既定モデル。設定されていなければ通常 tier から拾う */
  resolveHostDefault(): ResolvedModel | undefined {
    this.ensureLoaded();
    const host = this.defaults().host;
    if (host) {
      const resolved = this.resolver.find(host.provider, host.model);
      if (resolved) return resolved;
    }
    const fallback = this.models().find((m) => m.hostUsable && m.tier === "standard");
    return fallback ? this.resolver.find(fallback.providerId, fallback.id) : undefined;
  }

  resolveExact(provider: string, modelId: string): ResolvedModel | undefined {
    return this.resolver.find(provider, modelId);
  }

  // ── pi 設定ファイルの外部変更 ─────────────────────────────────────────

  /**
   * banto の外で models.json / auth.json が変わっていないか。
   * 読み込み時のハッシュと現在のハッシュを比べるだけなので、監視とは独立に効く。
   */
  fileState(): LlmFileState {
    this.ensureLoaded();
    const current = this.hashPiFiles();
    return {
      changed: current !== this.loadedHash,
      loadedAt: this.loadedAt,
      loadedHash: this.loadedHash,
      currentHash: current,
    };
  }

  /** pi の設定ファイルとオーバーレイを読み直す */
  reload(): void {
    this.overlay = null;
    this.ensureLoaded();
  }

  private hashPiFiles(): string {
    const h = crypto.createHash("sha256");
    for (const p of [this.modelsJsonPath, this.authJsonPath]) {
      h.update(p);
      h.update("\0");
      try {
        h.update(fs.readFileSync(p));
      } catch {
        h.update("<missing>");
      }
      h.update("\0");
    }
    return `sha256:${h.digest("hex").slice(0, 16)}`;
  }

  // ── オーバーレイの読み書き ────────────────────────────────────────────

  private ensureLoaded(): void {
    if (this.overlay !== null) return;
    this.overlay = this.loadOverlay();
    this.loadedHash = this.hashPiFiles();
    this.loadedAt = new Date().toISOString();
    this.migrateWorkerDefault();
    if (this.migration) this.migrateOnce();
  }

  private loadOverlay(): Overlay {
    if (!fs.existsSync(this.overlayPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.overlayPath, "utf-8")) as Overlay;
    } catch {
      return {};
    }
  }

  private saveOverlay(): void {
    fs.mkdirSync(path.dirname(this.overlayPath), { recursive: true });
    fs.writeFileSync(this.overlayPath, JSON.stringify(this.overlay, null, 2) + "\n", "utf-8");
  }

  private setModelOverlay(provider: string, model: string, patch: ModelOverlay): void {
    this.overlay!.models ??= {};
    this.overlay!.models[provider] ??= {};
    this.overlay!.models[provider]![model] = { ...this.overlay!.models[provider]![model], ...patch };
  }

  /**
   * 旧形式（職人の既定が具体モデル）を、新形式（既定 tier ＋ その tier の第一候補）へ移す。
   * 「sonnet を既定にしていた」は「通常 tier が既定で、通常の第一候補が sonnet」と同じ意味。
   */
  private migrateWorkerDefault(): void {
    const legacy = this.overlay!.defaults?.worker;
    if (!legacy) return;
    const tier = this.overlay!.tiers?.[legacy.provider]?.[legacy.model] ?? "standard";
    this.overlay!.defaults!.workerTier ??= tier;
    this.overlay!.picks ??= {};
    this.overlay!.picks[tier] ??= { provider: legacy.provider, model: legacy.model };
    delete this.overlay!.defaults!.worker;
    this.saveOverlay();
  }

  private migrateOnce(): void {
    if (!this.migration) return;
    let changed = false;

    if (this.migration.hostProvider && this.migration.hostModel && !this.overlay!.defaults?.host) {
      this.overlay!.defaults ??= {};
      this.overlay!.defaults.host = {
        provider: this.migration.hostProvider,
        model: this.migration.hostModel,
      };
      changed = true;
    }

    if (this.migration.workerProvider && this.migration.workerModel) {
      const tier = this.overlay!.tiers?.[this.migration.workerProvider]?.[this.migration.workerModel] ?? "standard";
      this.overlay!.defaults ??= {};
      if (this.overlay!.defaults.workerTier === undefined) {
        this.overlay!.defaults.workerTier = tier;
        changed = true;
      }
      this.overlay!.picks ??= {};
      if (this.overlay!.picks[tier] === undefined) {
        this.overlay!.picks[tier] = {
          provider: this.migration.workerProvider,
          model: this.migration.workerModel,
        };
        changed = true;
      }
    }

    if (changed) this.saveOverlay();
    this.migration = undefined;
  }

  private readAuth(): { has(name: string): boolean; names: string[] } {
    if (!fs.existsSync(this.authJsonPath)) {
      return { has: () => false, names: [] };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.authJsonPath, "utf-8")) as AuthJson;
      const names = Object.keys(parsed).map((k) => k.replace(/_/g, "-"));
      return { has: (name: string) => names.includes(name), names };
    } catch {
      return { has: () => false, names: [] };
    }
  }

  private readModelsJson(): ModelsJson {
    if (!fs.existsSync(this.modelsJsonPath)) {
      return { providers: {} };
    }
    try {
      return JSON.parse(fs.readFileSync(this.modelsJsonPath, "utf-8")) as ModelsJson;
    } catch {
      return { providers: {} };
    }
  }
}

export { isModelTier };
