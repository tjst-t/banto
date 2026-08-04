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
  type ModelTier,
} from "@banto/core";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

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

/** `llm.*` を生成する。`createCanvasTools` と同じく bin.ts が中核の Tool 群として組む。 */
export function createLlmTools(options: LlmToolsOptions): NamespacedToolDefinition[] {
  const { catalog } = options;

  const list = defineNamespacedTool({
    name: "llm.list",
    label: "LLM: List",
    description:
      "プロバイダ・モデル・キー・tier・既定の一覧を返す。" +
      "職人にどのモデルで働かせるか決めるとき、自分のモデルを変えたいときに使う。",
    parameters: Type.Object({
      tier: Type.Optional(TierSchema),
    }),
    async execute(params) {
      const data = catalog.catalog();
      const models = params.tier ? data.models.filter((m) => m.tier === params.tier) : data.models;
      const text =
        `${data.providers.length} プロバイダ、${models.length} モデル` +
        (params.tier ? `（tier: ${TIER_LABELS[params.tier as ModelTier]}）` : "") +
        (data.files.changed ? "。pi の設定ファイルが外部で変更されています（llm.reload で読み直せます）" : "");
      return {
        content: [{ type: "text", text }],
        details: { ...data, models },
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

  const setHostDefault = defineNamespacedTool({
    name: "llm.set_host_default",
    label: "LLM: Set Host Default",
    description:
      "番頭自身の既定モデルを変える。番頭は連続した会話なので具体モデルで持つ。" +
      "次のセッションから効く。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
    }),
    async execute(params) {
      catalog.setHostDefault(params.provider, params.model);
      options.onHostModelChanged?.(params.provider, params.model);
      return {
        content: [
          {
            type: "text",
            text: `番頭の既定を ${params.provider}/${params.model} にしました。次のセッションから効きます。`,
          },
        ],
        details: { provider: params.provider, model: params.model },
      };
    },
  });

  const setWorkerTier = defineNamespacedTool({
    name: "llm.set_worker_tier",
    label: "LLM: Set Worker Tier",
    description:
      "職人の既定 tier を変える。職人はタスクごとに起こすので、具体モデルではなく tier で持つ。" +
      "次に起こす職人から効く。",
    parameters: Type.Object({ tier: TierSchema }),
    async execute(params) {
      const tier = params.tier as ModelTier;
      catalog.setWorkerTier(tier);
      options.onWorkerTierChanged?.(tier);
      const r = catalog.resolveForWorker(tier, {});
      return {
        content: [
          {
            type: "text",
            text:
              `職人の既定を ${TIER_LABELS[tier]} にしました。次に起こす職人から効きます` +
              (r ? `（制約なしのとき ${r.model.provider}/${r.model.id}）` : "") +
              "。",
          },
        ],
        details: { tier, resolved: r ?? null },
      };
    },
  });

  const setPick = defineNamespacedTool({
    name: "llm.set_pick",
    label: "LLM: Set Tier Pick",
    description:
      "そのモデルを、自分が属する tier の第一候補にする。制約で落ちたときは同じ tier の次の候補に降りる。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
    }),
    async execute(params) {
      catalog.setPick(params.provider, params.model);
      const tier = catalog.getTier(params.provider, params.model);
      return {
        content: [
          {
            type: "text",
            text: `${params.provider}/${params.model} を ${TIER_LABELS[tier]} の第一候補にしました。`,
          },
        ],
        details: { provider: params.provider, model: params.model, tier },
      };
    },
  });

  const setUsable = defineNamespacedTool({
    name: "llm.set_usable",
    label: "LLM: Set Usable",
    description:
      "そのモデルを番頭／職人が使ってよいかを切り替える。" +
      "番頭の既定・tier の第一候補になっているものは外せない。",
    parameters: Type.Object({
      provider: Type.String({ description: "プロバイダ名" }),
      model: Type.String({ description: "モデル ID" }),
      scope: ScopeSchema,
      usable: Type.Boolean({ description: "true=使ってよい" }),
    }),
    async execute(params) {
      catalog.setUsable(params.provider, params.model, params.scope as KeyScope, params.usable);
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

  return [
    list,
    resolve,
    setTier,
    setTierDescription,
    setHostDefault,
    setWorkerTier,
    setPick,
    setUsable,
    setProviderLocal,
    setKeyOrder,
    setKeyScope,
    reload,
  ];
}
