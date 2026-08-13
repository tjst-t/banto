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
import type { LlmCatalog, ModelTier, ModuleSettingsSpec } from "@banto/core";
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
        title: "役ごとのモデル",
        description:
          "**誰が何を使うか**を決める1枚（ADR-0021 決定102）。選ぶのは「バックエンド → " +
          "プロバイダ → モデル」の3段で、**同じ `opus` が pi 経由でも Claude Code 経由でも**" +
          "指せる。\n\n" +
          "- **番頭**：ここで決めるのは**新しい会話がどれで始まるか**だけ。" +
          "いま開いている会話は、会話の画面のモデル選択でその場で変えられる（再起動は要らない）\n" +
          "- **職人**：等級ごとの既定。**頼む側が名指しすれば、そちらが優先される**" +
          "（Kobo の実装・レビューは自分で持っている・決定99a）\n" +
          "- モデルそのものの登録（プロバイダ・鍵・取り込み）は「LLM・モデル（pi の供給）」で",
        fields: [
          {
            key: "steward",
            label: "番頭",
            type: "select",
            get options() {
              return options.harnessChoices?.() ?? [];
            },
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
            description: "頼む側が等級を言わなかったときに使う",
          },
          ...MODEL_TIERS.map((tier) => ({
            key: `worker.${tier}`,
            label: `職人（${TIER_LABELS[tier]}）`,
            type: "select" as const,
            get options() {
              return [{ value: "", label: "（割り当てなし）" }, ...(options.workerChoices?.() ?? [])];
            },
            description: `${TIER_LABELS[tier]}で頼まれたときに使うモデル`,
          })),
        ],
        read: () => {
          const roles = options.llmCatalog?.roles() ?? {};
          const asValue = (r?: { backend?: string; provider: string; model: string }): string =>
            r ? `${r.backend ?? "pi"}|${r.provider}|${r.model}` : "";
          return {
            steward: asValue(roles.steward),
            defaultTier: options.workerDefaultTier?.() ?? "",
            ...Object.fromEntries(
              MODEL_TIERS.map((t) => [`worker.${t}`, asValue(roles[workerRoleOf(t)])])
            ),
          };
        },
        write: (values) => {
          const applied: string[] = [];
          for (const [key, raw] of Object.entries(values)) {
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
              "**番頭は新しい会話から**効きます（いま開いている会話は会話の画面で）。" +
              "**職人は次の委譲から**効きます。",
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
              title: "使えるモデル（登録と採用）",
              description:
                "**ここは「何が在るか」と「使ってよいか」だけ**（カタログと採用）。" +
                "誰がどれを使うかは別の面で決める——番頭は「番頭が使うモデル」、" +
                "職人は「職人」。会話ごとの切り替えは会話の画面から。",
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
