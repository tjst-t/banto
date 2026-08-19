/**
 * Banto 中核が設定画面に出す区画（決定41・task-0047）。
 *
 * モジュールと**同じ契約で自分の分も出す**——中核だけ特別扱いにすると、設定画面が
 * 「中核用の描画」と「モジュール用の描画」を2つ持つことになる。
 *
 * ここが持つのは、モジュールに属さないもの：場所・接続・LLM。
 *
 * LLM だけは項目の宣言で表しきれないため、設定画面が専用の面を描く
 * （ADR-0011 決定43。中核の区画にだけ許した例外で、モジュールには決定41 がそのまま効く）。
 * その面が使う `llm.*` は中核の Tool なので、区画は `view` で描き先だけを宣言する。
 */

import { MODEL_TIERS, TIER_LABELS, workerRoleOf } from "@banto/core";
import type { LlmCatalog, ModelTier, ModuleSettingsSpec, SettingField } from "@banto/core";
import type { ChapterModelResolution } from "./chapter-model.js";
import type { PlaceSetting, SettingsStore } from "./settings-store.js";

/** 場所は1行1件のテキストで扱う（`id:/path:glob,glob`）。表形式は画面が育ってから。 */
function placesToLines(places: readonly PlaceSetting[]): string[] {
  return places.map((p) =>
    p.writable && p.writable.length > 0 ? `${p.id}:${p.path}:${p.writable.join(",")}` : `${p.id}:${p.path}`
  );
}

function linesToPlaces(lines: readonly unknown[]): PlaceSetting[] {
  const places: PlaceSetting[] = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (line.length === 0) continue;
    const [id, target, writable] = line.split(":");
    // I2: 壊れた行を黙って飛ばさない。場所が1つ消えると番頭が別の場所を触りうる
    if (!id || !target) {
      throw new Error(`場所の指定が不正です: "${line}"（形式は id:/path または id:/path:glob,glob）`);
    }
    places.push({
      id: id.trim(),
      path: target.trim(),
      ...(writable
        ? { writable: writable.split(",").map((w) => w.trim()).filter((w) => w.length > 0) }
        : {}),
    });
  }
  return places;
}

/** 束縛を画面の値（`backend|provider|model`）へ。 */
function refValue(ref?: { backend?: string; provider: string; model: string }): string {
  return ref ? `${ref.backend ?? "pi"}|${ref.provider}|${ref.model}` : "";
}

/** 束縛を人が読む形へ（`backend › provider › model`）。 */
function refLabel(ref: { backend: string; provider: string; model: string }): string {
  return `${ref.backend} › ${ref.provider} › ${ref.model}`;
}

/**
 * **いまの値が一覧に無ければ足す**（I2：画面と実態を食い違わせない）。
 *
 * 供給に聞いた一覧は「いま選べるもの」で、**いま効いているもの**とは限らない
 * ——実機では番頭が `claude/opus` なのに、聞いた一覧には `opus[1m]` しか無かった。
 * 黙って先頭の項目が選ばれているように見せると、開いただけで別のモデルに見える。
 */
function withCurrent(
  options: Array<{ value: string; label: string }>,
  current: string
): Array<{ value: string; label: string }> {
  if (current === "" || options.some((o) => o.value === current)) return options;
  const [backend, provider, model] = current.split("|");
  return [
    {
      value: current,
      label: `${backend} › ${provider} › ${model}（いま効いている・一覧にはまだ出ていない）`,
    },
    ...options,
  ];
}

export interface CoreSettingsOptions {
  /**
   * **番頭が使うモデルの選択肢**（PO裁定 2026-08-13）。
   * 会話の画面と同じ「バックエンド → プロバイダ → モデル」を、`backend|provider|model`
   * の値で返す。**選択肢を2箇所で組まない**（D3）ので、bin.ts が1つの元から作る。
   */
  harnessChoices?: () => Array<{ value: string; label: string }>;
  /** 場所が変わったときに呼ぶ（その場で効かせるため）。 */
  onPlacesChanged?: () => void;
  /**
   * **いま効いている場所**を返す（設定と起動時指定のどちらが勝つか、既定の場所があるか、
   * を解いた後のもの）。画面はこれをそのまま映す。
   *
   * これが無いと、起動時の指定（`BANTO_PLACES`）で動いているとき画面が空に見えたり、
   * 既定の書斎が出ないまま効いていたりする（I2：画面と実態を食い違わせない）。
   * **判断をここで再現しない**——両側に置くと、片方を直したときもう片方が古いまま残る。
   */
  effectivePlaces?: () => PlaceSetting[];
  /** LLM の区画を出すためのカタログ。渡さなければ区画ごと出ない。 */
  llmCatalog?: LlmCatalog;
  /** 職人の既定 tier が変わったときに Worker Pool へ伝える口。 */
  onWorkerTierChanged?: (tier: ModelTier) => void;
  /**
   * **職人に選べるモデル**（ADR-0021 決定102）。番頭と同じ3段だが、**層が違うので別に聞く**
   * ——番頭の pi ハーネスと職人の pi ドライバは別物で、片方だけ使える構成がありうる（決定100）。
   */
  workerChoices?: () => Array<{ value: string; label: string }>;
  /** いま効いている職人の既定等級（画面に映す）。 */
  workerDefaultTier?: () => string;
  /**
   * **章の要約に実際に使われているモデル**（task-0151・a3）。保存した指定と、
   * 環境変数・既定への落ちを解いた後のもの。画面はこれをそのまま映す
   * ——「保存した値」と「実際に効いているもの」が食い違いうる（BANTO_CHAPTER_MODEL が
   * 優先するため）ので、判断をここで再現せず呼び手からもらう。
   */
  effectiveChapterModel?: () => ChapterModelResolution;
  /**
   * 「役割とモデル」統合表に参加するモジュールの役（`modelRoles` 宣言）の供給元
   * （2026-08-19 提案 `model-roles-module-offer`・ADR-0021 の続き）。
   *
   * 各モジュールの `settings` 契約（`read()` / `write()`）をそのまま使い、核は表の組み立てに
   * 集約するだけ（D3：保存しない・実効は導出）。宣言の無いモジュールは統合表に出ない。
   * 保存は各モジュールが自分で持つ（依存の逆転を避ける・決定99a）。
   */
  modelRoleSources?: () => Array<{
    /** モジュール名（例 "kobo"）。role の id 空間を分けるための接頭辞に使う。 */
    origin: string;
    /** 表示名（例 "工場"）。 */
    originTitle: string;
    spec: ModuleSettingsSpec;
  }>;
}

/**
 * @param store 設定の保存先
 */
export function createCoreSettingsSections(
  store: SettingsStore,
  options: CoreSettingsOptions = {}
): Array<{ id: string; spec: ModuleSettingsSpec }> {
  return [
    {
      id: "places",
      spec: {
        title: "場所と書き込み許可",
        description:
          "番頭が作業できる場所と、書き込みを許す範囲。既定はどの場所も読み取り専用で、" +
          "ここで許した範囲だけ書ける（決定38）。ghq / gwq が見つけるリポジトリは自動で" +
          "読み取り専用の場所になるので、場所の一覧に書くのは「明示的に足したい場所」だけ。",
        // 決定75: 場所と、そこで書ける範囲は**同じ1つの設定**。項目の宣言だけでは
        // 「保留中の要求を許す」「全場所共通で許す」が表せないので、専用の面を宣言する
        // （決定43 の枠。中核の区画にだけ許した例外）
        view: "PlaceSettings",
        fields: [
          {
            key: "places",
            label: "場所の一覧",
            type: "list",
            placeholder: "banto:/home/ubuntu/ghq/github.com/tjst-t/banto:docs/**,work/**",
            description:
              "1件1行。`id:/絶対パス` で読み取り専用、`id:/絶対パス:glob,glob` で" +
              "その範囲だけ書き込み可。`.git/` と Banto のデータ置き場はどう書いても書けない。" +
              "まだ保存していないときは**起動時の指定（BANTO_PLACES）がそのまま出る**ので、" +
              "保存するとその内容が設定として残る。" +
              "`desk`（成果物の置き場所）は**既定で必ずある**——行を書き換えれば場所も" +
              "書き込み範囲も変えられ、消しても既定（`~/banto-desk`）に戻る",
          },
        ],
        read: () => {
          // **いま効いている場所をそのまま出す**（画面と実態を食い違わせない）。
          // 「設定と起動時指定のどちらが効くか」「既定の場所があるか」の判断は呼び手が
          // 持っている——ここで再現すると、片方を直したときにもう片方が古いまま残る
          const effective = options.effectivePlaces?.() ?? store.all().places ?? [];
          return { places: placesToLines(effective) };
        },
        write: (values) => {
          const lines = Array.isArray(values["places"]) ? values["places"] : [];
          store.update("places", linesToPlaces(lines));
          options.onPlacesChanged?.();
          // 場所は毎回帳簿に聞き直す（D3）ので、その場で効く
          return { applied: true, message: "場所を変えました（すぐ効きます）。" };
        },
      },
    },
    {
      id: "network",
      spec: {
        title: "接続と公開",
        description:
          "**Banto は認証を持たない**（決定40）。外に出すなら前段（Caddy 等）で守ること。" +
          "既定では localhost だけを待ち受けるので、前段を素通りされることはない。",
        fields: [
          {
            key: "port",
            label: "待ち受けるポート",
            type: "number",
            placeholder: "4100",
            description: "既定 4100。WebUI（開発サーバ）もここへ中継するので、変えたら両方を直す",
            restartRequired: true,
          },
          {
            key: "bind",
            label: "待ち受けるアドレス",
            type: "text",
            placeholder: "127.0.0.1",
            description:
              "既定は 127.0.0.1（localhost のみ）。広げると、前段で守られていない経路から" +
              "記憶・書き込み・検証環境の credentials 経路に直接届く",
            restartRequired: true,
          },
          {
            key: "publicUrl",
            label: "外から見えるURL",
            type: "text",
            placeholder: "https://banto.example.com",
            description: "検証環境を外から見せるときのリンクの土台。省略すると相対パスになる",
            restartRequired: true,
          },
          {
            key: "caddyAdmin",
            label: "Caddy の admin API",
            type: "text",
            placeholder: "http://localhost:2019",
            description:
              "設定すると検証環境をサブドメインで公開する（決定39c）。" +
              "**下の土台ドメインと対で設定する**——片方だけだと起動時に止まる",
            restartRequired: true,
          },
          {
            key: "envDomain",
            label: "検証環境の土台ドメイン",
            type: "text",
            placeholder: "env.example.com",
            description: "`*.この名前` の DNS と証明書が用意されている前提",
            restartRequired: true,
          },
        ],
        read: () => ({ ...(store.all().network ?? {}) }),
        write: (values) => {
          const current = store.all().network ?? {};
          const port = values["port"];
          // I2: ポートでない値を黙って既定に落とさない（起動して初めて分かるのを避ける）
          if (port !== undefined && port !== null && port !== "") {
            const parsed = Number(port);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
              throw new Error(`ポートは1〜65535の整数で指定してください（受け取った値: ${String(port)}）`);
            }
          }
          const next = { ...current, ...values } as NonNullable<
            ReturnType<SettingsStore["all"]>["network"]
          >;
          // I2: 片方だけの設定を保存させない。起動して初めて止まるより、ここで断る
          if ((next.caddyAdmin && !next.envDomain) || (!next.caddyAdmin && next.envDomain)) {
            throw new Error("Caddy の admin API と土台ドメインは対で設定してください。");
          }
          store.update("network", next);
          return { applied: false, message: "保存しました。**次の起動から効きます**" };
        },
      },
    },
    {
      id: "roles",
      spec: {
        title: "役割とモデル",
        description:
          "誰が何のモデルを使うかを1枚で見える化します。いま効いているものと、その出所" +
          "（等級既定／工場などモジュールの上書き）を併記します。" +
          "等級既定はここで、モジュールの上書きはそのモジュールの区画で編集できます。" +
          "**優先順位：①上書き（名指し） ②等級既定 ③バックエンド既定**。" +
          "モデルそのものの登録（プロバイダ・鍵・取り込み）は「使えるモデル」の面で行います。",
        fields: async () => {
          const coreFields: SettingField[] = [
            {
              key: "steward",
              label: "番頭",
              type: "select",
              options: withCurrent(
                options.harnessChoices?.() ?? [],
                refValue(options.llmCatalog?.roles().steward)
              ),
              description: "新しい会話の既定。会話ごとの切り替えは会話の画面で",
            },
            {
              key: "defaultTier",
              label: "職人の既定の等級",
              type: "select",
              options: [
                { value: "", label: "（指定なし）" },
                ...MODEL_TIERS.map((t) => ({ value: t, label: TIER_LABELS[t] })),
              ],
              description: "頼む側が等級を言わなかったときに使う（等級既定の既定）",
            },
            ...MODEL_TIERS.map(
              (tier): SettingField => ({
                key: `worker.${tier}`,
                label: `職人（${TIER_LABELS[tier]}）`,
                type: "select",
                options: withCurrent(
                  [{ value: "", label: "（割り当てなし）" }, ...(options.workerChoices?.() ?? [])],
                  refValue(options.llmCatalog?.roles()[workerRoleOf(tier)])
                ),
                description: `${TIER_LABELS[tier]}で頼まれたときに使うモデル（等級既定）`,
              })
            ),
          ];

          // 各モジュールが modelRoles で宣言した役（Kobo は executor / rework / audit）
          const moduleFields: SettingField[] = [];
          for (const source of options.modelRoleSources?.() ?? []) {
            let values: Record<string, unknown> = {};
            try {
              values = await source.spec.read();
            } catch {
              // 読めないモジュールは飛ばすが黙らない（I2：値の捏造はしない）。1件で表全体を壊さない
            }
            for (const role of source.spec.modelRoles ?? []) {
              const current = String(values[role.key] ?? "");
              const currentLabel =
                current === "" ? "（なし → 等級既定に従う）" : current.replace(/\|/g, " › ");
              moduleFields.push({
                key: `${source.origin}:${role.id}`,
                label: `${source.originTitle}・${role.label}`,
                type: "select",
                options: withCurrent(
                  [
                    { value: "", label: "（割り当てなし・等級既定に従う）" },
                    ...(options.workerChoices?.() ?? []),
                  ],
                  current
                ),
                description:
                  (role.tierDependent
                    ? `${role.label}の上書き（名指し）。無ければそのタスクの等級の既定。`
                    : `${role.label}の上書き（名指し）。`) +
                  ` いま効いている: ${currentLabel}`,
              });
            }
          }

          return [...coreFields, ...moduleFields];
        },
        read: async () => {
          const roles = options.llmCatalog?.roles() ?? {};
          const asValue = (r?: { backend?: string; provider: string; model: string }): string =>
            r ? `${r.backend ?? "pi"}|${r.provider}|${r.model}` : "";
          const out: Record<string, unknown> = {
            steward: asValue(roles.steward),
            defaultTier: options.workerDefaultTier?.() ?? "",
            ...Object.fromEntries(
              MODEL_TIERS.map((t) => [`worker.${t}`, asValue(roles[workerRoleOf(t)])])
            ),
          };
          for (const source of options.modelRoleSources?.() ?? []) {
            try {
              const values = await source.spec.read();
              for (const role of source.spec.modelRoles ?? []) {
                out[`${source.origin}:${role.id}`] = String(values[role.key] ?? "");
              }
            } catch {
              // 読み込めないモジュールの役は空（I2：値を捏造しない）
            }
          }
          return out;
        },
        write: async (values) => {
          const applied: string[] = [];
          for (const [key, raw] of Object.entries(values)) {
            // モジュール役（origin:role.id）。それぞれのモジュールの settings.write へ委譲（決定27）
            const sep = key.split(":");
            if (sep.length === 2 && options.modelRoleSources) {
              const source = options.modelRoleSources().find((s) => s.origin === sep[0]);
              const role = source?.spec.modelRoles?.find((r) => r.id === sep[1]);
              if (source && role) {
                await source.spec.write({ [role.key]: String(raw ?? "") });
                applied.push(
                  `${source.originTitle}・${role.label} → ${String(raw ?? "") || "割り当てなし"}`
                );
                continue;
              }
            }
            if (key === "defaultTier") {
              const tier = String(raw ?? "");
              if (tier && !MODEL_TIERS.includes(tier as ModelTier)) {
                throw new Error(`知らない等級です: ${tier}`);
              }
              if (tier) {
                options.onWorkerTierChanged?.(tier as ModelTier);
                applied.push(`既定の等級を ${TIER_LABELS[tier as ModelTier]} に`);
              }
              continue;
            }
            const role = key === "steward" ? "steward" : key;
            const text = String(raw ?? "");
            if (text === "") {
              options.llmCatalog?.clearRole(role as never);
              applied.push(`${role} の割り当てを外しました`);
              continue;
            }
            const [backend, provider, model] = text.split("|");
            // I2: 壊れた値を黙って既定に落とさない
            if (!backend || !provider || !model) {
              throw new Error(`モデルの指定が不正です: ${text}`);
            }
            options.llmCatalog?.setRole(role as never, provider, model, backend);
            applied.push(`${role} → ${backend}/${provider}/${model}`);
          }
          return {
            applied: true,
            message:
              `${applied.join("、")}。\n\n` +
              "**優先順位：①上書き（名指し） ②等級既定 ③バックエンド既定**\n" +
              "番頭は新しい会話から、職人は次の委譲から効きます。",
          };
        },
      } as ModuleSettingsSpec,
    },
    {
      id: "chapterModel",
      spec: {
        title: "章の要約に使うモデル",
        description:
          "会話が長くなったとき、引き継ぎ資料を書くために使うモデルです（本編とは別の呼び出し・" +
          "決定28）。会話のモデルとは独立に選べます——安いモデルで足ります。" +
          "未指定なら既定（claude-agent-sdk の haiku）を使います。" +
          "環境変数 BANTO_CHAPTER_MODEL が設定されている間は、そちらがここより優先されます（互換のため）。",
        fields: () => [
          {
            key: "chapterModel",
            label: "要約モデル",
            type: "select",
            get options() {
              return withCurrent(options.harnessChoices?.() ?? [], store.all().chapterModel ?? "");
            },
            description: (() => {
              const effective = options.effectiveChapterModel?.();
              if (!effective) return "";
              const label = refLabel(effective.ref);
              if (effective.source === "env") {
                return `いま実際に使われているのは ${label}（環境変数 BANTO_CHAPTER_MODEL）です。`;
              }
              const fallbackNote = effective.fallback
                ? `指定（${
                    "raw" in effective.fallback.requested
                      ? effective.fallback.requested.raw
                      : refLabel(effective.fallback.requested)
                  }）を解決できず、既定へ落としています（${effective.fallback.reason}）。`
                : "";
              return `${fallbackNote}いま実際に使われているのは ${label} です。`;
            })(),
          },
        ],
        read: () => ({ chapterModel: store.all().chapterModel ?? "" }),
        write: (values) => {
          const raw = values["chapterModel"];
          const text = String(raw ?? "");
          if (text === "") {
            store.update("chapterModel", undefined);
            return {
              applied: false,
              message: "章の要約モデルの指定を外しました。次の会話から既定を使います。",
            };
          }
          const [backend, provider, model] = text.split("|");
          // I2: 壊れた値を黙って既定に落とさない
          if (!backend || !provider || !model) {
            throw new Error(`モデルの指定が不正です: ${text}`);
          }
          store.update("chapterModel", text);
          return {
            applied: false,
            message:
              `保存しました（${backend}/${provider}/${model}）。次の会話から効きます` +
              "（いま開いている会話は、次に章を畳むときから）。",
          };
        },
      } as ModuleSettingsSpec,
    },
    // ADR-0011 決定42・43: LLM は中核。項目では表しきれないので専用の面を宣言する
    ...(options.llmCatalog
      ? [
          {
            id: "llm",
            spec: {
              title: "使えるモデル（pi の供給）",
              description:
                "ここは pi バックエンドの供給の面です——プロバイダの登録・鍵・取り込み・" +
                "文脈長・等級と、この店で使う気があるか（採用）まで。" +
                "誰がどれを使うかは「役ごとのモデル」で決めます" +
                "（Claude Code のモデルも含めてバックエンドを跨いで1枚）。" +
                "会話ごとの切り替えは会話の画面から。",
              // 項目の宣言では表せないため、描き先だけを宣言する（決定43）
              view: "LlmRegistryViewer",
              fields: [],
              read: () => ({}),
              write: () => ({ applied: true }),
            } as ModuleSettingsSpec,
          },
        ]
      : []),
  ];
}
