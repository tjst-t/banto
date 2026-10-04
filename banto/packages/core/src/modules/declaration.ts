// Module の宣言（決定・2026-09-06、Phase 1「契約が確定し、その契約で3つ書けた」）。
//
// **どの Module を、どう起動するかは、コードではなく宣言で決める。**
// 以前は cli.ts に「vault の dist パス直書き」「`"shell" | "filesystem"` の
// リテラル union」「node で dist/server.js を実行する形」が埋まっており、
// 4本目を足すには本体を書き換えてビルドし直す必要があった——
// TypeScript でない Module（Python）は、そもそもこの形では表現できなかった。
//
// 決めたこと（未決 modules item 9 の決着）：
// **受け入れる起動の形は「このプログラムを、この引数で、この環境変数で」1種類だけ。**
// パッケージ名からの解決・自動インストール・レジストリ取得は入れない（規則10）
// ——いま要るのは「もうそこにあるものを起動する」だけで、それ以上は必要になってから足す。
// この1種類で Python も Ruby も Go も同じ書き方で載る。
//
// 置き場は Configuration（Event Store）——Module 集合は Project 単位（§2.2）で、
// instance 既定＋Project 上書きの仕組みが既にある。新しい置き場を発明しない（規則12）。

import {
  assertRolesAllowed,
  markBundled,
  parseModuleMeta,
  SINGLETON_ROLES,
  type BantoModuleMeta,
} from "@banto/module-contract";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { applyModuleOverlay, diffFromDefaults, type ModuleOverlay } from "./overlay.js";

export class ModuleDeclarationError extends Error {}

/** **プロセスをこちらで立てる形**（決定・2026-09-06）。 */
export interface StdioLaunch {
  type?: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * **URL に繋ぐ形**（決定・2026-09-17、ユーザー指示）。
 *
 * プロセスがこちらに無いので、**閉じ込めは効かない**——Landlock は自分が起こした
 * プロセスにしか掛からない。代わりに効くのは「**呼ぶたびに引数が相手へ出ていく**」
 * という別の性質で、そこは人の明示の承認と監査で守る
 * （`docs/specs/v4-security.md`「Module が machine の外へデータを出す」）。
 *
 * **差し込めるのは `${secret:…}` だけ**（`headers` の値のみ）。banto の内部の値
 * （中継の合言葉・置き場のパス）を外へ送る道を作らない。
 */
export interface RemoteLaunch {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type ModuleLaunch = StdioLaunch | RemoteLaunch;

/** URL に繋ぐ形か。**判定は1箇所**（規則3——`type` の文字列を散らさない）。 */
export function isRemoteLaunch(launch: ModuleLaunch): launch is RemoteLaunch {
  return launch.type === "http";
}

/**
 * **その Module がどこで動くか**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。
 *
 * - Project の Module → その Project のコンテナ
 * - 外から足した banto 全体の Module → banto 全体用のコンテナ
 * - 同梱の banto 全体の Module → banto 本体（banto 本体で動くのは banto 自身のコードだけ）
 * - URL に繋ぐ形 → こちらにプロセスが無い
 *
 * 起こす処理と画面の両方がここから引く（規則3——宣言の `confinement` からは導かない）。
 */
export type ModulePlacement = "project-container" | "instance-container" | "host" | "remote";

export function modulePlacement(meta: BantoModuleMeta, launch: ModuleLaunch): ModulePlacement {
  if (isRemoteLaunch(launch)) return "remote";
  if (meta.scope === "project") return "project-container";
  return meta.origin === "bundled" ? "host" : "instance-container";
}

export interface ModuleDeclaration {
  /** 一覧の中で一意。Runner から見える名前（`mcp__<name>__…`）でもある。 */
  name: string;
  launch: ModuleLaunch;
  /** `@banto/module-contract` の語彙をそのまま使う（独自の形を作らない）。 */
  meta: unknown;
}

export interface ParsedModuleDeclaration {
  name: string;
  launch: ModuleLaunch;
  meta: BantoModuleMeta;
}

/**
 * 起動の直前に実際の値へ置き換わる差し込み語。
 * **ここに無い語を書いたら、起動する前に落とす**（規則2——黙って空文字で起動しない）。
 */
export interface LaunchContext {
  nodeExec: string;
  monorepoRoot: string;
  dataDir: string;
  hostRelayUrl: string;
  hostRelayToken: string;
  /** その Module 自身の状態の置き場（決定・2026-09-07）。banto が Module ごとに
   *  用意し、閉じ込めていてもここだけは書ける——Project の中を汚さずに
   *  自分の設定を持てるようにするため。 */
  moduleDataDir: string;
  /**
   * **その Module のプログラムの置き場**（追加・2026-09-21、MCP Registry）。
   *
   * registry から取ってきた配布物はここに入る。`moduleDataDir`（状態）とは
   * **別に持つ**——起動時に渡す権限が違うため：ここは**読み取り専用**、
   * 状態の置き場は読み書き（`landlock/derive.ts` の作法）。同じ場所にすると、
   * 動いている Module が自分のプログラムを書き換えられてしまう。
   */
  modulePackageDir: string;
  /** Project 単位の Module だけが使える。 */
  projectRoot?: string;
}

const INSTANCE_PLACEHOLDERS = [
  "nodeExec",
  "monorepoRoot",
  "dataDir",
  "hostRelayUrl",
  "hostRelayToken",
  "moduleDataDir",
  "modulePackageDir",
] as const;
const PROJECT_ONLY_PLACEHOLDERS = ["projectRoot"] as const;

/**
 * **金庫から引く差し込み語**（決定・2026-09-16、ユーザー指示）。
 *
 * `mcpServers` の慣習は `env: { "API_KEY": "sk-…" }` だが、**banto の宣言は
 * Event Store に残る**ので、書いた瞬間に記録へ永久に残る。名前だけ書かせて、
 * **起動の直前に host が金庫から引いて差し込む**。
 *
 * **`env` の値でしか使えない。** `command` と `args` に書けてしまうと、
 * 展開後の値が argv に載って **`ps` に平文の秘密が出る**——`envSecrets` が
 * argv を避けるために設けた分離が崩れる（レビューで指摘・2026-09-15）。
 *
 * **2026-09-02 の決定（`"$my-alias"` の形）を置き換える**（規則8）。
 * 理由：`${secret:…}` は既にある差し込み語の検査（「知らない語は起動前に落とす」）
 * にそのまま乗るが、`$my-alias` はその検査を素通りする——書き間違いが
 * 「そういう値」として静かに渡ってしまう。
 * **「直書きも許す」はそのまま**（使い捨てトークンを直接書きたい場面は実在する）
 * ——ただし記録に残ることを画面で言う。
 */
const SECRET_PREFIX = "secret:";

const PLACEHOLDER_PATTERN = /\$\{([^}]*)\}/g;

function checkPlaceholders(
  text: string,
  scope: "instance" | "project",
  source: string,
  where: "env" | "command" = "env",
): void {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1] ?? "";
    if (key.startsWith(SECRET_PREFIX)) {
      // **env の値でしか使えない**——argv に載ると `ps` に平文が出る
      if (where !== "env") {
        // 宣言の読み取りで落とす——他の弾き方と同じ型にする（拾う側が1つで済む）
        throw new ModuleDeclarationError(
          `${source}: \${${key}} は環境変数の値にしか書けません` +
            "（コマンドや引数に書くと、動いている間 ps に秘密が見えてしまいます）",
        );
      }
      if (key.slice(SECRET_PREFIX.length).trim() === "") {
        throw new ModuleDeclarationError(`${source}: \${secret:…} に名前がありません`);
      }
      continue;
    }
    if ((INSTANCE_PLACEHOLDERS as readonly string[]).includes(key)) continue;
    if ((PROJECT_ONLY_PLACEHOLDERS as readonly string[]).includes(key)) {
      if (scope === "project") continue;
      throw new ModuleDeclarationError(
        `${source}: instance に1本の Module は \${${key}} を使えません（Project ごとの Module だけが使えます）`,
      );
    }
    throw new ModuleDeclarationError(`${source}: 知らない差し込み語 \${${key}} が書かれています`);
  }
}

/** その起動の指定に `${projectRoot}` が出てくるか。**URL に繋ぐ形には無い**。 */
function usesProjectRoot(launch: ModuleLaunch): boolean {
  if (isRemoteLaunch(launch)) return false;
  const texts = [launch.command, ...launch.args, ...Object.values(launch.env ?? {})];
  return texts.some((t) => /\$\{projectRoot\}/.test(t));
}

/** 起動の指定を読む。**形は2つ**——プロセスを立てるか、URL に繋ぐか。 */
function parseLaunch(launch: unknown, source: string): ModuleLaunch {
  const raw = launch as {
    type?: string;
    command?: unknown;
    args?: unknown;
    env?: Record<string, unknown>;
    url?: unknown;
    headers?: Record<string, unknown>;
  };
  // **`type` が無くても `url` があれば URL に繋ぐ形**（`mcpServers` の慣習と同じ）
  const kind = raw.type ?? (typeof raw.url === "string" ? "http" : "stdio");
  if (kind === "http") {
    if (typeof raw.url !== "string" || raw.url.trim() === "") {
      throw new ModuleDeclarationError(`${source}: launch.url が空です`);
    }
    let parsed: URL;
    try {
      parsed = new URL(raw.url);
    } catch {
      throw new ModuleDeclarationError(`${source}: launch.url が URL として読めません（${raw.url}）`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ModuleDeclarationError(`${source}: launch.url は http か https です（${parsed.protocol}）`);
    }
    const headers = raw.headers ?? undefined;
    if (headers !== undefined && (typeof headers !== "object" || headers === null)) {
      throw new ModuleDeclarationError(`${source}: launch.headers はオブジェクトです`);
    }
    if (Object.values(headers ?? {}).some((v) => typeof v !== "string")) {
      throw new ModuleDeclarationError(`${source}: launch.headers の値は文字列である必要があります`);
    }
    return { type: "http", url: raw.url, ...(headers ? { headers: headers as Record<string, string> } : {}) };
  }
  if (kind !== "stdio") {
    throw new ModuleDeclarationError(`${source}: 知らない繋ぎ方です（${String(kind)}）`);
  }
  const { command, args, env } = raw;
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new ModuleDeclarationError(`${source}: launch.command が空です`);
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new ModuleDeclarationError(`${source}: launch.args は文字列の配列である必要があります`);
  }
  if (Object.values(env ?? {}).some((v) => typeof v !== "string")) {
    throw new ModuleDeclarationError(`${source}: launch.env の値は文字列である必要があります`);
  }
  return { command, args: args as string[], env: (env ?? undefined) as Record<string, string> | undefined };
}

/** 差し込み語を1つも許さない場所（URL）。 */
function assertNoPlaceholder(text: string, source: string): void {
  const found = [...text.matchAll(PLACEHOLDER_PATTERN)][0];
  if (found) {
    throw new ModuleDeclarationError(
      `${source}: \${${found[1] ?? ""}} は書けません（URL に差し込むと、秘密が経路上の記録に残ります）`,
    );
  }
}

/** ヘッダの値。**`${secret:…}` だけ**——banto の内部の値を外へ送らせない。 */
function checkRemoteHeader(text: string, source: string): void {
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1] ?? "";
    if (!key.startsWith(SECRET_PREFIX)) {
      throw new ModuleDeclarationError(
        `${source}: \${${key}} は URL に繋ぐ形では書けません` +
          "（banto の内部の値を外へ送らないため）。使えるのは ${secret:名前} だけです",
      );
    }
    if (key.slice(SECRET_PREFIX.length).trim() === "") {
      throw new ModuleDeclarationError(`${source}: \${secret:…} に名前がありません`);
    }
  }
}

export function parseModuleDeclaration(raw: unknown, source: string): ParsedModuleDeclaration {
  if (typeof raw !== "object" || raw === null) {
    throw new ModuleDeclarationError(`${source}: Module の宣言はオブジェクトである必要があります`);
  }
  const { name, launch, meta } = raw as Partial<ModuleDeclaration>;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ModuleDeclarationError(`${source}: name が要ります`);
  }
  const parsedMeta = parseModuleMeta(meta, `${source}(${name})`);
  if (typeof launch !== "object" || launch === null) {
    throw new ModuleDeclarationError(`${source}(${name}): launch が要ります`);
  }
  const parsedLaunch = parseLaunch(launch, `${source}(${name})`);

  // **どこに立つかは、書いたものから導く**（決定・2026-09-15、レビューで発覚）。
  //
  // 以前は `scope` を meta の自己申告だけで決め、`${projectRoot}` との整合は
  // **片方向しか見ていなかった**（instance が書いたら落とす、だけ）。つまり
  // **「Project のフォルダを触るのに instance と名乗る」が素通り**していた
  // ——instance には閉じ込めを構造上かけられないので、これは
  // **閉じ込め無しの任意コードを選ぶ道**になっていた（`v4-security.md`）。
  //
  // `scope` を書いていなければ **`${projectRoot}` の有無から決める**。
  // 書いてあれば**整合を検査して、食い違ったら起動しない**（規則8——
  // 黙ってどちらかに寄せない）。
  // **書いていなければ、書いたものから決める。** 書いてあればそれに従う
  // ——`${projectRoot}` を使いながら instance と名乗る形は `checkPlaceholders`
  // が従来どおり弾く（下）。
  //
  // **逆向き（project と名乗って `${projectRoot}` を使わない）は許す**
  // （訂正・2026-09-15、試験が教えた）。**Project ごとに分けたい理由は
  // フォルダだけではない**——Project ごとに別の状態を持ちたい Module は、
  // 根を受け取らなくても分かれていてよい。
  //
  // したがって**この導出は画面の既定を決めるためのもので、安全のための柵ではない**。
  // 「Project のフォルダを歩くのに instance と名乗る」は導出では防げない
  // ——そこを守るのは閉じ込め（`cli.ts` の `assertConfinable`）。
  const declaredScope = (meta as { scope?: unknown } | undefined)?.scope;
  const metaWithScope =
    declaredScope === undefined && usesProjectRoot(parsedLaunch)
      ? { ...parsedMeta, scope: "project" as const }
      : parsedMeta;

  if (isRemoteLaunch(parsedLaunch)) {
    // **URL に繋ぐ形に、banto の内部の値を差し込ませない。** 使えるのは
    // `${secret:…}` だけで、置けるのは `headers` の値だけ——URL に置くと、
    // 秘密が経路上のログや代理サーバに残る
    assertNoPlaceholder(parsedLaunch.url, `${source}(${name}): url`);
    for (const [key, value] of Object.entries(parsedLaunch.headers ?? {})) {
      checkRemoteHeader(value, `${source}(${name}): headers.${key}`);
    }
    // **リモートは他の Module を呼べない**（決定・2026-09-17）。中継を呼ぶには
    // banto の合言葉が要るが、それを第三者のサーバに持たせない。**できない
    // ことを、宣言できてしまう形にしない**（規則13 の裏——書けるのに効かない）
    if (metaWithScope.dependsOn.length > 0) {
      throw new ModuleDeclarationError(
        `${source}(${name}): URL に繋ぐ形は他の Module を呼べません` +
          "（中継の合言葉を外へ渡さないため）。dependsOn は書けません",
      );
    }
    // **閉じ込めは効かない。** 書いてあったら黙って無視せず、そう言う（規則2）
    if (metaWithScope.confinement) {
      throw new ModuleDeclarationError(
        `${source}(${name}): URL に繋ぐ形には閉じ込めを掛けられません` +
          "（プロセスがこちらに無いため）。書かないでください",
      );
    }
  } else {
    for (const text of [parsedLaunch.command, ...parsedLaunch.args]) {
      checkPlaceholders(text, metaWithScope.scope, `${source}(${name})`, "command");
    }
    for (const value of Object.values(parsedLaunch.env ?? {})) {
      checkPlaceholders(value, metaWithScope.scope, `${source}(${name})`, "env");
    }
  }

  // **同梱かどうかは、ここで決まる**（parse の中に置く・2026-09-15）。
  // 読み込みのときだけ判定すると、**保存のときは素通りする**——壊れた宣言を
  // Event Store に残さない（規則2）ためには、入口が1つでなければならない
  return { name, launch: parsedLaunch, meta: withOrigin(name, parsedLaunch, metaWithScope, source) };
}

/**
 * **同梱だが、既定では入れない実装**（追加・2026-09-20、ユーザー決定）。
 *
 * `vault-infisical` は banto のコードだが、**誰もが使うものではない**
 * ——Infisical を立てている人だけが要る。既定に入れておくと、使わない人の
 * 設定画面に未設定の行が常に1本出るし、**要る人は1本しか持てない**
 * （接続先ごとに1本要るのに、既定はコードにあるので増やせない）。
 *
 * **要る人が「Module を追加」から、好きな名前で何本でも入れる。** 写すのは host
 * なので、画面は目録の id と新しい名前しか送らない——画面に `satisfies` を
 * 組み立てさせると「役割を自由に入力できる欄」が生まれ、貼り付けた JSON が
 * 金庫の窓口を名乗る経路が復活する（`v4-security.md`「役割のなりすまし」）。
 */
export interface BundledCatalogEntry {
  id: string;
  /** 一覧に出す名前 */
  name: string;
  /** 何をするものか（1行） */
  description: string;
  /** 付ける名前の既定（同じ名前が在れば画面が番号を足す） */
  suggestedName: string;
  launch: ModuleLaunch;
  meta: unknown;
}

export const BUNDLED_CATALOG: BundledCatalogEntry[] = [
  {
    id: "vault-infisical",
    name: "Vault（Infisical）",
    description:
      "Infisical に秘密を預ける Vault。接続先ごとに1本入れます（自前ホストと Cloud を並べる、など）",
    suggestedName: "vault-infisical",

    // **vault 役割の2本目**（Infisical、2026-09-12）。役割は同じ `vault` で、
    // 違うのは「秘密をどこに置くか」と「メタデータをどこに置くか」だけ
    // ——A/B/C の配線は `@banto/vault-kit` が共有する。
    //
    // **資格情報は Infisical には入れられない**（金庫を開ける鍵は金庫に入らない）
    // ——組み込み Vault の `identity.txt` と同じ category。
    //
    // **繋ぎ方は人が設定画面から入れる**（改訂・2026-09-13、ユーザー要望）。
    // 以前は環境変数だけで、**設定していないと Module が立たなかった**
    // ——立たないので設定画面にも辿り着けず、host は毎回「繋げませんでした」を
    // 受信箱に出していた（毎日のノイズ）。いまは**未設定でも立つ**：設定画面を
    // 出し、値を触る口は理由つきで断る。環境変数も引き続き読む（開発・E2E）。
    //
    // **2本目をコードに書かない**（改訂・2026-09-20、ユーザー指摘）。2026-09-15 に
    // Infisical Cloud 用の2本目を既定の配列へコピペしていたが、当時は
    // **画面から増やす手段が無かった**から（名前が既定に無いと `vault` を
    // 名乗れなかった）。いまは「Module を追加」からここを選んで何本でも入れられる
    // ——コードに写しを持つと、**消したくても消せない行**になる（既定は設定に
    // 無いので `removable: false`）。
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault-infisical/dist/server.js"],
      // **資格情報はここに書かない。** `BANTO_INFISICAL_*` は host の環境変数を
      // 子がそのまま継ぐ（cli.ts が `...process.env` を渡す）——宣言は
      // Event Store に残るので、**秘密を宣言に書くと記録に残ってしまう**。
      // 置き場は運用側（banto を起動する環境）。
      // **置き場は接続名ごとに分かれる場所**（訂正・2026-09-15）。以前は
      // `${dataDir}/vault-infisical` という**固定のパス**だったので、同じ実装を
      // 2本立てると（自前ホストと Infisical Cloud を並べるなど）**2本目が
      // 1本目の資格情報を上書きする**。`${moduleDataDir}` は banto が
      // 接続名ごとに用意するので、コピーしてもぶつからない。
      env: { BANTO_VAULT_INFISICAL_DATA_DIR: "${moduleDataDir}" },
    },
    meta: {
      satisfies: ["vault"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
      handlesSecrets: true,
    },
  },
  {
    // **動き続けるもの（開発サーバ・監視）を起こしておく**（v4-modules.md §4.2、2026-09-27）。
    // 必須ではないので既定ではなく目録に置く（決定・2026-09-27、ユーザー）。Project のコンテナの中の
    // systemd（ユーザー単位）に任せ、登録はこの Module のデータ置き場（`BANTO_MODULE_DATA_DIR`、host が渡す）
    id: "service",
    name: "Service",
    description: "開発サーバなど、止めるまで動き続けるものを Project のコンテナで起こしておく（落ちたら起こし直す）",
    suggestedName: "service",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/service/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["service"],
      // envSecrets を解決するので Shell と同じく窓口と金庫の両方。登録を消すときは公開の窓口に知らせる
      // （追加・2026-09-28——公開中のサービスを消したら公開もやめる。v4-modules.md §4.2）
      dependsOn: [
        { role: "vault-directory", required: true },
        { role: "vault", required: true },
        { role: "publish-directory", required: false },
      ],
      isolation: "subprocess",
      scope: "project",
      confinement: { kind: "landlock", root: "project", profile: "exec" },
    },
  },
  {
    // **仕事の一覧**（v4-modules.md §4.4、2026-10-03）。Project の根のリポジトリの**一覧のブランチ**（既定 `backlog`、
    // 中は tasks.json 1つ）を git の低レベルのコマンドで読み書きする（改訂・2026-10-04——作業ツリーの tasks.json から）。
    // 必須ではないので既定ではなく目録に置く（人が「Module を追加」から入れる）。git を走らせるので exec。
    // 送る・取ってくるは Repositories に中継で頼む（資格情報はそちら）。設定（ブランチ名）は `BANTO_MODULE_DATA_DIR`
    id: "backlog",
    name: "Backlog",
    description: "今後やること・バグを、ストーリー・タスク・バグと依存で持つ（リポジトリの backlog ブランチ）。AI が一覧を引き、タスクに分ける",
    suggestedName: "backlog",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/backlog/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["backlog"],
      dependsOn: [{ role: "repositories", required: false }],
      isolation: "subprocess",
      scope: "project",
      confinement: { kind: "landlock", root: "project", profile: "exec" },
    },
  },
  {
    // **動いているものに届く URL を生やす窓口**（v4-modules.md §4.3、2026-09-27）。AI の道具（publishService・
    // unpublishService・listPublished）と承認の画面を持ち、道を張るのは `publish` 役割の実装。**banto 本体で動く**
    // ——承認の画面を出すコードがコンテナの中にあると、中で root の AI が偽れる（v4-security.md §1）。
    // Service（Project ごと）は、その Project のための呼び出しの中でだけ呼べる（中継が決める）
    id: "publish-directory",
    name: "Publish（窓口）",
    description: "Service で動かしているサーバに URL を生やす。公開のたびに人が承認する。出し方（Caddy など）を別に入れます",
    suggestedName: "publish-directory",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/publish-directory/dist/server.js"],
      env: {
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["publish-directory"],
      dependsOn: [
        { role: "publish", required: true },
        { role: "service", required: false },
      ],
      isolation: "subprocess",
      scope: "instance",
      // 人が承認の画面で打った設定（Basic 認証のパスワード等）が通る
      handlesSecrets: true,
    },
  },
  {
    // **Caddy のサブドメインで公開する**（§4.3 の最初の実装）。host の Caddy の admin API にルートを足す。
    // host で動く同梱のコードだけが、Project のコンテナのアドレスを引ける（中継の `relayProjectAddress`）
    id: "publish-caddy",
    name: "Publish（Caddy のサブドメイン）",
    description: "host の Caddy に <サービス>-<Project>.<ドメイン> のルートを足して公開する。設定で基のドメインを決めます",
    suggestedName: "publish-caddy",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/publish-caddy/dist/server.js"],
      env: {
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["publish"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
      // 人が承認の画面で打った Basic 認証のパスワードが通る（持つのは bcrypt のハッシュだけ）
      handlesSecrets: true,
    },
  },
];

/**
 * **同梱かどうかを host が決める**（追加・2026-09-15）。
 *
 * 同梱と認めるのは、**起動するプログラムと引数が、同梱実装のどれかと一致する**
 * ときだけ。`env` の差分は設定なので同梱のまま——**走るコードが banto のものか**
 * が境界。command や args を書き換えたら、それはもう別のプログラム。
 *
 * **名前は見ない**（改訂・2026-09-19、ユーザー指摘）。以前は「名前が既定に在り、
 * かつコードが既定のまま」を条件にしていたので、**まったく同じコードでも
 * 名前が違うと第三者扱い**だった。結果、`vault-infisical` を別名でもう1本
 * 立てられず（`vault` を名乗った時点で弾かれる）、**接続先を増やすにはコードを
 * 足して再デプロイするしかなかった**。守りたいのは「走るコードが banto のものか」
 * であって、名前ではない——名前は判断の根拠になっていなかった。
 *
 * これで壊れないこと：`vault-directory` は `SINGLETON_ROLES` で全体1本に固定
 * されているので、窓口が増えることはない。`shell`・`filesystem` は複製できるが、
 * Project ごとに同じものが2本立つだけで、得られる権限は増えない
 * （決定・2026-09-19、ユーザー「放ってよい」）。
 */
function withOrigin(
  name: string,
  launch: ModuleLaunch,
  meta: BantoModuleMeta,
  source: string,
): BantoModuleMeta {
  // **URL に繋ぐ形は、決して同梱にならない**（同梱はすべて banto が起こす
  // プロセス）。ここを構造で閉じておく——将来 `url` を持つ既定を足しても、
  // 「同梱のコードを借りて外へ繋ぐ」が生えない
  const sameCode =
    !isRemoteLaunch(launch) &&
    // **既定に入っているものだけが banto のコードではない**（改訂・2026-09-20）
    // ——目録から入れたものも同じコードが走る
    [...DEFAULT_MODULE_DECLARATIONS, ...BUNDLED_CATALOG].some((def) => {
      if (isRemoteLaunch(def.launch)) return false;
      return (
        def.launch.command === launch.command &&
        def.launch.args.length === launch.args.length &&
        def.launch.args.every((a, i) => a === launch.args[i])
      );
    });
  if (!sameCode) {
    // 第三者のコード——骨格の役割は名乗れない
    assertRolesAllowed(meta, `${source}(${name})`);
    return meta;
  }
  return markBundled(meta, `${source}(${name})`);
}

function expand(text: string, context: LaunchContext, source: string): string {
  return text.replace(PLACEHOLDER_PATTERN, (_all, key: string) => {
    // **金庫の語は、ここでは解かない**——host が起動の直前に、刻印と監査を
    // 通して引いてから `expandLaunch` を呼ぶ（`resolveSecretPlaceholders`）。
    // ここまで残っていたら**解かれていない**ということなので、止める（規則2）
    if (key.startsWith(SECRET_PREFIX)) {
      throw new ModuleDeclarationError(`${source}: \${${key}} が解かれないまま起動しようとしています`);
    }
    const value = (context as unknown as Record<string, string | undefined>)[key];
    if (value === undefined) {
      // parse で弾いているはずのものがここへ来たら、黙って空文字にしない（規則2）
      throw new ModuleDeclarationError(`${source}: \${${key}} に入れる値がありません`);
    }
    return value;
  });
}

/**
 * **その Module に `${secret:…}` を許してよいか**（追加・2026-09-16）。
 *
 * 判断を host の起動処理の中に埋めずに出してある——**ここが秘密を渡してよい
 * 相手の定義**なので、試験できる場所に置く（規則1）。
 */
export function secretsAllowedFor(
  meta: BantoModuleMeta,
  launch?: ModuleLaunch,
): { ok: true } | { ok: false; reason: string } {
  // **金庫を開ける鍵は金庫に入らない。** 窓口（vault-directory）も同じ
  // ——窓口は解決の経路そのものなので、自分を解決するのに自分が要る
  const vaultRole = meta.satisfies.find((r: string) => r === "vault" || r === "vault-directory");
  if (vaultRole) {
    return {
      ok: false,
      reason: "Vault そのものは ${secret:…} を使えません（自分を開ける鍵は自分の中に置けません）",
    };
  }
  // **URL に繋ぐ形は、閉じ込めの代わりに人の承知で守る**（追加・2026-09-17）。
  //
  // 閉じ込めを求めていたのは「**こちらで動く**第三者のコードに鍵を渡すと、
  // その鍵でこちらの何を触られるか分からない」から。URL に繋ぐ形ではコードが
  // こちらに無いので、その心配は無い——**代わりに要るのが「外へ出す」ことへの
  // 人の明示の承知**で、そこは `connectRemoteDeclaredModule` が秘密を引く前に見る。
  // 置ける場所がヘッダだけなのも効いている（URL に置けば経路の記録に残る）。
  if (launch && isRemoteLaunch(launch)) return { ok: true };
  // **外から足した起動する形は、コンテナの中で動く**（`modulePlacement`、変更・2026-09-25——Landlock をやめた）。
  // 以前はここで「閉じ込めを名乗っていない外部 Module には渡さない」と断っていたが、閉じ込めは宣言が名乗る
  // ものではなく置き場所で決まるようになり、**閉じ込めの無い外部 Module はもう無い**。
  // banto 本体で動くのは同梱（banto 自身のコード）だけ
  return { ok: true };
}

/** `secret:名前` から名前を取り出す（前後の空白は落とす）。 */
const aliasOf = (key: string): string => key.slice(SECRET_PREFIX.length).trim();

/** その起動の指定が金庫から引く秘密（`${secret:名前}`）を、環境変数名つきで並べる。 */
export function secretPlaceholders(launch: ModuleLaunch): Array<{ envName: string; alias: string }> {
  const found: Array<{ envName: string; alias: string }> = [];
  // **置き場は形によって違うが、規則は同じ**——argv に載らないところだけ
  const carriers = isRemoteLaunch(launch) ? (launch.headers ?? {}) : (launch.env ?? {});
  for (const [envName, value] of Object.entries(carriers)) {
    for (const m of value.matchAll(PLACEHOLDER_PATTERN)) {
      const key = m[1] ?? "";
      // **前後の空白は落とす**。並べる側と差し込む側で揃えないと、
      // 「引けたのに埋まらない」が起きる（規則3——同じ規則を2か所に書かない）
      if (key.startsWith(SECRET_PREFIX)) found.push({ envName, alias: aliasOf(key) });
    }
  }
  return found;
}

/** 引いた値を差し込んだ起動の指定を返す。**値はここで初めて現れる**。 */
export function fillSecrets(launch: ModuleLaunch, values: ReadonlyMap<string, string>): ModuleLaunch {
  const fill = (text: string): string =>
    text.replace(PLACEHOLDER_PATTERN, (all, key: string) => {
      if (!key.startsWith(SECRET_PREFIX)) return all;
      const alias = aliasOf(key);
      const value = values.get(alias);
      // 引けなかったものを空文字で埋めない（規則2）
      if (value === undefined) throw new ModuleDeclarationError(`秘密 "${alias}" を引けませんでした`);
      return value;
    });

  if (isRemoteLaunch(launch)) {
    if (!launch.headers) return launch;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(launch.headers)) headers[k] = fill(v);
    return { ...launch, headers };
  }
  if (!launch.env) return launch;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(launch.env)) env[k] = fill(v);
  return { ...launch, env };
}

export function expandLaunch(launch: ModuleLaunch, context: LaunchContext): ModuleLaunch {
  const source = "launch";
  // **URL に繋ぐ形には、解く語が無い**（parse が `${secret:…}` 以外を断っていて、
  // その1つは既に解かれている）。ここを通すのは「解かれ残りが無い」の確認のため
  if (isRemoteLaunch(launch)) {
    assertNoPlaceholder(launch.url, `${source}: url`);
    for (const [key, value] of Object.entries(launch.headers ?? {})) {
      assertNoPlaceholder(value, `${source}: headers.${key}`);
    }
    return launch;
  }
  return {
    command: expand(launch.command, context, source),
    args: launch.args.map((a) => expand(a, context, source)),
    env: launch.env
      ? Object.fromEntries(Object.entries(launch.env).map(([k, v]) => [k, expand(v, context, source)]))
      : undefined,
  };
}

/**
 * Configuration に入れるときの鍵。instance 既定と Project 上書きで同じ鍵を使う。
 *
 * **`modules` は古い形**（丸ごとの写し）。読むだけで、もう書かない
 * ——2026-09-07 より前に書かれたものが残っているので、読み込みでは翻訳する。
 */
export const MODULE_DECLARATIONS_KEY = "modules";

/** **いま書く鍵**。中身は既定との差分だけ（決定・2026-09-07）。 */
export const MODULE_OVERLAYS_KEY = "moduleOverlays";

/**
 * **「この Module は machine の外へデータを送る」と人が承知した記録**
 * （追加・2026-09-17、`docs/specs/v4-security.md`）。
 *
 * **URL ごとに覚える。** URL が変われば別の相手なので、聞き直す。
 * 消したら忘れる——**名前を再利用して別の相手へ繋ぎ直す**ときに、前の承認が
 * そのまま効いてはいけない（2026-09-15 の `codeId` と同じ理由）。
 *
 * 置き場は RuntimeConfig（＝Event Store に残る）。プロセスメモリに置くと
 * host を再起動するたびに人が承知し直すことになる。
 */
export const REMOTE_EGRESS_KEY = "remoteEgressAcknowledged";

interface EgressAcknowledgement {
  name: string;
  url: string;
}

function egressList(config: RuntimeConfigStore): EgressAcknowledgement[] {
  const raw = config.layerValue(REMOTE_EGRESS_KEY, "") as unknown;
  return Array.isArray(raw) ? (raw as EgressAcknowledgement[]) : [];
}

/** その名前・その URL について、人が承知しているか。 */
export function isEgressAcknowledged(config: RuntimeConfigStore, name: string, url: string): boolean {
  return egressList(config).some((a) => a.name === name && a.url === url);
}

/** 人が承知した、と記録する。 */
export async function acknowledgeEgress(
  config: RuntimeConfigStore,
  name: string,
  url: string,
): Promise<void> {
  if (isEgressAcknowledged(config, name, url)) return;
  const next = [...egressList(config).filter((a) => a.name !== name), { name, url }];
  await config.setInstanceDefault(
    REMOTE_EGRESS_KEY,
    next as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1],
  );
}

/** 消した Module の承認を忘れる。 */
export async function forgetEgress(config: RuntimeConfigStore, name: string): Promise<void> {
  const next = egressList(config).filter((a) => a.name !== name);
  if (next.length === egressList(config).length) return;
  await config.setInstanceDefault(
    REMOTE_EGRESS_KEY,
    next as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1],
  );
}

/**
 * 同梱の既定。**ここが「コードに書いてある唯一の Module 情報」**で、
 * これも宣言の形をしている——特別扱いしない（規則3）。
 */
export const DEFAULT_MODULE_DECLARATIONS: ModuleDeclaration[] = [
  {
    // Vault は instance に1本。Landlock は掛けない（秘密の保管庫自身は
    // Project の根に閉じ込める対象ではない、v4-security.md）。
    // **名前は `vault-local`**（改名・2026-09-13、ユーザー指摘）。役割は `vault`
    // のままで、変えたのは**実装の名前**だけ——2本目（Infisical）が入って
    // 「vault」が役割なのか実装なのか紛らわしくなったため（規則11）。
    //
    // **データ置き場は `${dataDir}/vault` のまま動かさない。** ここは宣言が
    // 固定していて Module 名から導いていないので、改名しても既存の秘密は
    // そのまま読める（移すと孤児になる）。
    name: "vault-local",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault-local/dist/server.js"],
      env: { BANTO_VAULT_DATA_DIR: "${dataDir}/vault" },
    },
    meta: {
      satisfies: ["vault"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
      handlesSecrets: true,
    },
  },
  {
    // **名前から在りかを引く窓口**（`vault-directory`、v4-modules.md §2.1）。
    // 自分では秘密を保管しない——`vault` を名乗る実装を横断して、**AI・人・
    // 他 Module に1つの窓口**を見せる。**値は通さない**（`resolveAlias` は
    // 呼び出し元 → host → backend の直行のまま）。
    // ただし**人が画面で打った登録の値は通る**ので `handlesSecrets: true`＝subprocess
    // （要件 C8c、`docs/notes/2026-09-12-vault-directory.md`）。
    // Landlock は掛けない（Vault と同じく、秘密に触るものは閉じ込めの外）。
    name: "vault-directory",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/vault-directory/dist/server.js"],
      env: {
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
        // 「新しい秘密をどこに置くか」の既定を覚えておく置き場
        // （追加・2026-09-13）。**秘密は1つも置かない**——既定の Vault 名だけ
        BANTO_VAULT_DIRECTORY_DATA_DIR: "${dataDir}/vault-directory",
      },
    },
    meta: {
      satisfies: ["vault-directory"],
      dependsOn: [{ role: "vault", required: true }],
      isolation: "subprocess",
      scope: "instance",
      handlesSecrets: true,
    },
  },
  {
    // Shell/FileSystem は Project ごと——Landlock は一度掛けたら緩められないので、
    // Project の根が決まった時点で別プロセスとして立てる（v4-security.md）。
    name: "shell",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/shell/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["shell"],
      // **在りかは窓口に、値は金庫に**（改訂・2026-09-12）。どちらが欠けても
      // 秘密は渡せないので両方 required（v4-modules.md §2.1 B節）
      dependsOn: [
        { role: "vault-directory", required: true },
        { role: "vault", required: true },
      ],
      isolation: "subprocess",
      scope: "project",
      // **コマンドを走らせる Module だけが exec**（明示・2026-09-15）。
      // 以前は host が `satisfies` から推していた
      confinement: { kind: "landlock", root: "project", profile: "exec" },
    },
  },
  {
    name: "filesystem",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/filesystem/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["filesystem"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "project",
      confinement: { kind: "landlock", root: "project" },
    },
  },
  {
    // **サブエージェントに仕事を頼む**（決定・2026-09-24、アーキ仕様 §4.1）。
    // Claude Code・OpenCode を ACP で起こす。**閉じ込めは Module ではなくエージェントに
    // 掛ける**——Module がエージェントを Landlock のドメインで起こす
    // （v4-security.md「サブエージェントは自分のドメインで起こす」）。Module 自身は
    // AI の書いたコマンドを走らせないので、Vault と同じく閉じ込めの外に置く
    // （閉じ込めると、launcher とエージェント本体を実行できない）
    name: "subagent",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/subagent/dist/server.js"],
      env: {
        BANTO_PROJECT_ROOT: "${projectRoot}",
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["subagent"],
      // 資格情報は Vault の alias から受け取る（Shell の envSecrets と同じ経路）。本体の Claude ログインの中継は
      // banto 全体の設定の Module が開く（決定・2026-09-25——本体のログインはコンテナの中に無い）
      dependsOn: [
        { role: "vault-directory", required: true },
        { role: "vault", required: true },
        { role: "subagent-settings", required: true },
      ],
      isolation: "subprocess",
      scope: "project",
    },
  },
  {
    // **サブエージェントの設定**（決定・2026-09-24、ユーザー「鍵の設定は Project ではなく Global に」）。
    // 設定画面がどちらに出るかは Module の単位が決める——走らせる Module（上）は Project ごとなので、
    // **設定だけを受け持つ banto 全体の Module** を分けた（同じパッケージの別の入口）。
    // 鍵は Vault の決まった名前に置き、どの Project でも使う。banto 全体の設定画面から押した操作は
    // 人の管理操作と刻まれるので、Vault の書き換え・削除もここからできる。
    // 閉じ込めない——本体の Claude ログインの状態と、この機械の OpenCode の設定（取り込み元）を読む
    name: "subagent-settings",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/subagent/dist/settings-server.js"],
      env: {
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["subagent-settings"],
      dependsOn: [
        { role: "vault-directory", required: true },
        { role: "vault", required: true },
      ],
      isolation: "subprocess",
      scope: "instance",
      // 人が設定画面で打った鍵がこの Module を通って Vault へ行く（要件 C8c）
      handlesSecrets: true,
    },
  },
  {
    // **Skill を資源として配る**（決定・2026-09-23、アーキ仕様 §5.6・§5.7）。
    // Skill は Project をまたいで使うもの（Memory との違い）なので banto 全体に1本。
    // **効かせるかはここでは決めない**——core が会話ごとに `instructions` を組み立てる。
    //
    // **閉じ込める**（根は持たない）。配るのは他人が書いた文書で、読むのは自分の
    // 置き場（`${moduleDataDir}` の下、host が必ず渡す）だけで足りる
    name: "skills",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/skills/dist/server.js"],
    },
    meta: {
      satisfies: ["skills"],
      dependsOn: [],
      isolation: "subprocess",
      scope: "instance",
      confinement: { kind: "landlock", root: "none", profile: "files-only" },
    },
  },
  {
    // **手元のリポジトリの台帳**（決定・2026-09-29〜10-01、ユーザー、v4-modules.md §2.4）。
    // **既定で入っていて消せない**（無効にはできる——無効にすると新しい Project の始め方は「手元のフォルダ」だけ）。
    // banto 全体に1本・banto 本体で動く：Project より先に動く必要がある（Project の根を用意するのがこの Module）。
    // 読むのは人が選んだフォルダと台帳のフォルダの git の情報だけ。中継はどの Project がそのフォルダを根にしているかを
    // 引くため（`relayListProjects`、人の画面からの呼び出しの中でだけ答える）と、GitHub のアカウントの秘密を Vault に
    // 置く・引くため（段階2）。ログインの更新に失敗したら受信箱に知らせる（`relayRaiseNotice`）
    name: "repositories",
    launch: {
      command: "${nodeExec}",
      args: ["${monorepoRoot}/packages/modules/repositories/dist/server.js"],
      env: {
        BANTO_HOST_MCP_URL: "${hostRelayUrl}",
        BANTO_HOST_MCP_TOKEN: "${hostRelayToken}",
      },
    },
    meta: {
      satisfies: ["repositories"],
      // 台帳だけなら Vault 無しでも動く——アカウント（PAT・ログインのトークン・SSH 鍵）だけが Vault を使う
      dependsOn: [
        { role: "vault-directory", required: false },
        { role: "vault", required: false },
      ],
      isolation: "subprocess",
      scope: "instance",
      // 人が設定画面で貼った PAT がこの Module を通って Vault へ行く（要件 C8c）
      handlesSecrets: true,
    },
  },
];

/**
 * その Project で繋ぐ Module の宣言。
 * Project 上書きがあればそれ、無ければ instance 既定、それも無ければ同梱の既定。
 * **導出できるものを写さない**（規則3）——一覧はここでだけ作る。
 */
export function loadModuleDeclarations(
  config: RuntimeConfigStore,
  projectId: string,
): ParsedModuleDeclaration[] {
  // **Config に入っているのは差分**（決定・2026-09-07、VS Code と同じ形）。
  // 既定はコードが持ち、写さない——写すと、既定を改良しても写しを持つ Project
  // には届かない（実測・2026-09-07、規則3）。
  //
  // **鍵を分ける。** 古い鍵（`modules`）には**丸ごとの写し**が入っていて、
  // 差分とは形が同じでも意味が違う（差分の「書いていない」は既定のまま、
  // 写しの「載っていない」は外した）。**同じ鍵に混ぜると読み分けられない**ので、
  // 差分は別の鍵に置き、古い鍵は読むときだけ差分へ翻訳する。
  //
  // **層は2つとも重ねる**（改訂・2026-09-10）。差分は「変えたところだけ」なので、
  // instance の差分と Project の差分は**足し合わせる**もの——カスケードで片方だけを
  // 選ぶと、**Project が差分を1つ持っただけで instance 側の直しが丸ごと届かなく
  // なる**（`declaration-repair-project-overlay` の検証中に実測）。
  const sources: string[] = [];
  const layers: ModuleOverlay[][] = [];
  for (const layer of projectId ? ["", projectId] : [""]) {
    const stored = config.layerValue(MODULE_OVERLAYS_KEY, layer || undefined);
    const storedWhole = config.layerValue(MODULE_DECLARATIONS_KEY, layer || undefined);
    if (Array.isArray(stored)) {
      layers.push(stored as ModuleOverlay[]);
      sources.push(`config(moduleOverlays${layer ? ":project" : ""})`);
    } else if (Array.isArray(storedWhole)) {
      // 古い形——**丸ごとの写しを差分に翻訳してから**重ねる
      layers.push(diffFromDefaults(DEFAULT_MODULE_DECLARATIONS, storedWhole as ModuleDeclaration[]));
      sources.push(`config(modules${layer ? ":project" : ""})`);
    }
  }
  const source = sources.length > 0 ? sources.join("+") : "default";
  let raw: ModuleDeclaration[] = [...DEFAULT_MODULE_DECLARATIONS];
  for (const overlays of layers) raw = applyModuleOverlay(raw, overlays);
  const parsed = raw.map((d) => parseModuleDeclaration(refreshFromCatalog(d), source));
  const names = new Set<string>();
  for (const d of parsed) {
    if (names.has(d.name)) {
      throw new ModuleDeclarationError(`${source}: Module 名が重複しています: ${d.name}`);
    }
    names.add(d.name);
  }
  assertSingletonRoles(parsed, source);
  return parsed;
}

/**
 * **目録から入れた Module の宣言は、読むたびに目録から取り直す**（決定・2026-10-04、ユーザー）。
 *
 * `installFromCatalog` は入れたときの launch と meta を設定に写す。写しは古いまま残るので、あとで目録の宣言を
 * 直しても（依存を足す・閉じ込めを変える）、入れてあった Project には届かなかった——Backlog が Repositories への
 * 依存を持たず中継で相手が見えなかった（2026-10-04）・Service が publish-directory への依存を持たなかった（2026-09-28）。
 * 既定（`DEFAULT_MODULE_DECLARATIONS`）を写さないのと同じ理由（規則3）。
 *
 * **同じコード（command と args が目録の1本と一致）なら、meta と launch の env を目録のものにする。** 名前と、
 * 人が変えたもの（有効・無効など、宣言の外の設定）はそのまま。違うコードは第三者のものとして触らない。
 * 自己申告が目録より厳しければ起動で食い違いとして止まる——同梱のコードなので、それは目録の誤り（直すのはコード）。
 */
function refreshFromCatalog(d: ModuleDeclaration): ModuleDeclaration {
  if (isRemoteLaunch(d.launch)) return d;
  const launch = d.launch;
  const entry = BUNDLED_CATALOG.find(
    (e) =>
      !isRemoteLaunch(e.launch) &&
      e.launch.command === launch.command &&
      e.launch.args.length === launch.args.length &&
      e.launch.args.every((a, i) => a === launch.args[i]),
  );
  if (!entry || isRemoteLaunch(entry.launch)) return d;
  return {
    ...d,
    launch: { ...launch, ...(entry.launch.env ? { env: { ...entry.launch.env } } : {}) },
    meta: entry.meta,
  };
}

/**
 * **束ね役は instance 全体で1本**（追加・2026-09-15、レビューで発覚）。
 *
 * 窓口は「複数を1つに見せる」ためのものなので、**それ自体が複数あると意味が消える**
 * ——呼ぶ側（Shell）が「唯一の1本」を引けなくなる。
 * **A 面の有無からは導出できない**ので明示で持つ（`SINGLETON_ROLES`）。
 */
function assertSingletonRoles(declarations: ParsedModuleDeclaration[], source: string): void {
  for (const role of SINGLETON_ROLES) {
    const claimants = declarations.filter((d) => d.meta.satisfies.includes(role));
    if (claimants.length > 1) {
      throw new ModuleDeclarationError(
        `${source}: 役割 "${role}" は1本だけです（${claimants.map((d) => d.name).join("・")} が名乗っています）`,
      );
    }
  }
}

/**
 * 宣言を差し替える。projectId を渡すとその Project だけ。
 *
 * **保存するのは既定との差分だけ**（決定・2026-09-07）。渡すのは「こうなって
 * ほしい一覧」で、既定と同じところは書かない——**書くと、既定を改良しても
 * ここが古いまま残る**（規則3）。
 */
export async function setModuleDeclarations(
  config: RuntimeConfigStore,
  declarations: ModuleDeclaration[],
  projectId?: string,
): Promise<void> {
  // 入れる前に検める——壊れた宣言を Event Store に残さない（規則2）。
  // **parse を通した形で比べる**——渡ってくるのは `loadModuleDeclarations` の
  // 結果（host が `origin` を立てた形）なので、生のまま比べると
  // **host が付けた印が「人の上書き」として保存される**（規則3——写しの汚染）
  const normalized = declarations.map(
    (d) => parseModuleDeclaration(d, "setModuleDeclarations") as unknown as ModuleDeclaration,
  );
  // **同じ形どうしで比べる**（改訂・2026-09-10）。渡ってくるのはたいてい
  // `loadModuleDeclarations` の結果＝**parse で既定が埋まった形**（`handlesSecrets:
  // false` 等）。生の既定と比べると、**既定と同じ値が「上書き」として保存され**、
  // あとで既定を直しても、その Project にだけ古い値が貼り付いたままになる
  // （規則3——写しの汚染。`declaration-repair-project-overlay` の検証中に発見）
  const parsedDefaults = DEFAULT_MODULE_DECLARATIONS.map(
    (d) => parseModuleDeclaration(d, "default") as unknown as ModuleDeclaration,
  );
  const overlays = diffFromDefaults(parsedDefaults, normalized);
  const value = overlays as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1];
  if (projectId) await config.setProjectOverride(projectId, MODULE_OVERLAYS_KEY, value);
  else await config.setInstanceDefault(MODULE_OVERLAYS_KEY, value);
}

/**
 * **自己申告のほうが厳しかったときに、宣言を直す**（`declaration-repair-project-overlay`、
 * 2026-09-10）。直すのは「この Module がこう申告した」という **Module 固有の事実**で、
 * その Project の事情ではない。
 *
 * 以前は Project の上書きを混ぜて解決した一覧を、**projectId 抜きで**保存していた
 * ——つまり
 *
 * - **その Project の上書きが、全 Project の既定に漏れる**
 * - 当の Project の上書きは直らないので、次に起動しても同じ食い違いが出る
 *
 * という二重の壊れ方をしていた（規則3——写しの汚染）。**既定は既定として読み直し、
 * そこへ足して既定に書き戻す。** ただしその Module が既定に無い（Project の上書きで
 * だけ足された Module）なら、直す先はその Project しかない。
 */
export async function repairDeclarationMeta(
  config: RuntimeConfigStore,
  input: { name: string; projectId?: string; stricter: Record<string, unknown> },
): Promise<{ writtenTo: "instance" | "project" }> {
  const base = loadModuleDeclarations(config, "");
  const inBase = base.some((d) => d.name === input.name);
  const target = inBase ? base : loadModuleDeclarations(config, input.projectId ?? "");
  const next = target.map((d) =>
    d.name === input.name ? { ...d, meta: { ...d.meta, ...input.stricter } } : d,
  );
  if (inBase) {
    await setModuleDeclarations(config, next as ModuleDeclaration[]);
    return { writtenTo: "instance" };
  }
  await setModuleDeclarations(config, next as ModuleDeclaration[], input.projectId);
  return { writtenTo: "project" };
}

/**
 * **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、
 * 2026-09-11、Phase 2 の入口）。
 *
 * 渡すのは「この Project で使う名前の一覧」。**外す**は差分の `enabled: false`
 * として残る——既定から消すのではなく、「この Project では使わない」と書く
 * （他の Project には影響しない）。
 *
 * **その Project 固有の直し（launch や meta の差分）は残す**——選び直しただけで
 * 消えてはいけない（規則3——ここで持っているのは「使うかどうか」だけ）。
 */
export async function setProjectModuleSelection(
  config: RuntimeConfigStore,
  projectId: string,
  selectedNames: readonly string[],
): Promise<void> {
  // **選べるのは banto が知っているものだけ**（規則2——知らない名前を順番に置かない）
  const available = loadModuleDeclarations(config, "");
  for (const name of selectedNames) {
    if (!available.some((d) => d.name === name)) {
      throw new ModuleDeclarationError(`知らない Module です: ${name}`);
    }
  }
  const selected = new Set(selectedNames);
  const existing = (config.layerValue(MODULE_OVERLAYS_KEY, projectId) as ModuleOverlay[] | undefined) ?? [];

  const byName = new Map<string, ModuleOverlay>();
  for (const overlay of existing) {
    // `enabled` は下で決め直す——古い「外した」印を持ち越さない
    const { enabled: _dropped, ...rest } = overlay;
    byName.set(overlay.name, rest as ModuleOverlay);
  }
  for (const declaration of available) {
    if (selected.has(declaration.name)) continue;
    byName.set(declaration.name, { ...(byName.get(declaration.name) ?? { name: declaration.name }), enabled: false });
  }

  // 何も言っていない差分（名前だけ）は落とす——空の印を記録に残さない
  const overlays = [...byName.values()].filter(
    (o) => o.enabled === false || o.launch !== undefined || o.meta !== undefined,
  );
  await config.setProjectOverride(
    projectId,
    MODULE_OVERLAYS_KEY,
    overlays as unknown as Parameters<RuntimeConfigStore["setProjectOverride"]>[2],
  );
}

/**
 * **この Project の Module の一覧**（選ばれているかも含めて）。
 * 画面はこれをそのまま並べる——別の一覧を作らない（規則3）。
 *
 * **繋いでみないと分からないこと（tool の数）は返さない。** 数えるには
 * 起動して聞くしかなく、一覧を見ただけで全部を起こすのは筋が悪い（規則2——
 * 分からないものを、分かったように見せない）。
 */
export function listProjectModules(
  config: RuntimeConfigStore,
  projectId: string,
): Array<{
  name: string;
  selected: boolean;
  satisfies: string[];
  dependsOn: BantoModuleMeta["dependsOn"];
  scope: BantoModuleMeta["scope"];
  confinement?: BantoModuleMeta["confinement"];
  placement: ModulePlacement;
}> {
  const available = loadModuleDeclarations(config, "");
  const selected = new Set(loadModuleDeclarations(config, projectId).map((d) => d.name));
  return available.map((d) => ({
    name: d.name,
    selected: selected.has(d.name),
    satisfies: d.meta.satisfies,
    dependsOn: d.meta.dependsOn,
    scope: d.meta.scope,
    ...(d.meta.confinement ? { confinement: d.meta.confinement } : {}),
    placement: modulePlacement(d.meta, d.launch),
  }));
}

// ---- instance 層の管理（追加・2026-09-15）-----------------------------------
//
// **Project ごとの選択は前からある**（`setProjectModuleSelection`）。
// 無かったのは **banto 全体の層**——宣言を足す・消す・止める口。
// §10 item 14 (a) が未着手のまま残っていた部分。

/** 設定（差分）にその Module の宣言そのものが書かれているか＝消す対象があるか。 */
function hasStoredDeclaration(overlays: readonly ModuleOverlay[], name: string): boolean {
  return overlays.some((o) => o.name === name && o.launch !== undefined);
}

/** instance 全体の一覧（無効にしたものも含む）。**隠すと直せない**（規則2）。 */
export function listInstanceModules(config: RuntimeConfigStore): Array<{
  name: string;
  enabled: boolean;
  origin: BantoModuleMeta["origin"];
  satisfies: string[];
  dependsOn: BantoModuleMeta["dependsOn"];
  scope: BantoModuleMeta["scope"];
  confinement?: BantoModuleMeta["confinement"];
  placement: ModulePlacement;
  launch: ModuleLaunch;
  /**
   * **一覧から消せるか**（追加・2026-09-19、ユーザー指摘）。
   *
   * 以前は `origin === "bundled"` で決めていたが、これは権限の話ではない
   * ——**既定の宣言はコードの中にあって設定には無い**ので、設定から消しても
   * 次の起動でまた出てくる。つまり「消してはいけない」のではなく**消すものが無い**。
   * 見るべきは「設定にその宣言が書かれているか」だけ。
   */
  removable: boolean;
}> {
  const enabled = loadModuleDeclarations(config, "");
  const overlays = (config.layerValue(MODULE_OVERLAYS_KEY, undefined) as ModuleOverlay[] | undefined) ?? [];
  const disabled = overlays.filter((o) => o.enabled === false).map((o) => o.name);

  // 無効にしたものも一覧に出す——「消えた」ではなく「止めた」と分かるように。
  //
  // **外から足したものも戻す**（修正・2026-09-19、ユーザー報告）。以前は同梱の
  // 既定からしか復元していなかったので、**外から足した Module は止めた瞬間に
  // 一覧から消えていた**——止めたのに消えたように見えるし、消えて見えるので
  // **もう動かせない**（規則2・規則13）。宣言そのものは差分に残っているので、
  // 復元に要るものは全部そこにある。
  const all = [...enabled];
  for (const name of disabled) {
    if (all.some((d) => d.name === name)) continue;
    const def = DEFAULT_MODULE_DECLARATIONS.find((d) => d.name === name);
    if (def) {
      all.push(parseModuleDeclaration(def, "default"));
      continue;
    }
    const over = overlays.find((o) => o.name === name);
    if (over?.launch && over.meta) {
      all.push(
        parseModuleDeclaration(
          { name: over.name, launch: over.launch, meta: over.meta } as ModuleDeclaration,
          "config(moduleOverlays)",
        ),
      );
    }
  }

  return all.map((d) => ({
    name: d.name,
    enabled: !disabled.includes(d.name),
    origin: d.meta.origin,
    satisfies: d.meta.satisfies,
    dependsOn: d.meta.dependsOn,
    scope: d.meta.scope,
    ...(d.meta.confinement ? { confinement: d.meta.confinement } : {}),
    placement: modulePlacement(d.meta, d.launch),
    launch: d.launch,
    removable: hasStoredDeclaration(overlays, d.name),
    // **「止めたら何が壊れるか」は返さない**（削除・2026-09-19）。
    // 以前は「私が名乗る役割に依存している Module」の一覧を返していたが、
    // **同じ役割の実装が他に残っていても壊れると読めてしまう**形だったので、
    // 画面がそのまま出して誤報になった。判断に要るのは `satisfies` と
    // `dependsOn` で足りる——導けるものを別の形で配らない（規則3）。
  }));
}

/** その宣言を banto 全体で止める／動かす。 */
export async function setModuleEnabled(
  config: RuntimeConfigStore,
  name: string,
  enabled: boolean,
): Promise<void> {
  const known = listInstanceModules(config).some((m) => m.name === name);
  if (!known) throw new ModuleDeclarationError(`知らない Module です: ${name}`);
  await updateInstanceOverlays(config, (overlays) => {
    const rest = overlays.filter((o) => o.name !== name);
    const existing = overlays.find((o) => o.name === name);
    if (enabled) {
      // 印だけの差分は残さない（空の印を記録に残さない）
      const { enabled: _drop, ...keep } = existing ?? { name };
      return keep.launch || keep.meta ? [...rest, keep as ModuleOverlay] : rest;
    }
    return [...rest, { ...(existing ?? { name }), enabled: false }];
  });
}

/** 宣言を1本足す。**同梱と同じ名前は使えない**（どちらを起動するか決まらない）。 */
export async function addModuleDeclaration(
  config: RuntimeConfigStore,
  declaration: ModuleDeclaration,
): Promise<void> {
  const parsed = parseModuleDeclaration(declaration, "addModuleDeclaration");
  if (listInstanceModules(config).some((m) => m.name === parsed.name)) {
    throw new ModuleDeclarationError(`その名前はもう使われています: ${parsed.name}`);
  }
  await updateInstanceOverlays(config, (overlays) => [
    ...overlays,
    { name: parsed.name, launch: parsed.launch, meta: declaration.meta },
  ]);
}

/**
 * **同梱の目録から1本入れる**（追加・2026-09-20、ユーザー決定）。
 *
 * 欲しいのは「Module を増やす」ことではなく**接続先を増やす**こと
 * （同じ Infisical の実装で、別のサーバ・別のアカウント）。置き場は
 * `${moduleDataDir}` で名前ごとに分かれるので、何本入れても混ざらない。
 *
 * **宣言を組み立てるのは host の仕事にする。** 画面に `satisfies` を
 * 組み立てさせると、**役割を自由に入力できる欄**が生まれる——貼り付けた JSON が
 * `vault-directory`（金庫の窓口）を名乗る経路が、画面から復活してしまう。
 * 目録からなら**banto が用意したものと同じ**しか作れない（`v4-security.md`）。
 */
export async function installFromCatalog(
  config: RuntimeConfigStore,
  id: string,
  name: string,
): Promise<void> {
  const entry = BUNDLED_CATALOG.find((e) => e.id === id);
  if (!entry) throw new ModuleDeclarationError(`知らない同梱 Module です: ${id}`);
  await addModuleDeclaration(config, { name, launch: entry.launch, meta: entry.meta });
}

/**
 * 宣言を1本消す。**既定は消せない**——コードにあるので、消しても戻ってくる
 * （無効にはできる）。
 *
 * **データは消さない**——その Module のデータ置き場も、Vault に置いた秘密も。
 * まとめて消すのは別の操作にする（取り返しがつかないので、別の確認を挟む）。
 */
export async function removeModuleDeclaration(config: RuntimeConfigStore, name: string): Promise<void> {
  // **一覧を読まずに決める**（改訂・2026-09-19）。消すのは「設定に書かれた宣言」
  // なので、設定を直接見れば足りる——そして**一覧が読めない状態でも消せる**
  // 必要がある（読めなくした宣言を消すのが、その状態からの唯一の出口・規則2）
  const overlays = (config.layerValue(MODULE_OVERLAYS_KEY, undefined) as ModuleOverlay[] | undefined) ?? [];
  if (!hasStoredDeclaration(overlays, name)) {
    if (DEFAULT_MODULE_DECLARATIONS.some((d) => d.name === name)) {
      // **消せないのではなく、消すものが無い**（宣言はコードの中にある）
      throw new ModuleDeclarationError(
        `${name} は banto に同梱されている既定なので、設定から消すものがありません（無効にはできます）`,
      );
    }
    throw new ModuleDeclarationError(`知らない Module です: ${name}`);
  }
  await updateInstanceOverlays(config, (rest) => rest.filter((o) => o.name !== name));
}

/**
 * **保存する前に、その差分で本当に読めるかを確かめる**（追加・2026-09-19）。
 *
 * 実際に踏んだ：窓口（`vault-directory`）を2本にする宣言が**保存できてしまい**、
 * その瞬間から一覧が読めなくなった——**消そうにも、消す口が一覧を読むので
 * 動かない**。設定を壊して二度と直せない状態を作っていた（規則2）。
 *
 * 検査は読むときと同じ（`loadModuleDeclarations` と同じ3つ）。**通らない差分は
 * 保存しない**ので、壊れた状態そのものが作れない。
 */
function assertOverlaysLoadable(overlays: readonly ModuleOverlay[]): void {
  const parsed = applyModuleOverlay(DEFAULT_MODULE_DECLARATIONS, overlays).map((d) =>
    parseModuleDeclaration(d, "config(moduleOverlays)"),
  );
  const names = new Set<string>();
  for (const d of parsed) {
    if (names.has(d.name)) {
      throw new ModuleDeclarationError(`Module 名が重複しています: ${d.name}`);
    }
    names.add(d.name);
  }
  assertSingletonRoles(parsed, "config(moduleOverlays)");
}

async function updateInstanceOverlays(
  config: RuntimeConfigStore,
  fn: (overlays: ModuleOverlay[]) => ModuleOverlay[],
): Promise<void> {
  const current = (config.layerValue(MODULE_OVERLAYS_KEY, undefined) as ModuleOverlay[] | undefined) ?? [];
  const next = fn([...current]);
  assertOverlaysLoadable(next);
  await config.setInstanceDefault(
    MODULE_OVERLAYS_KEY,
    next as unknown as Parameters<RuntimeConfigStore["setInstanceDefault"]>[1],
  );
}
