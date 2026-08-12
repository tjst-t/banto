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
import * as os from "node:os";
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

/**
 * キーの実行時状態。設定ではないのでオーバーレイには保存しない（D3）。
 *
 * `untested` は「まだ確かめていない」。**放っておいても変わらない**ので、
 * 画面から確かめられるようにしてある（`llm.check_key`）。
 */
export type KeyState = "ok" | "limited" | "invalid" | "untested";

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
  /** 最後に確かめた時刻（ISO 8601）。確かめていなければ無い。 */
  checkedAt?: string;
  /**
   * どの鍵が入っているかを見分けるための**末尾だけ**（`…f3a2`）。
   * 値そのものは決して返さない——差し替える前に「どれが入っているか」が分かればよい。
   */
  hint?: string;
}

export interface LlmProviderInfo {
  id: string;
  name: string;
  baseUrl: string;
  hasAuth: boolean;
  modelCount: number;
  /**
   * モデル一覧を取り込めるか。
   *
   * 取り込み元は2つある——**到達先（baseUrl）に問い合わせる**か、
   * **ハーネスが組み込みで知っている定義から写す**か。auth.json に鍵だけがある
   * プロバイダ（pi が baseUrl を内蔵しているもの）は前者が使えないが後者は使える。
   */
  canFetchModels: boolean;
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
  /**
   * 文脈に入る最大トークン数。**分かるときだけ入る**——プロバイダの `/models` は
   * 返さないことがあり、推測で埋めない（I1）。ハーネスの組み込み定義からは取れる。
   */
  contextWindow?: number;
  /** 100万トークンあたりの値段（分かるときだけ）。選ぶときの軸になる。 */
  cost?: { input: number; output: number };
  /** 有料キーを使わない */
  free: boolean;
  /** 番頭が使ってよい（＝採用している） */
  hostUsable: boolean;
  /** 職人が使ってよい（＝採用している） */
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
  /**
   * ハーネスが組み込みで知っているモデル。
   * `baseUrl` / `api` も持っている（pi は主要プロバイダの到達先を内蔵している）ので、
   * models.json に何も無いプロバイダの登録元としても使える。
   */
  getKnownModels(
    provider: string
  ):
    | Array<{
        id: string;
        name?: string;
        input?: string[];
        baseUrl?: string;
        api?: string;
        contextWindow?: number;
        maxTokens?: number;
        cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      }>
    | undefined;
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
      /** pi の API 種別（`openai-completions` 等）。 */
      api?: string;
      /** 互換エンドポイント用にファイルへ直接書かれることがある。 */
      apiKey?: string;
      models?: Array<{
        id: string;
        name?: string;
        input?: string[];
        contextWindow?: number;
        maxTokens?: number;
        /** 100万トークンあたりの値段。pi も課金計算に使う形。 */
        cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      }>;
    }
  >;
}

interface ModelOverlay {
  free?: boolean;
  hostUsable?: boolean;
  workerUsable?: boolean;
  /**
   * **手で入れた文脈長**（PO要望 2026-08-11）。
   *
   * プロバイダの `/models` は文脈長を返さないことがある（huihui の
   * `deepseek-v4-flash-abliterated` は 1M あるのに分からない）。分からないと `undefined`
   * のまま扱われ、章立ての閾値も文脈の目盛りも効かず、**実際より短いものとして**進む。
   * 分かっている人が入れられる口を持つ。**手で入れた値が優先**——プロバイダが後から
   * 返してくるようになっても、こちらの意図を上書きしない。
   */
  contextWindow?: number;
}

interface ProviderOverlay {
  local?: boolean;
  /** auth.json のキー名を消費したい順に並べたもの。無い名前は無視、載っていない名前は末尾 */
  keyOrder?: string[];
  keyScopes?: Record<string, { host?: boolean; worker?: boolean }>;
}

interface Overlay {
  /**
   * 「採用していないものは使えない」へ反転したときの移行印（2026-08-04）。
   * これが無いオーバーレイは、そのとき見えていたモデルを全部採用済みにしてから付ける。
   */
  adoptionMigratedAt?: string;
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

/**
 * 手で入れられる文脈長の範囲（PO要望 2026-08-11）。
 *
 * 下限は「章立てが意味を持つ最小」、上限は現実に存在する最大の桁より一段上。
 * **範囲で弾くのは打ち間違いを見つけるため**——1M のつもりで 1000 と入れても、
 * 動きはするが会話が数往復で畳まれるようになり、原因が分からない形で壊れる。
 */
export const MIN_CONTEXT_WINDOW = 1_000;
export const MAX_CONTEXT_WINDOW = 100_000_000;

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
  private readonly keyRuntime = new Map<
    string,
    { state: KeyState; limitedUntil?: string; checkedAt?: string }
  >();

  /** 読み込んだ時点の pi 設定ファイルのハッシュ。外部変更の検知に使う */
  private loadedHash = "";
  private loadedAt = "";
  /** 読み込んだオーバーレイの更新時刻。別プロセスの書き込みを拾うために持つ */
  private overlayMtimeMs = -1;

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
        canFetchModels: (value.baseUrl ?? "").length > 0 || this.knownModels(id).length > 0,
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
        // 鍵だけがあるプロバイダ（pi が到達先を内蔵しているもの）。
        // 到達先は分からないが、組み込みの定義からなら取り込める
        canFetchModels: this.knownModels(name).length > 0,
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
        // 値段が分かっているなら、それで無料かどうかを言う。分からないときだけ
        // 「鍵が要らない＝有料キーを消費しない」という粗い判定に落ちる
        const priced = m.cost && (m.cost.input > 0 || m.cost.output > 0);
        result.push({
          providerId,
          id: m.id,
          name: m.name ?? m.id,
          tier: this.getTier(providerId, m.id),
          vision: Array.isArray(m.input) && m.input.includes("image"),
          // **手で入れた文脈長が優先**（PO要望 2026-08-11）。プロバイダが返さないものを
          // 人が補える形にしてあるので、あとから返ってきても意図を上書きしない
          ...(typeof (ov?.contextWindow ?? m.contextWindow) === "number"
            ? { contextWindow: ov?.contextWindow ?? m.contextWindow }
            : {}),
          ...(m.cost ? { cost: { input: m.cost.input, output: m.cost.output } } : {}),
          free: ov?.free ?? (m.cost ? !priced : !hasAuth),
          /**
           * **採用していないものは使えない**（PO裁定 2026-08-04）。
           *
           * 既定を「全部使ってよい」にしていたのは、モデルが10件程度の前提だったから。
           * OpenRouter のように337件あるプロバイダでは、選択肢が全部並んで選べなくなる。
           * 使うものを明示的に採用する形へ反転した（既存環境は移行で全採用にする）。
           */
          hostUsable: ov?.hostUsable ?? false,
          workerUsable: ov?.workerUsable ?? false,
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
   * **文脈長を手で入れる**（PO要望 2026-08-11）。
   *
   * プロバイダが返さないモデルのための口。`undefined` を渡すと手入力を取り消し、
   * プロバイダが言う値（あれば）に戻る。
   *
   * I2: 0 や負の値、桁が現実離れしたものは受けない——黙って通すと、章立ての閾値が
   *     おかしくなったことに気づけないまま会話が壊れる。
   */
  setContextWindow(provider: string, model: string, contextWindow: number | undefined): void {
    this.ensureLoaded();
    if (contextWindow !== undefined) {
      if (!Number.isFinite(contextWindow) || !Number.isInteger(contextWindow)) {
        throw new Error("文脈長は整数で指定してください（トークン数）。");
      }
      if (contextWindow < MIN_CONTEXT_WINDOW || contextWindow > MAX_CONTEXT_WINDOW) {
        throw new Error(
          `文脈長は ${MIN_CONTEXT_WINDOW}〜${MAX_CONTEXT_WINDOW} トークンで指定してください` +
            `（受け取った値: ${contextWindow}）。`
        );
      }
    }
    this.setModelOverlay(provider, model, { contextWindow });
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
    this.keyRuntime.set(`${providerId}/${keyName}`, {
      state: "ok",
      checkedAt: new Date().toISOString(),
    });
  }

  /** 鍵が受け付けられなかった（401/403）。**黙って候補に残さない**。 */
  markKeyInvalid(providerId: string, keyName: string): void {
    this.keyRuntime.set(`${providerId}/${keyName}`, {
      state: "invalid",
      checkedAt: new Date().toISOString(),
    });
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
      const value = this.rawKeyValue(providerId, name);
      return {
        name,
        host: scopes?.host ?? true,
        worker: scopes?.worker ?? true,
        state,
        ...(runtime?.checkedAt ? { checkedAt: runtime.checkedAt } : {}),
        // 末尾だけ。差し替える前に「どれが入っているか」が分かればよい
        ...(value && value.length >= 4 ? { hint: `…${value.slice(-4)}` } : {}),
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
    // **同じオーバーレイを複数のプロセスが読む**（task-0066）。番頭ホストが画面から
    // 書き、職人の工房（Worker Pool サービス）が読む——一度読んで抱え込むと、
    // 「登録したモデルで職人が動かない、再起動するまで」という分かりにくい壊れ方になる。
    // 書き手は必ず保存してから返す（下の saveOverlay）ので、更新時刻で読み直せば足りる
    if (this.overlay !== null && this.overlayMtimeMs === this.overlayStamp()) return;
    this.overlay = this.loadOverlay();
    this.overlayMtimeMs = this.overlayStamp();
    this.loadedHash = this.hashPiFiles();
    this.loadedAt = new Date().toISOString();
    this.migrateWorkerDefault();
    this.migrateAdoption();
    if (this.migration) this.migrateOnce();
  }

  /** オーバーレイの更新時刻（無ければ -1）。 */
  private overlayStamp(): number {
    try {
      return fs.statSync(this.overlayPath).mtimeMs;
    } catch {
      return -1;
    }
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
    // 自分の書き込みで読み直しが起きないよう、更新時刻を持ち直す
    this.overlayMtimeMs = this.overlayStamp();
  }

  private setModelOverlay(provider: string, model: string, patch: ModelOverlay): void {
    this.overlay!.models ??= {};
    this.overlay!.models[provider] ??= {};
    this.overlay!.models[provider]![model] = { ...this.overlay!.models[provider]![model], ...patch };
  }

  /**
   * 「全部使ってよい」→「採用したものだけ使える」への移行（2026-08-04）。
   *
   * **いま使えているものを黙って使えなくしない**——反転した瞬間に全モデルが選べなくなり、
   * 番頭が起動できなくなる。移行印が無いオーバーレイは、そのとき載っているモデルを
   * 全部採用済みにしてから印を付ける。以後に足されたモデルは採用されない（それが狙い）。
   */
  private migrateAdoption(): void {
    if (this.overlay!.adoptionMigratedAt) return;
    const modelsJson = this.readModelsJson();
    this.overlay!.models ??= {};
    for (const [rawProvider, value] of Object.entries(modelsJson.providers)) {
      const providerId = rawProvider.replace(/_/g, "-");
      if (!Array.isArray(value.models)) continue;
      for (const m of value.models) {
        this.overlay!.models[providerId] ??= {};
        const current = this.overlay!.models[providerId]![m.id];
        this.overlay!.models[providerId]![m.id] = {
          ...current,
          hostUsable: current?.hostUsable ?? true,
          workerUsable: current?.workerUsable ?? true,
        };
      }
    }
    this.overlay!.adoptionMigratedAt = new Date().toISOString();
    this.saveOverlay();
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

  // ── 書き込み（pi の設定ファイル） ────────────────────────────────────────
  //
  // ここまで pi の auth.json / models.json は**読むだけ**だった（書くのは overlay のみ）。
  // 画面からプロバイダとキーを足せるようにするため、この2ファイルも banto が書く。
  // pi 本体は無改造のまま（CLAUDE.md）——触るのは設定ファイルだけで、pi はそれを読む。
  //
  // I2: 壊れた JSON を黙って上書きしない。読めないファイルはエラーにして止める
  // （握りつぶすと、手で書いた設定が消える）。

  /** プロバイダを足す。既にあるものは上書きしない（消えては困る設定が入っている）。 */
  addProvider(params: {
    id: string;
    baseUrl: string;
    /** pi の API 種別。OpenAI 互換が既定。 */
    api?: string;
    /** 省略時は名前＝ID。 */
    name?: string;
  }): void {
    this.ensureLoaded();
    const models = this.readModelsJsonStrict();
    if (this.rawProviderKey(models, params.id)) {
      throw new Error(`${params.id} は既にあります`);
    }
    models.providers[params.id] = {
      name: params.name ?? params.id,
      baseUrl: params.baseUrl,
      api: params.api ?? "openai-completions",
      models: [],
    };
    this.writeModelsJson(models);
  }

  /**
   * プロバイダを消す。**キーと overlay も一緒に消す**——プロバイダが無いのに鍵や
   * 並び順だけ残ると、次に同じ名前を足したとき前の設定が蘇って驚く。
   */
  removeProvider(id: string): void {
    this.ensureLoaded();
    const models = this.readModelsJsonStrict();
    const rawKey = this.rawProviderKey(models, id);
    if (rawKey) {
      delete models.providers[rawKey];
      this.writeModelsJson(models);
    }
    this.removeKey(id);
    if (this.overlay!.providers?.[id]) {
      delete this.overlay!.providers[id];
      this.saveOverlay();
    }
    if (this.overlay!.models?.[id]) {
      delete this.overlay!.models[id];
      this.saveOverlay();
    }
  }

  /** API キーを入れる（同じプロバイダに入れ直すと差し替え）。 */
  setKey(provider: string, key: string): void {
    this.ensureLoaded();
    if (key.trim().length === 0) throw new Error("キーが空です");
    const auth = this.readAuthStrict();
    const rawKey = Object.keys(auth).find((k) => k.replace(/_/g, "-") === provider) ?? provider;
    auth[rawKey] = { type: "api_key", key };
    this.writeAuthJson(auth);
  }

  /** API キーを消す。無ければ何もしない（消えている状態が欲しいだけなので）。 */
  removeKey(provider: string): void {
    this.ensureLoaded();
    const auth = this.readAuthStrict();
    const rawKey = Object.keys(auth).find((k) => k.replace(/_/g, "-") === provider);
    if (!rawKey) return;
    delete auth[rawKey];
    this.writeAuthJson(auth);
  }

  /** auth.json の生の値。**外へ出さない**（末尾のヒントを作るためだけに読む）。 */
  private rawKeyValue(providerId: string, keyName: string): string | undefined {
    try {
      const auth = this.readAuthStrict();
      const rawKey = Object.keys(auth).find((k) => k.replace(/_/g, "-") === keyName);
      return rawKey ? auth[rawKey]?.key : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * プロバイダのキー（実体）。**外へ出さない**——モデル一覧を取りに行くときに
   * Authorization に載せるためだけに使う。`catalog()` はキーの値を返さない。
   */
  apiKeyFor(provider: string): string | undefined {
    this.ensureLoaded();
    const auth = this.readAuthStrict();
    const rawKey = Object.keys(auth).find((k) => k.replace(/_/g, "-") === provider);
    const fromAuth = rawKey ? auth[rawKey]?.key : undefined;
    if (fromAuth) return fromAuth;
    // models.json 側に直接書かれている場合もある（ローカルの互換エンドポイント等）
    const models = this.readModelsJson();
    const modelsKey = this.rawProviderKey(models as ModelsJson, provider);
    return modelsKey ? models.providers[modelsKey]?.apiKey : undefined;
  }

  /**
   * ハーネスが組み込みで知っているモデル定義。
   *
   * pi は主要なプロバイダ（opencode 等）の到達先とモデル一覧を内蔵しているので、
   * models.json に何も書かれていなくても取り込み元になる。**画像可否まで分かる**ので、
   * `/models` に問い合わせるより情報が多い。
   */
  knownModels(
    provider: string
  ): Array<{
    id: string;
    name?: string;
    input?: string[];
    baseUrl?: string;
    api?: string;
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }> {
    return this.resolver.getKnownModels(provider) ?? [];
  }

  /** プロバイダの baseUrl。モデル一覧の取得先を組み立てるのに使う。 */
  baseUrlOf(provider: string): string | undefined {
    this.ensureLoaded();
    const models = this.readModelsJson();
    const rawKey = this.rawProviderKey(models, provider);
    return rawKey ? models.providers[rawKey]?.baseUrl : undefined;
  }

  /**
   * 取得したモデル一覧を models.json へ反映する。
   *
   * **既にある設定は消さない**——input（画像を読めるか）や contextWindow は
   * プロバイダの `/models` からは分からず、手で直した値が入っていることがある。
   * 同じ ID は据え置き（欠けているところだけ埋める）、新しい ID だけを足す。
   *
   * **プロバイダ側から消えたモデルは、こちらからも消す**（PO裁定 2026-08-04）。
   * 残しても選べるだけで、選べば必ず失敗する。消したものは名前を返す（黙って消さない）。
   */
  mergeModels(
    provider: string,
    fetched: Array<{
      id: string;
      name?: string;
      /** 分かっている場合だけ渡す（組み込み定義から写すとき）。省略時は text のみ。 */
      input?: string[];
      contextWindow?: number;
      maxTokens?: number;
      /** 100万トークンあたりの値段（分かるときだけ）。 */
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    }>,
    /** models.json に無いプロバイダを作るときの到達先。鍵だけがあるプロバイダで使う。 */
    ensure?: { baseUrl?: string; api?: string },
    /**
     * 能力（画像可否・文脈長）の出どころが信頼できるか。
     *
     * `true` なら**既にある項目も更新する**——ハーネスの組み込み定義は能力を正しく
     * 知っているので、以前 `text` だけと記録したものを直せる。`/models` から来た
     * 一覧は能力を知らないので `false`（欠けているところだけ埋める）。
     */
    trustCapabilities?: boolean
  ): { added: string[]; kept: string[]; removed: string[] } {
    this.ensureLoaded();
    const models = this.readModelsJsonStrict();
    let rawKey = this.rawProviderKey(models, provider);
    if (!rawKey) {
      // auth.json に鍵だけがあるプロバイダ（pi が到達先を内蔵しているもの）は
      // models.json に居ない。取り込みのタイミングで居場所を作る
      if (!ensure) throw new Error(`${provider} が models.json にありません`);
      rawKey = provider;
      models.providers[rawKey] = {
        name: provider,
        baseUrl: ensure.baseUrl ?? "",
        api: ensure.api ?? "openai-completions",
        models: [],
      };
    }
    const entry = models.providers[rawKey]!;
    const existing = Array.isArray(entry.models) ? entry.models : [];
    const existingIds = new Set(existing.map((m) => m.id));
    const fetchedIds = new Set(fetched.map((m) => m.id));

    const added: string[] = [];
    for (const model of fetched) {
      if (existingIds.has(model.id)) {
        // **欠けているところは埋める**（能力の出どころが信頼できるなら上書きもする）。
        // 手で直した値を消さないのが前提だが、空欄のまま放置もしない
        const at = existing.find((m) => m.id === model.id);
        if (!at) continue;
        if (model.contextWindow && (trustCapabilities || !at.contextWindow)) {
          at.contextWindow = model.contextWindow;
        }
        if (model.maxTokens && (trustCapabilities || !at.maxTokens)) at.maxTokens = model.maxTokens;
        if (model.input && (trustCapabilities || !at.input)) at.input = model.input;
        if (model.cost && (trustCapabilities || !at.cost)) at.cost = model.cost;
        continue;
      }
      added.push(model.id);
      existing.push({
        id: model.id,
        name: model.name ?? model.id,
        // `/models` は画像を読めるかを教えてくれない。分からないときは
        // **text と名乗って様子を見る**——読めないものを読めると偽るより、
        // 読めるものを後から直すほうが安全（I1）。組み込み定義から写すときは分かる
        input: model.input ?? ["text"],
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
        ...(model.cost ? { cost: model.cost } : {}),
      });
    }
    // プロバイダ側から消えたものを落とす。設定（tier・使用可）も一緒に片付ける
    const removed = [...existingIds].filter((id) => !fetchedIds.has(id));
    entry.models = existing.filter((m) => !removed.includes(m.id));
    this.writeModelsJson(models);
    if (removed.length > 0) {
      let overlayChanged = false;
      for (const id of removed) {
        if (this.overlay!.models?.[provider]?.[id]) {
          delete this.overlay!.models[provider]![id];
          overlayChanged = true;
        }
        if (this.overlay!.tiers?.[provider]?.[id]) {
          delete this.overlay!.tiers[provider]![id];
          overlayChanged = true;
        }
      }
      if (overlayChanged) this.saveOverlay();
    }
    return { added, kept: [...existingIds].filter((id) => !removed.includes(id)), removed };
  }

  /**
   * 既定（番頭の標準・tier の第一候補）が、いま存在しないモデルを指していないか直す。
   *
   * **指したまま放置しない**（PO裁定 2026-08-04）——モデルが消えると番頭は起動も会話も
   * できなくなる。同じプロバイダ → 同じ tier → 残っているもの、の順で選び直し、
   * **何を何に付け替えたかを返す**（黙って別のモデルに変えない・I1）。
   */
  repairDefaults(): Array<{ role: string; from: string; to: string | undefined }> {
    this.ensureLoaded();
    const available = this.models();
    const changes: Array<{ role: string; from: string; to: string | undefined }> = [];
    const exists = (provider: string, id: string): boolean =>
      available.some((m) => m.providerId === provider && m.id === id);

    /**
     * 近いものを選ぶ：同じプロバイダ → 同じ tier → 残っているもの。
     *
     * **採用しているものから探し、1つも無ければ採用していないものからでも選ぶ**
     * ——動かない番頭より、採用の線引きを1つ広げるほうがましだから。その場合は
     * 選んだものを採用済みにして、状態が食い違わないようにする（変更は必ず返す）。
     */
    const replacement = (provider: string, tier: ModelTier, usable: "host" | "worker") => {
      const pick = (pool: LlmModelInfo[]): LlmModelInfo | undefined =>
        pool.find((m) => m.providerId === provider && m.tier === tier) ??
        pool.find((m) => m.providerId === provider) ??
        pool.find((m) => m.tier === tier) ??
        pool[0];
      const adopted = available.filter((m) => (usable === "host" ? m.hostUsable : m.workerUsable));
      const found = pick(adopted);
      if (found) return found;
      const fallback = pick(available);
      if (fallback) {
        this.setUsable(fallback.providerId, fallback.id, usable, true);
      }
      return fallback;
    };

    const host = this.overlay!.defaults?.host;
    if (host && !exists(host.provider, host.model)) {
      const tier = this.getTier(host.provider, host.model);
      const next = replacement(host.provider, tier, "host");
      changes.push({
        role: "番頭の標準",
        from: `${host.provider}/${host.model}`,
        to: next ? `${next.providerId}/${next.id}` : undefined,
      });
      if (next) this.overlay!.defaults!.host = { provider: next.providerId, model: next.id };
      else delete this.overlay!.defaults!.host;
      this.saveOverlay();
    }

    for (const [tier, pick] of Object.entries(this.overlay!.picks ?? {})) {
      if (!pick || exists(pick.provider, pick.model)) continue;
      const next = replacement(pick.provider, tier as ModelTier, "worker");
      changes.push({
        role: `${TIER_LABELS[tier as ModelTier] ?? tier}の第一候補`,
        from: `${pick.provider}/${pick.model}`,
        to: next ? `${next.providerId}/${next.id}` : undefined,
      });
      if (next) this.overlay!.picks![tier as ModelTier] = { provider: next.providerId, model: next.id };
      else delete this.overlay!.picks![tier as ModelTier];
      this.saveOverlay();
    }

    return changes;
  }

  /** models.json の生キー（`_` 表記のことがある）を、正規化した ID から引く。 */
  private rawProviderKey(models: ModelsJson, id: string): string | undefined {
    return Object.keys(models.providers).find((k) => k.replace(/_/g, "-") === id);
  }

  private readModelsJsonStrict(): ModelsJson {
    if (!fs.existsSync(this.modelsJsonPath)) return { providers: {} };
    const raw = fs.readFileSync(this.modelsJsonPath, "utf-8");
    let parsed: ModelsJson;
    try {
      parsed = JSON.parse(raw) as ModelsJson;
    } catch (err) {
      throw new Error(`${this.modelsJsonPath} を読めません（壊れた JSON）: ${String(err)}`);
    }
    parsed.providers ??= {};
    return parsed;
  }

  private readAuthStrict(): AuthJson {
    if (!fs.existsSync(this.authJsonPath)) return {};
    const raw = fs.readFileSync(this.authJsonPath, "utf-8");
    try {
      return JSON.parse(raw) as AuthJson;
    } catch (err) {
      throw new Error(`${this.authJsonPath} を読めません（壊れた JSON）: ${String(err)}`);
    }
  }

  private writeModelsJson(models: ModelsJson): void {
    fs.mkdirSync(path.dirname(this.modelsJsonPath), { recursive: true });
    fs.writeFileSync(this.modelsJsonPath, JSON.stringify(models, null, 2) + "\n", "utf-8");
    // 書いた直後は「外部で変更された」ではない。読み込み済みの印を更新する
    this.loadedHash = this.hashPiFiles();
  }

  /** キーのファイルは**本人だけが読める**まま保つ（0600）。 */
  private writeAuthJson(auth: AuthJson): void {
    fs.mkdirSync(path.dirname(this.authJsonPath), { recursive: true });
    fs.writeFileSync(this.authJsonPath, JSON.stringify(auth, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    // 既にあったファイルには mode が効かないので、明示的に絞り直す
    fs.chmodSync(this.authJsonPath, 0o600);
    this.loadedHash = this.hashPiFiles();
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

// ── ハーネスに依存しないモデル解決（task-0066）────────────────────────────────

/**
 * 台帳に無いモデルを、実体のプロバイダ/モデルへ紐付ける最小の定義（D6）。
 *
 * pi は API リクエストに `model.id` をそのまま使うため、id は API が受け付ける値で
 * なければならない。`Mimo V2.5 Free` という名前で動く実体は opencode-go の `mimo-v2.5`
 * ——指定文字列のまま解決すると opencode が 401 を返す（実際に踏んだ）。
 * 台帳に登録されたらここから外すこと。
 *
 * **番頭ホストと工房の両方が使う**ので core に置く（それぞれで持つと片方だけ直る）。
 */
export const MODEL_ALIASES: Record<string, { provider: string; id: string }> = {
  "Mimo V2.5 Free": { provider: "opencode-go", id: "mimo-v2.5" },
};

/**
 * pi の設定置き場（`~/.pi/agent`）。**pi を import せずに**同じ規則で組み立てる。
 *
 * 決定3（ハーネスは差し替え可能）の網（`banto-core-layering.spec.ts`）があるため、
 * banto-host 以外は pi の関数を呼べない。ここで見るのはファイルの置き場所だけで、
 * pi の型にも実装にも触らない——ファイルの形は ADR-0004 が既に前提にしている。
 */
export function piAgentDir(): string {
  const configured = process.env["PI_CODING_AGENT_DIR"];
  if (configured && configured.length > 0) {
    return configured.startsWith("~")
      ? path.join(os.homedir(), configured.slice(1))
      : configured;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * `models.json` だけを見るモデル解決器（ハーネス非依存）。
 *
 * **何のためにあるか。** 独立サービスとして立つ工房（Worker Pool）も tier→モデルを
 * 引く必要がある（決定60a：Kobo は tier までしか渡さない）。番頭ホストの解決器は pi の
 * モデル表（`@mariozechner/pi-ai`）を引くが、それを工房へ持ち込むと決定3 の
 * 「モジュールはハーネスに依存しない」が崩れる。
 *
 * **持ち込まなくても足りる**：解決の結果で実際に使われるのは provider と id だけで、
 * それは職人を起こすときに pi の CLI へ渡され、**最後の解決は pi 自身が行う**。
 * `models.json` に無いモデルは、指定された id をそのまま実体とみなす。
 *
 * 画面のためのモデル一覧（`getKnownModels`）は返さない——それが要るのは番頭ホストの
 * LLM 台帳の画面で、そちらは pi の表を持っている。
 */
export function createFileModelResolver(modelsJsonPath: string): LlmModelResolver {
  return {
    find(provider: string, modelId: string): ResolvedModel | undefined {
      const alias = MODEL_ALIASES[modelId];
      const actualProvider = alias?.provider ?? provider;
      const actualId = alias?.id ?? modelId;

      let parsed: { providers?: Record<string, { models?: Array<Record<string, unknown>> }> } = {};
      try {
        parsed = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) as typeof parsed;
      } catch {
        // ファイルが無い・壊れている：id をそのまま実体とみなす（pi 側が最後に解決する）
      }
      for (const [rawProvider, value] of Object.entries(parsed.providers ?? {})) {
        if (rawProvider.replace(/_/g, "-") !== actualProvider) continue;
        for (const m of value.models ?? []) {
          if (m["id"] !== actualId) continue;
          return {
            provider: actualProvider,
            id: actualId,
            name: (m["name"] as string | undefined) ?? actualId,
            input: (m["input"] as string[] | undefined) ?? [],
          };
        }
      }
      return { provider: actualProvider, id: actualId, name: modelId, input: [] };
    },
    getKnownModels(): undefined {
      return undefined;
    },
  };
}
