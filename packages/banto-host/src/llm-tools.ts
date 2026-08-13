/**
 * `llm.*` — LLM・モデル管理の中核ドメイン（ADR-0004 / ADR-0011 決定42）。
 *
 * `canvas.*` / `memory.*` / `skill.*` と同格。モジュールではない——番頭のセッションを
 * 組み立てるのにカタログが要るため、中核がこれに依存している。
 *
 * 番頭は具体モデルを持ち、職人は tier で指定する。番頭が職人へ振るときに出すのは
 * モデル名ではなく (tier, 制約)。tier は難度の軸、制約は候補を絞る条件。
 *
 * D5: 判断は持たない。tier → モデルの解決は LlmCatalog が表で引く。
 */

import { Type } from "typebox";
import {
  LlmCatalog,
  TIER_LABELS,
  type KeyScope,
  type ModelConstraints,
  type ModelUse,
  type ModelTier,
  LLM_ROLES,
  isLlmRole,
} from "@banto/core";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

/**
 * 一覧の既定・最大の件数。
 *
 * **全件を運ばない**——OpenRouter のように337件あるプロバイダでは、開くたびに数十KBを
 * 運ぶうえ、画面に並べても選べない。既定は採用しているものだけを返し、探すときは
 * 検索で絞る（ADR-0011 決定47）。
 */
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/** モデル一覧の取得を待つ上限。応答の無い到達先で番頭ごと止めない。 */
const FETCH_MODELS_TIMEOUT_MS = 10_000;

/**
 * 公開のモデル台帳（models.dev）。**文脈長を埋めるためだけ**に見る。
 *
 * プロバイダの `/models` は文脈長を返さず、ハーネスの組み込み定義も新しいモデルには
 * 追いつかない。そこが埋まらないと pi は文脈長を 0 として扱い、**毎ターン自動要約が
 * 走る**（`shouldCompact` は `tokens > 0 - reserve` で常に真）。推測値を置くより、
 * 公開されている実際の値を引くほうが正しい。
 *
 * 取りに行くのは**取り込みを押したときだけ**。落ちていても取り込み自体は続ける（I2）。
 */
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 15_000;
/** 取り込みを続けて押したときに毎回3MB取りに行かないための、プロセス内の覚え書き。 */
const MODELS_DEV_TTL_MS = 10 * 60 * 1000;

interface ModelsDevEntry {
  limit?: { context?: number; output?: number };
  /** 100万トークンあたりの値段。選ぶときの軸になるので一緒に取り込む。 */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}
type ModelsDevCatalog = Record<string, { models?: Record<string, ModelsDevEntry> }>;

let modelsDevCache: { at: number; data: ModelsDevCatalog } | undefined;

/**
 * models.dev の台帳を取る。**取れなくても例外にしない**——文脈長が埋まらないだけで、
 * 取り込みそのものは成り立つ。取れなかったことは呼び出し側が文言に載せる。
 */
async function loadModelsDev(now: number): Promise<ModelsDevCatalog | undefined> {
  if (modelsDevCache && now - modelsDevCache.at < MODELS_DEV_TTL_MS) return modelsDevCache.data;
  try {
    const res = await fetch(MODELS_DEV_URL, {
      signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as ModelsDevCatalog;
    modelsDevCache = { at: now, data };
    return data;
  } catch {
    return undefined;
  }
}

/**
 * 台帳から文脈長を引く。**同じプロバイダを先に見て、無ければ同じ ID を横断で探す**
 * ——同じモデルが複数の経路（opencode 経由の claude 等）で出ているため。
 */
export function contextWindowFromCatalog(
  catalog: ModelsDevCatalog | undefined,
  provider: string,
  id: string
): { context?: number; output?: number } | undefined {
  return entryFromCatalog(catalog, provider, id)?.limit;
}

/** 台帳の1件を引く。同じプロバイダを先に見て、無ければ同じ ID を横断で探す。 */
function entryFromCatalog(
  catalog: ModelsDevCatalog | undefined,
  provider: string,
  id: string
): ModelsDevEntry | undefined {
  if (!catalog) return undefined;
  const exact = catalog[provider]?.models?.[id];
  if (exact?.limit?.context) return exact;
  for (const entry of Object.values(catalog)) {
    const found = entry.models?.[id];
    if (found?.limit?.context) return found;
  }
  return exact;
}

/** 台帳の値段を、こちらの形（入力/出力/キャッシュ）へ。分からなければ undefined。 */
export function costFromCatalog(
  catalog: ModelsDevCatalog | undefined,
  provider: string,
  id: string
): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  const cost = entryFromCatalog(catalog, provider, id)?.cost;
  if (!cost || (cost.input === undefined && cost.output === undefined)) return undefined;
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite: cost.cache_write ?? 0,
  };
}

const TierSchema = Type.Union(
  [Type.Literal("reasoning"), Type.Literal("standard"), Type.Literal("fast")],
  { description: "reasoning=高精度、standard=通常、fast=高速" }
);

const ScopeSchema = Type.Union([Type.Literal("host"), Type.Literal("worker")], {
  description: "host=番頭、worker=職人",
});

const ConstraintsSchema = Type.Object(
  {
    vision: Type.Optional(Type.Boolean({ description: "画像を読む必要がある" })),
    local: Type.Optional(Type.Boolean({ description: "外に出さない（ローカル実行のみ）" })),
    free: Type.Optional(Type.Boolean({ description: "有料キーを使わない" })),
  },
  { description: "候補を絞る条件。tier と直交し、満たせないなら解決しない" }
);

export interface LlmToolsOptions {
  catalog: LlmCatalog;
  /** 職人の既定 tier が変わったときに Worker Pool へ伝える口。 */
  onWorkerTierChanged?: (tier: ModelTier) => void;
  /** 番頭の既定モデルが変わったとき、ホストのセッションに知らせる口。 */
  onHostModelChanged?: (provider: string, model: string) => void;
}

/**
 * `llm.*` の内訳（ADR-0020 決定98f）。
 *
 * **番頭が持つのは読みと診断だけ。** 設定変更は GUI とファイルの担当にする
 * ——調べた製品はどこもモデル設定をエージェントの Tool にしていないし、ADR-0019 の
 * 実測でも19本中13本が一度も呼ばれていなかった（決定41c「設定の口は番頭に渡さない」）。
 *
 * **`settings` も在庫からは消さない。** モジュールの HTTP 面（`coreTools`）が
 * これを引くので、消すと設定画面が 404 になる（ADR-0019 決定82 と同じ理由）。
 */
export interface LlmToolSets {
  /** 番頭に渡す4本。読み（`list` / `resolve`）と診断（`check_key`）と取り込み直し（`reload`）。 */
  tools: NamespacedToolDefinition[];
  /** 設定画面だけが使う13本。番頭の道具箱には入れないが、HTTP 面には出す。 */
  settings: NamespacedToolDefinition[];
}

/** `llm.*` を生成する。`createCanvasTools` と同じく bin.ts が中核の Tool 群として組む。 */
export function createLlmTools(options: LlmToolsOptions): LlmToolSets {
  const { catalog } = options;

  const list = defineNamespacedTool({
    name: "llm.list",
    label: "LLM: List",
    description:
      "プロバイダ・モデル・キー・tier・既定の一覧を返す。" +
      "**全件は返さない**——プロバイダによっては数百のモデルがあるので、" +
      "既定では採用しているものだけ。探すときは query と絞り込みを使う。",
    parameters: Type.Object({
      tier: Type.Optional(TierSchema),
      /** 名前・ID の部分一致。空白区切りの語は**すべて**含むものを返す。 */
      query: Type.Optional(Type.String({ description: "名前・IDで絞る（空白区切りで絞り込み）" })),
      /** プロバイダで絞る。検索語と混ぜない（順番で結果が変わってしまう）。 */
      provider: Type.Optional(Type.String({ description: "このプロバイダのものだけ" })),
      adopted: Type.Optional(
        Type.Boolean({ description: "採用しているものだけ（既定 true）。false で全部から探す" })
      ),
      vision: Type.Optional(Type.Boolean({ description: "画像を読めるものだけ" })),
      free: Type.Optional(Type.Boolean({ description: "無料のものだけ" })),
      minContext: Type.Optional(Type.Number({ description: "文脈長がこれ以上のものだけ" })),
      sort: Type.Optional(
        Type.Union([Type.Literal("name"), Type.Literal("context"), Type.Literal("price")], {
          description: "並び順。既定は name",
        })
      ),
      limit: Type.Optional(Type.Number({ description: `返す最大件数（既定 ${LIST_DEFAULT_LIMIT}）` })),
    }),
    async execute(params) {
      const data = catalog.catalog();
      const adoptedOnly = params.adopted ?? true;
      const q = (params.query ?? "").trim().toLowerCase();
      let models = data.models;
      if (adoptedOnly) models = models.filter((m) => m.policy.length > 0);
      if (params.provider) models = models.filter((m) => m.providerId === params.provider);
      if (params.tier) models = models.filter((m) => m.tier === params.tier);
      if (params.vision) models = models.filter((m) => m.vision);
      if (params.free) models = models.filter((m) => m.free);
      if (params.minContext) {
        models = models.filter((m) => (m.contextWindow ?? 0) >= (params.minContext as number));
      }
      if (q.length > 0) {
        // **語ごとに見る**——「opus 4.5」のように打っても、順番に関係なく当たる
        const words = q.split(/\s+/).filter((w) => w.length > 0);
        models = models.filter((m) => {
          const hay = `${m.providerId} ${m.id} ${m.name}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
      }
      const matched = models.length;
      const sorted = [...models].sort((a, b) => {
        if (params.sort === "context") return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
        if (params.sort === "price") {
          // 値段が分からないものは後ろへ（安い順に見たいのに紛れ込ませない）
          const pa = a.cost ? a.cost.input + a.cost.output : Number.POSITIVE_INFINITY;
          const pb = b.cost ? b.cost.input + b.cost.output : Number.POSITIVE_INFINITY;
          if (pa !== pb) return pa - pb;
        }
        const pc = a.providerId.localeCompare(b.providerId);
        return pc !== 0 ? pc : a.id.localeCompare(b.id);
      });
      const limit = Math.max(1, Math.min(params.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT));
      const page = sorted.slice(0, limit);
      const text =
        `${data.providers.length} プロバイダ` +
        `、${adoptedOnly ? "採用中" : "全体"}から ${matched} 件` +
        (page.length < matched ? `（うち ${page.length} 件を返す）` : "") +
        (data.files.changed ? "。pi の設定ファイルが外部で変更されています（llm.reload で読み直せます）" : "");
      return {
        content: [{ type: "text", text }],
        // I1: 切ったことを隠さない。総数と、返した件数の両方を出す
        details: { ...data, models: page, matched, total: data.models.length, truncated: page.length < matched },
      };
    },
  });

  const resolve = defineNamespacedTool({
    name: "llm.resolve",
    label: "LLM: Resolve",
    description:
      "職人へ振るときのモデルを (tier, 制約) から解決する。モデル名を直接選ばずこれを使うと、" +
      "モデルが入れ替わっても判断がそのまま使え、なぜそれが選ばれたかを後から追える。" +
      "制約は緩めないので、満たせないときはエラーになる。",
    parameters: Type.Object({
      tier: Type.Optional(TierSchema),
      constraints: Type.Optional(ConstraintsSchema),
    }),
    async execute(params) {
      const constraints = (params.constraints ?? {}) as ModelConstraints;
      const r = catalog.resolveForWorker(params.tier as ModelTier | undefined, constraints);
      if (!r) {
        const named = Object.entries(constraints)
          .filter(([, v]) => v)
          .map(([k]) => k);
        throw new Error(
          `条件を満たすモデルがありません（tier: ${params.tier ?? "既定"}` +
            (named.length ? `, 制約: ${named.join(", ")}` : "") +
            "）。制約を緩めるか、その tier に条件を満たすモデルを足してください。"
        );
      }
      const notes: string[] = [];
      if (r.usedFallbackTier) {
        notes.push(
          `${TIER_LABELS[r.requestedTier]} に候補が無いため ${TIER_LABELS[r.tier]} に落ちました`
        );
      }
      if (r.droppedPick) notes.push("第一候補は制約で落ちたため同じ tier の次の候補です");
      if (!r.key) notes.push("このプロバイダに職人が使える生きたキーがありません");
      return {
        content: [
          {
            type: "text",
            text:
              `${r.model.provider}/${r.model.id}（${TIER_LABELS[r.tier]}）` +
              (r.key ? ` · キー ${r.key.name}` : "") +
              (notes.length ? `。${notes.join("。")}` : ""),
          },
        ],
        details: r,
      };
    },
  });

  const setTier = defineNamespacedTool({
    name: "llm.set_tier",
    label: "LLM: Set Tier",
    description:
      "モデルをどの tier に置くかを変える。tier ごとの説明文（llm.set_tier_description）が" +
      "そのタスクに当てはまるかで決める。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
      tier: TierSchema,
    }),
    async execute(params) {
      catalog.setTier(params.provider, params.model, params.tier as ModelTier);
      return {
        content: [
          {
            type: "text",
            text: `${params.provider}/${params.model} を ${TIER_LABELS[params.tier as ModelTier]} にしました。`,
          },
        ],
        details: { provider: params.provider, model: params.model, tier: params.tier },
      };
    },
  });

  const setTierDescription = defineNamespacedTool({
    name: "llm.set_tier_description",
    label: "LLM: Set Tier Description",
    description:
      "tier の説明文を書き換える。これは番頭が「このタスクはどの tier か」を決めるときの基準になる。",
    parameters: Type.Object({
      tier: TierSchema,
      description: Type.String({ description: "どんなタスクをこの tier に入れるか" }),
    }),
    async execute(params) {
      catalog.setTierDescription(params.tier as ModelTier, params.description);
      return {
        content: [
          { type: "text", text: `${TIER_LABELS[params.tier as ModelTier]} の基準を更新しました。` },
        ],
        details: { tier: params.tier, description: params.description },
      };
    },
  });

  /**
   * **役割にモデルを割り当てる**（ADR-0020 決定94）。
   *
   * `llm.set_host_default` / `llm.set_pick` / `llm.set_worker_tier` の3本を畳んだもの。
   * 束縛の表が `roles` 1つになったので、口も1つでよい——3本あったのは、
   * 「番頭の既定」と「tier の第一候補」が別の表だったことの写しだった。
   */
  const setRole = defineNamespacedTool({
    name: "llm.set_role",
    label: "LLM: Assign role",
    description:
      "役割にモデルを割り当てる。`steward`＝番頭が使うモデル、" +
      "`worker.reasoning` / `worker.standard` / `worker.fast`＝職人が等級ごとに使うモデル。" +
      "割り当てると同時に採用も立つ（使えないモデルは割り当てられないため）。" +
      "**backend まで含めて指定する**——同じ `opus` が pi 経由でも Claude Code 経由でも指せる。",
    parameters: Type.Object({
      role: Type.String({
        description: "steward / worker.reasoning / worker.standard / worker.fast",
      }),
      /**
       * **どの経路で呼ぶか**（ADR-0021 決定103）。省略は `pi` を意味する
       * ——ここが無かったので、画面から選び直すたびに束縛の `backend` が落ちていた。
       */
      backend: Type.Optional(
        Type.String({ description: "pi / claude-agent-sdk（省略時は pi）" })
      ),
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
    }),
    async execute(params) {
      // I2: 知らない役割を黙って作らない
      if (!isLlmRole(params.role)) {
        throw new Error(
          `知らない役割です: ${params.role}（${LLM_ROLES.join(" / ")} のどれか）`
        );
      }
      catalog.setRole(params.role as never, params.provider, params.model, params.backend);
      if (params.role === "steward") {
        options.onHostModelChanged?.(params.provider, params.model);
      }
      return {
        content: [
          {
            type: "text",
            text:
              `${params.role} に ${params.backend ?? "pi"}/${params.provider}/${params.model} を` +
              "割り当てました。",
          },
        ],
        details: { role: params.role, provider: params.provider, model: params.model },
      };
    },
  });

  const setUsable = defineNamespacedTool({
    name: "llm.set_policy",
    label: "LLM: Set Policy",
    description:
      "そのモデルを番頭／職人が使ってよいかを切り替える（採用の方針・決定98）。" +
      "番頭の既定・tier の第一候補になっているものは外せない。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
      scope: ScopeSchema,
      usable: Type.Boolean({ description: "true=使ってよい" }),
    }),
    async execute(params) {
      catalog.setPolicy(params.provider, params.model, params.scope as ModelUse, params.usable);
      const label = params.scope === "host" ? "番頭" : "職人";
      return {
        content: [
          {
            type: "text",
            text: `${params.provider}/${params.model} を${label}が${params.usable ? "使える" : "使えない"}ようにしました。`,
          },
        ],
        details: params,
      };
    },
  });

  /**
   * **文脈長を手で入れる**（PO要望 2026-08-11）。
   *
   * プロバイダの `/models` は文脈長を返さないことがある（huihui の
   * `deepseek-v4-flash-abliterated` は 1M あるのに分からない）。分からないままだと
   * 章立ての閾値も文脈の目盛りも効かず、**実際より短いものとして**進む。
   */
  const setContextWindow = defineNamespacedTool({
    name: "llm.set_context_window",
    label: "LLM: Set Context Window",
    description:
      "そのモデルの**文脈長を手で入れる**（プロバイダが返さないとき）。" +
      "分からないままだと章立ての閾値も文脈の目盛りも効かず、実際より短いものとして進む。" +
      "**手で入れた値が優先**——あとからプロバイダが返してきても上書きされない。" +
      "空にすると手入力を取り消し、プロバイダが言う値に戻る。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
      contextWindow: Type.Optional(
        Type.Number({
          description:
            "文脈長（トークン数）。例: 1000000。省略すると手入力を取り消してプロバイダの値に戻す",
        })
      ),
    }),
    async execute(params) {
      catalog.setContextWindow(params.provider, params.model, params.contextWindow);
      return {
        content: [
          {
            type: "text",
            text:
              params.contextWindow === undefined
                ? `${params.provider}/${params.model} の文脈長の手入力を取り消しました。`
                : `${params.provider}/${params.model} の文脈長を ${params.contextWindow.toLocaleString()} トークンにしました。`,
          },
        ],
        details: params,
      };
    },
  });

  const setProviderLocal = defineNamespacedTool({
    name: "llm.set_provider_local",
    label: "LLM: Set Provider Local",
    description:
      "そのプロバイダが外に出ない（ローカル実行）かどうかを設定する。" +
      "URL からは判別できない（localhost 宛でも外へ中継するものがある）ので明示で持つ。" +
      "制約 local を要求したときの候補はここで決まる。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      local: Type.Boolean({ description: "true=外に出ない" }),
    }),
    async execute(params) {
      catalog.setProviderLocal(params.provider, params.local);
      return {
        content: [
          {
            type: "text",
            text: `${params.provider} を${params.local ? "ローカル実行" : "外部"}として扱います。`,
          },
        ],
        details: params,
      };
    },
  });

  const setKeyOrder = defineNamespacedTool({
    name: "llm.set_key_order",
    label: "LLM: Set Key Order",
    description:
      "プロバイダのキーを消費したい順に並べ替える。上から順に使い、上限に来たら次のキーへ落ちる。" +
      "auth.json 自体は書き換えない。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      order: Type.Array(Type.String(), { description: "キー名を消費したい順に並べたもの" }),
    }),
    async execute(params) {
      catalog.setKeyOrder(params.provider, params.order);
      return {
        content: [{ type: "text", text: `${params.provider} のキーの順を更新しました。` }],
        details: params,
      };
    },
  });

  const setKeyScope = defineNamespacedTool({
    name: "llm.set_key_scope",
    label: "LLM: Set Key Scope",
    description:
      "そのキーを番頭／職人が使ってよいかを切り替える。個人鍵は職人だけ、仕事鍵は番頭だけ、" +
      "といった分け方ができる。最後の1本は外せない。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      key: Type.String({ description: "キー名" }),
      scope: ScopeSchema,
      allowed: Type.Boolean({ description: "true=使ってよい" }),
    }),
    async execute(params) {
      catalog.setKeyScope(params.provider, params.key, params.scope as KeyScope, params.allowed);
      const label = params.scope === "host" ? "番頭" : "職人";
      return {
        content: [
          {
            type: "text",
            text: `${params.provider}/${params.key} を${label}が${params.allowed ? "使える" : "使えない"}ようにしました。`,
          },
        ],
        details: params,
      };
    },
  });

  const reload = defineNamespacedTool({
    name: "llm.reload",
    label: "LLM: Reload",
    description:
      "pi の設定ファイル（models.json / auth.json）を読み直す。" +
      "banto の外でファイルが編集されたときに使う。",
    parameters: Type.Object({}),
    async execute() {
      catalog.reload();
      const data = catalog.catalog();
      return {
        content: [
          {
            type: "text",
            text: `読み直しました（${data.providers.length} プロバイダ、${data.models.length} モデル）。`,
          },
        ],
        details: data.files,
      };
    },
  });

  const addProvider = defineNamespacedTool({
    name: "llm.add_provider",
    label: "LLM: Add Provider",
    description:
      "プロバイダを足す。OpenAI 互換の到達先（baseUrl）を登録し、キーは llm.set_key で入れる。" +
      "モデルは llm.fetch_models でプロバイダから取り込む。",
    parameters: Type.Object({
      id: Type.String({ description: "プロバイダ名（一意）" }),
      baseUrl: Type.String({ description: "API の到達先。例 http://host:8000/v1" }),
      api: Type.Optional(Type.String({ description: "pi の API 種別。既定 openai-completions" })),
      apiKey: Type.Optional(Type.String({ description: "同時に入れるキー（省略可）" })),
    }),
    async execute(params) {
      catalog.addProvider({
        id: params.id,
        baseUrl: params.baseUrl,
        ...(params.api ? { api: params.api } : {}),
      });
      if (params.apiKey) catalog.setKey(params.id, params.apiKey);
      catalog.reload();
      return {
        content: [
          {
            type: "text",
            text:
              `${params.id} を足しました（${params.baseUrl}）。` +
              (params.apiKey ? "キーも入れました。" : "キーはまだありません。") +
              "モデルは llm.fetch_models で取り込めます。",
          },
        ],
        details: { id: params.id, baseUrl: params.baseUrl },
      };
    },
  });

  const removeProvider = defineNamespacedTool({
    name: "llm.remove_provider",
    label: "LLM: Remove Provider",
    description:
      "プロバイダを消す。キーと並び順・使用可の設定も一緒に消える。" +
      "番頭・職人の既定がそのプロバイダを指していた場合は解決できなくなるので、先に付け替えること。",
    parameters: Type.Object({ id: Type.String() }),
    async execute(params) {
      catalog.removeProvider(params.id);
      catalog.reload();
      return {
        content: [{ type: "text", text: `${params.id} を消しました（キーと設定も一緒に）。` }],
        details: { id: params.id },
      };
    },
  });

  const setKey = defineNamespacedTool({
    name: "llm.set_key",
    label: "LLM: Set Key",
    description:
      "プロバイダの API キーを入れる（入れ直すと差し替え）。" +
      "**キーは保存するだけで、読み出す口は無い**——一覧には名前と状態しか出ない。",
    parameters: Type.Object({
      provider: Type.String(),
      key: Type.String({ description: "API キー" }),
    }),
    async execute(params) {
      catalog.setKey(params.provider, params.key);
      catalog.reload();
      return {
        content: [{ type: "text", text: `${params.provider} のキーを入れました。` }],
        details: { provider: params.provider },
      };
    },
  });

  const removeKey = defineNamespacedTool({
    name: "llm.remove_key",
    label: "LLM: Remove Key",
    description: "プロバイダの API キーを消す。プロバイダ自体は残る。",
    parameters: Type.Object({ provider: Type.String() }),
    async execute(params) {
      catalog.removeKey(params.provider);
      catalog.reload();
      return {
        content: [{ type: "text", text: `${params.provider} のキーを消しました。` }],
        details: { provider: params.provider },
      };
    },
  });

  const checkKey = defineNamespacedTool({
    name: "llm.check_key",
    label: "LLM: Check Key",
    description:
      "そのプロバイダの API キーが通るか確かめる（到達先へ軽く1回問い合わせる）。" +
      "**確かめるまで状態は分からない**——入れただけでは有効かどうか誰も知らない。",
    parameters: Type.Object({ provider: Type.String() }),
    async execute(params) {
      const baseUrl = catalog.baseUrlOf(params.provider);
      if (!baseUrl) {
        throw new Error(`${params.provider} に到達先（baseUrl）が無いので確かめられません`);
      }
      const key = catalog.apiKeyFor(params.provider);
      if (!key) throw new Error(`${params.provider} にキーがありません`);

      const url = `${baseUrl.replace(/\/$/, "")}/models`;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS),
        });
      } catch (err) {
        // I2: 届かなかったことを「無効」と言わない（鍵の話ではない）
        throw new Error(`${url} に届きません: ${String(err)}`);
      }

      // 鍵の名前は auth.json 上のプロバイダ名（いまは1プロバイダ1鍵）
      const keyName = params.provider;
      if (res.status === 401 || res.status === 403) {
        catalog.markKeyInvalid(params.provider, keyName);
        return {
          content: [{ type: "text", text: `${params.provider} のキーは受け付けられませんでした（${res.status}）。` }],
          details: { provider: params.provider, state: "invalid", status: res.status },
        };
      }
      if (res.status === 429) {
        // いつまで待てばよいかはヘッダ次第。分からなければ1分後に戻す
        const retryAfter = Number(res.headers.get("retry-after"));
        const until = new Date(Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000));
        catalog.markKeyLimited(params.provider, keyName, until);
        return {
          content: [{ type: "text", text: `${params.provider} のキーは上限に当たっています（429）。` }],
          details: { provider: params.provider, state: "limited", status: res.status },
        };
      }
      if (!res.ok) {
        throw new Error(`${url} が ${res.status} を返しました（キーの可否は判断できません）`);
      }
      catalog.markKeyOk(params.provider, keyName);
      return {
        content: [{ type: "text", text: `${params.provider} のキーは有効です。` }],
        details: { provider: params.provider, state: "ok", status: res.status },
      };
    },
  });

  const fetchModels = defineNamespacedTool({
    name: "llm.fetch_models",
    label: "LLM: Fetch Models",
    description:
      "プロバイダに問い合わせてモデル一覧を取り込む（OpenAI 互換の `/models`）。" +
      "**提供されるモデルは変わる**ので、増えていないか疑ったときに叩く。" +
      "画像可否はハーネスの組み込み定義から、文脈長は公開台帳（models.dev）からも補う。" +
      "既にある設定は据え置き、欠けているところだけ埋める。",
    parameters: Type.Object({ provider: Type.String() }),
    async execute(params) {
      const baseUrl = catalog.baseUrlOf(params.provider);
      const known = catalog.knownModels(params.provider);
      let fetched: Array<{
        id: string;
        name?: string;
        input?: string[];
        contextWindow?: number;
        maxTokens?: number;
        cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      }>;
      let source: string;
      let ensure: { baseUrl?: string; api?: string } | undefined;

      let trustCapabilities = false;
      if (baseUrl) {
        const listed = await fetchProviderModels(baseUrl, catalog.apiKeyFor(params.provider));
        // **どのモデルがあるか**は到達先が新しい。**何ができるか**は組み込み定義が知っている
        // （`/models` は画像可否も文脈長も返さない）。両方を突き合わせて足す
        const byId = new Map(known.map((m) => [m.id, m]));
        fetched = listed.map((m) => {
          const builtin = byId.get(m.id);
          return {
            ...m,
            ...(builtin?.input ? { input: builtin.input } : {}),
            ...(m.contextWindow ?? builtin?.contextWindow
              ? { contextWindow: m.contextWindow ?? builtin?.contextWindow }
              : {}),
            ...(m.maxTokens ?? builtin?.maxTokens
              ? { maxTokens: m.maxTokens ?? builtin?.maxTokens }
              : {}),
          };
        });
        trustCapabilities = byId.size > 0;
        source = baseUrl + (byId.size > 0 ? "（能力は組み込み定義から補完）" : "");
      } else if (known.length > 0) {
        // 鍵だけがあるプロバイダ（pi が到達先とモデルを内蔵しているもの）。
        // **問い合わせるより情報が多い**——画像可否まで分かる
        fetched = known.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.input ? { input: m.input } : {}),
          // 組み込み定義は文脈の長さまで知っている（`/models` は返さないことが多い）
          ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
          ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
          ...(m.cost ? { cost: m.cost } : {}),
        }));
        source = "ハーネスの組み込み定義";
        trustCapabilities = true;
        ensure = {
          ...(known[0]?.baseUrl ? { baseUrl: known[0].baseUrl } : {}),
          ...(known[0]?.api ? { api: known[0].api } : {}),
        };
      } else {
        // I2: 取れない理由を名乗る。「0 件でした」で済ませない
        throw new Error(
          `${params.provider} は到達先（baseUrl）も組み込みの定義も無いため、モデルを取り込めません`
        );
      }

      // まだ文脈長が分からないものを公開台帳（models.dev）で埋める。
      // ここが空のままだと pi が 0 として扱い、毎ターン要約が走る
      const needsCatalog = fetched.filter((m) => !m.contextWindow || !m.cost);
      let filledFromCatalog = 0;
      let catalogReachable = true;
      if (needsCatalog.length > 0) {
        const published = await loadModelsDev(Date.now());
        catalogReachable = published !== undefined;
        for (const model of needsCatalog) {
          const limit = contextWindowFromCatalog(published, params.provider, model.id);
          if (limit?.context && !model.contextWindow) {
            model.contextWindow = limit.context;
            if (limit.output && !model.maxTokens) model.maxTokens = limit.output;
            filledFromCatalog += 1;
          }
          // 値段は「どれを選ぶか」の軸になるので、文脈長と一緒に取り込む
          if (!model.cost) {
            const cost = costFromCatalog(published, params.provider, model.id);
            if (cost) model.cost = cost;
          }
        }
      }

      // 消える前に「採用していたもの」を控える（消えたあとでは分からない）
      const adoptedBefore = new Set(
        catalog
          .models()
          .filter((m) => m.providerId === params.provider && m.policy.length > 0)
          .map((m) => m.id)
      );
      const result = catalog.mergeModels(params.provider, fetched, ensure, trustCapabilities);
      catalog.reload();
      const notes: string[] = [`取り込み元: ${source}`];
      if (filledFromCatalog > 0) notes.push(`文脈長を ${filledFromCatalog} 件 models.dev から補いました`);
      const stillUnknown = fetched.filter((m) => !m.contextWindow).length;
      if (stillUnknown > 0) {
        // I1: 埋まらなかったことを隠さない。0 のままだと毎ターン要約が走る
        notes.push(
          `文脈長が分からないモデルが ${stillUnknown} 件あります` +
            (catalogReachable ? "" : "（models.dev に届きませんでした）")
        );
      }
      if (result.added.length > 0) notes.push(`${result.added.length} 件を足しました`);
      else notes.push("新しいモデルはありませんでした");
      if (result.removed.length > 0) {
        // **採用していたものが消えたときだけ強く言う**——プロバイダが数百のモデルを
        // 出し入れする世界では、採用していないものの増減はいちいち報告に値しない
        const lostAdopted = result.removed.filter((id) => adoptedBefore.has(id));
        if (lostAdopted.length > 0) {
          notes.push(`⚠ 採用していた ${lostAdopted.length} 件が無くなりました（${lostAdopted.join(", ")}）`);
        }
        const rest = result.removed.length - lostAdopted.length;
        if (rest > 0) notes.push(`無くなった ${rest} 件を消しました`);
      }
      // 消した結果、既定が居なくなっていたら選び直す。**何をどう変えたかを言う**
      const repaired = catalog.repairDefaults();
      for (const change of repaired) {
        notes.push(
          change.to
            ? `⚠ ${change.role}（${change.from}）が無くなったので ${change.to} にしました`
            : `⚠ ${change.role}（${change.from}）が無くなり、代わりが見つかりません`
        );
      }
      return {
        content: [{ type: "text", text: `${params.provider}: ${notes.join("。")}。` }],
        details: { ...result, repaired, lostAdopted: result.removed.filter((id) => adoptedBefore.has(id)) },
      };
    },
  });

  return {
    /**
     * **番頭が持つ4本**（決定98f）。
     *
     * `list` は「いま自分は何で動いているか」——これが無いとモデルの相談そのものが
     * できない（実測32回・`llm.*` の中で最多）。`resolve` は職人へ振るときの
     * 「その等級だと何になるか」。`check_key` と `reload` は**診断と取り込み直し**で、
     * 設定を変えるものではない（変えるのは人）。
     */
    tools: [list, resolve, checkKey, reload],
    /** 設定画面の口。**番頭には渡さない**が、HTTP 面には出す（消すと画面が 404 になる）。 */
    settings: [
      setTier,
      setTierDescription,
      setRole,
      setUsable,
      setContextWindow,
      setProviderLocal,
      setKeyOrder,
      setKeyScope,
      addProvider,
      removeProvider,
      setKey,
      removeKey,
      fetchModels,
    ],
  };
}

/**
 * OpenAI 互換の `/models` を叩いてモデル一覧を取る。
 *
 * 返ってくるのは基本的に ID だけで、画像を読めるかは分からない（`mode` や
 * `max_*_tokens` を返す実装もあるので、あれば拾う）。
 * D6: fetch は Node 標準。HTTP クライアントを足さない。
 */
async function fetchProviderModels(
  baseUrl: string,
  apiKey: string | undefined
): Promise<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>> {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    // 応答の無い到達先で番頭ごと待たせない
    signal: AbortSignal.timeout(FETCH_MODELS_TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new Error(`${url} に届きません: ${String(err)}`);
  });
  if (!res.ok) throw new Error(`${url} が ${res.status} を返しました`);
  const body = (await res.json()) as {
    data?: Array<{
      id?: unknown;
      max_input_tokens?: unknown;
      max_output_tokens?: unknown;
    }>;
  };
  if (!Array.isArray(body.data)) throw new Error(`${url} の応答に data がありません`);
  return body.data
    .filter((m): m is { id: string } & typeof m => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({
      id: m.id,
      ...(typeof m.max_input_tokens === "number" ? { contextWindow: m.max_input_tokens } : {}),
      ...(typeof m.max_output_tokens === "number" ? { maxTokens: m.max_output_tokens } : {}),
    }));
}
