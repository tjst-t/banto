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
      id: "harness",
      spec: {
        title: "番頭が使うモデル（新しい会話の既定）",
        description:
          "**会話ごとの切り替えは、会話の画面のモデル選択でできる**（再起動は要らない）。" +
          "ここで決めるのは**新しい会話がどれで始まるか**だけ。\n\n" +
          "選ぶのは「バックエンド → プロバイダ → モデル」の1つ——同じ `opus` が pi" +
          "（opencode zen 経由）でも Claude Code 経由でも指せるので、**どの経路で呼ぶか**まで含めて選ぶ。",
        fields: [
          {
            key: "steward",
            label: "番頭が使うモデル",
            type: "select",
            /**
             * **開くたびに引き直す**（決定98d）。区画は起動時に1回だけ組まれるので、
             * ここで配列にして持つと**選択肢が起動時のまま凍る**——モデルを採用しても
             * 出てこないし、バックエンドへの問い合わせ（1秒後に返る）も反映されない。
             */
            get options() {
              return options.harnessChoices?.() ?? [];
            },
            description: "会話の画面と同じ選択肢。ここは新しい会話の既定だけを決める",
          },
        ],
        read: () => {
          const steward = options.llmCatalog?.roles().steward;
          return {
            steward: steward
              ? `${steward.backend ?? "pi"}|${steward.provider}|${steward.model}`
              : "",
          };
        },
        write: (values) => {
          const raw = String(values["steward"] ?? "");
          const [backend, provider, model] = raw.split("|");
          // I2: 壊れた値を黙って既定に落とさない
          if (!backend || !provider || !model) {
            throw new Error(`モデルの指定が不正です: ${raw}`);
          }
          options.llmCatalog?.setRole("steward", provider, model, backend);
          return {
            applied: true,
            message:
              "**新しい会話からこれで始まります**" +
              "（いま開いている会話は、会話の画面のモデル選択でその場で変えられます）。",
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
