/**
 * Banto 中核が設定画面に出す区画（決定41・task-0047）。
 *
 * モジュールと**同じ契約で自分の分も出す**——中核だけ特別扱いにすると、設定画面が
 * 「中核用の描画」と「モジュール用の描画」を2つ持つことになる。
 *
 * ここが持つのは、モジュールに属さないもの：LLM・場所・接続。
 */

import type { ModuleSettingsSpec } from "@banto/core";
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
  /** 場所が変わったときに呼ぶ（その場で効かせるため）。 */
  onPlacesChanged?: () => void;
  /**
   * 設定に場所が保存されていないときに、**いま効いている場所**を返す。
   *
   * これが無いと、起動時の指定（`BANTO_PLACES`）で動いているとき画面が空に見える
   * ——実際には効いているのに「1件も無い」と読めてしまう（I2：画面と実態を食い違わせない）。
   */
  effectivePlaces?: () => PlaceSetting[];
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
      id: "llm",
      spec: {
        title: "LLM",
        description:
          "番頭が使うモデル。プロバイダは pi の設定（~/.pi/agent/auth.json）で認証しておくこと。",
        fields: [
          {
            key: "provider",
            label: "プロバイダ",
            type: "text",
            placeholder: "opencode / anthropic など",
            description: "pi が知っているプロバイダ名。認証はプロバイダ側の設定に従う",
            restartRequired: true,
          },
          {
            key: "model",
            label: "モデル",
            type: "text",
            placeholder: "deepseek-v4-flash-free など",
            description:
              "pi の台帳に無いモデル id も使える（同じプロバイダの設定を土台にする）。" +
              "プロバイダ名が台帳に無い場合は起動時に止まる",
            restartRequired: true,
          },
        ],
        read: () => ({ ...(store.all().llm ?? {}) }),
        write: (values) => {
          const current = store.all().llm ?? {};
          store.update("llm", { ...current, ...(values as { provider?: string; model?: string }) });
          return {
            applied: false,
            message: "保存しました。**次の起動から効きます**（会話中のセッションは作り直せません）",
          };
        },
      },
    },
    {
      id: "places",
      spec: {
        title: "場所",
        description:
          "番頭が作業できる場所と、書き込みを許す範囲。既定はどの場所も読み取り専用で、" +
          "ここで許した範囲だけ書ける（決定38）。ghq / gwq が見つけるリポジトリは自動で" +
          "読み取り専用の場所になるので、ここに書くのは「明示的に足したい場所」だけ。",
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
              "保存するとその内容が設定として残る",
          },
        ],
        read: () => {
          // 保存が無ければ、いま効いている場所を出す（画面と実態を食い違わせない）
          const saved = store.all().places;
          const effective = saved && saved.length > 0 ? saved : (options.effectivePlaces?.() ?? []);
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
  ];
}
