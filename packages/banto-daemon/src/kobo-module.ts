/**
 * Kobo のモジュール定義（ADR-0010 決定25・27b、task-0048／0064）。
 *
 * **Kobo は独立プロセス**（PO裁定 2026-07-28）。だから他のモジュールと違い、番頭ホストに
 * 載るのは実装ではなく**到達先**で、Tool は `{baseUrl}/tools/{名前}` を叩く写しになる。
 * 契約（名前・説明・引数）は Kobo 側の定義から**そのまま持ってくる**——2箇所で書くと、
 * 番頭が読む説明と実際の振る舞いが静かにずれる。
 *
 * このファイルは banto-host に依存しない（Worker Pool の `module.ts` と同じ理由）。
 * 構造的に一致する平たいオブジェクトを返す。
 */

import { Type } from "typebox";
import { createModuleClient, defineNamespacedTool } from "@banto/core";
import type { ModuleClient, NamespacedToolDefinition } from "@banto/core";
import { KOBO_MODULE_PATH } from "./http-server.js";
import type { Daemon } from "./daemon.js";
import { createKoboTools } from "./kobo-tools.js";
import { createKoboSettings } from "./kobo-settings.js";

/** モジュール名（Tool 名前空間のドメインでもある）。 */
export const KOBO_MODULE_NAME = "kobo";

/** 既定の到達先。独立プロセスなので絶対URL。 */
export function defaultKoboUrl(): string {
  return (
    process.env["BANTO_KOBO_URL"] ??
    `http://127.0.0.1:${process.env["BANTO_KOBO_PORT"] ?? "4500"}${KOBO_MODULE_PATH}`
  );
}

/** SKILL の置き場所（`packages/banto-daemon/skills`）。 */
export function koboSkillsDir(): string {
  return new URL("../skills", import.meta.url).pathname;
}

/**
 * 契約（名前・説明・引数）だけを取り出すための、実装を持たない Kobo。
 *
 * **触られたら投げる**——写しの `execute` は必ず差し替わるので、ここへ来たら配線の誤りである。
 * 契約を2箇所に書くより、実装だけを空にする方が「番頭が読む説明と実際の振る舞いがずれる」
 * 事故を構造的に防げる（I2: 黙って別物にならない）。
 */
function contractOnlyDaemon(): Daemon {
  return new Proxy({} as Daemon, {
    get(_target, prop) {
      throw new Error(
        `Kobo の写しは実装を持ちません（${String(prop)} が呼ばれました）。到達先へ HTTP で聞いてください。`
      );
    },
  });
}

/**
 * Kobo の Tool を**呼ぶだけ**の写しを作る。
 *
 * I2: 到達できないことを「結果なし」と混同しない——`ModuleClient` が理由を添えて投げる。
 */
export function createKoboProxyTools(
  specs: NamespacedToolDefinition[],
  client: ModuleClient
): NamespacedToolDefinition[] {
  return specs.map((spec) => ({
    ...spec,
    async execute(args: unknown) {
      const result = await client.invoke(
        KOBO_MODULE_NAME,
        spec.name,
        (args ?? {}) as Record<string, unknown>
      );
      return { content: result.content, ...(result.details ? { details: result.details } : {}) };
    },
  })) as NamespacedToolDefinition[];
}

/**
 * Kobo のモジュール定義を返す（番頭ホストが登録する）。
 *
 * **到達先が2つある。** Kobo は独立プロセスで、しかも 127.0.0.1 にしか出ていない（決定40）：
 *
 *   - `remoteUrl` — 番頭ホストのプロセスが Tool を呼ぶ先（絶対URL）
 *   - `endpoint.baseUrl` — **UI が見る先**（同一オリジンの相対パス）。ブラウザは別の機械で
 *     動くので Kobo へ直接は届かない。ホストが自分の面に生やして中継する（決定25・39b と
 *     同じ形——Banto をブローカーにしないのは**モジュール間**の話で、UI の経路は別）
 *
 * @param remoteUrl Kobo への到達先（既定は `BANTO_KOBO_URL`）
 * @param fetchImpl テストで差し替える口
 */
export function createKoboModule(
  remoteUrl: string = defaultKoboUrl(),
  fetchImpl: typeof fetch = fetch
): {
  name: string;
  title: string;
  description: string;
  endpoint: { baseUrl: string };
  tools: NamespacedToolDefinition[];
  views: Array<{
    kind: string;
    title: string;
    description: string;
    parameters: ReturnType<typeof Type.Object>;
    component: string;
    category?: string;
    icon?: string;
  }>;
  skills: Array<{ name: string; description: string; filePath: string }>;
  /**
   * 設定の区画（決定41）。**契約（項目の宣言）だけ**をここで持ち、読み書きは
   * 番頭ホストが `createRemoteSettings` で HTTP へ差し替える（Worker Pool と同じ形）。
   */
  settings: import("@banto/core").ModuleSettingsSpec;
} {
  const client = createModuleClient(
    { modules: { [KOBO_MODULE_NAME]: { baseUrl: remoteUrl } } },
    fetchImpl
  );
  // 契約は Kobo 側の定義そのもの。`execute` だけを HTTP 越しに差し替える
  const specs = createKoboTools(contractOnlyDaemon());
  // 項目の宣言は静的（写しには触らない）。読み書きだけが到達先へ行く
  const settings = createKoboSettings(contractOnlyDaemon());

  return {
    name: KOBO_MODULE_NAME,
    title: "工場",
    description:
      "タスクを積むと、依存ゲート・職人の差配・監査・直列マージまでを自動で運ぶ統治基盤。" +
      "コードを変える仕事はここへ積む（決定62a）。",
    // UI から見える先。ホストが `/api/kobo/tools/*` を受けて写しを実行し、Kobo へ中継する
    endpoint: { baseUrl: KOBO_MODULE_PATH },
    tools: createKoboProxyTools(specs, client),
    settings,
    views: [
      {
        kind: "kobo.board",
        title: "工場",
        description:
          "タスクの状態機械のビューア。いま何が動いていて、何が待っていて、何で止まっているかを" +
          "一目で見せたいときに開く。かんばんの Now / Next / Later は状態の集約であって別の状態ではない。",
        parameters: Type.Object({
          projectTag: Type.Optional(Type.String({ description: "最初に選ぶプロジェクト" })),
          taskId: Type.Optional(Type.String({ description: "最初に開くタスク" })),
        }),
        component: "KoboBoard",
        category: "kobo",
        icon: "🏭",
      },
      {
        kind: "kobo.review",
        title: "レビュー",
        description:
          "判断待ちのタスクを見て決める面（決定57・59）。経緯・変更の範囲・受け入れ基準・" +
          "監査の判定が並び、**触れる環境があれば開ける**。PO の判断が要るものはその旨が出る。",
        parameters: Type.Object({
          projectTag: Type.Optional(Type.String({ description: "最初に選ぶプロジェクト" })),
          taskId: Type.Optional(Type.String({ description: "最初に開くタスク" })),
        }),
        component: "KoboReview",
        category: "kobo",
        icon: "⚖️",
      },
    ],
    // SKILL は決定26 の第2層（モジュールが出す既定）。**3本に分けてある**——
    // 積む／捌く／載せるは使う場面が違い、1本にすると読む側が自分に関係ない節を跨ぐ
    skills: [
      {
        name: "kobo-enqueue",
        description:
          "工場（Kobo）へ仕事を積むときの手順。何をタスクにし、定義に何を書き、" +
          "積んだあと何が返ってくるか。コードを変える依頼を受けたときに使う。",
        filePath: `${koboSkillsDir()}/kobo-enqueue/SKILL.md`,
      },
      {
        name: "kobo-review",
        description:
          "工場から返ってきた判断待ちを捌く手順。通すか、取次でPOへ上げるか。" +
          "「レビュー待ちです」という知らせが会話に届いたとき、" +
          "および kobo.list に判断待ちが溜まっているときに使う。",
        filePath: `${koboSkillsDir()}/kobo-review/SKILL.md`,
      },
      {
        name: "kobo-onboarding",
        description:
          "既にあるリポジトリを工場（Kobo）に載せる手順。プロジェクトの登録・タスクの置き場・" +
          "層B設定・書き込みの許可・最初の1本の通し方。POから「このリポジトリも Kobo で" +
          "開発したい」と言われたとき、および新しいプロジェクトを受け持つときに使う。",
        filePath: `${koboSkillsDir()}/kobo-onboarding/SKILL.md`,
      },
    ],
  };
}
