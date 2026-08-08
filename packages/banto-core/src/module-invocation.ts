/**
 * モジュール間呼び出しの規約とクライアント（ADR-0010 決定27b）。
 *
 * モジュール同士が機能を呼び合うとき、接続・発見をペアごとに自作すると、モジュール数の
 * 増加に対して O(N²) の結合作業が発生する。そこでフレームワークが①レジストリ（誰がどこに
 * いるか）と②共通の呼び出し規約・クライアント実装を提供する。
 *
 * **ブローカー方式は採らない。** ここにあるのはライブラリであり、呼び出しは当事者間で
 * 直接行われる——Banto プロセスは経路に入らない。Banto をブローカーにすると単一障害点に
 * なり、Kobo が Banto の稼働に依存して ADR-0009・決定1 の依存の向きが逆転する。
 *
 * **呼び出しの単位は Tool 契約（決定9）。** 契約体系を2つ持たない。同じ Tool を番頭も
 * 他モジュールも呼ぶ（決定25「同じ能力に入口が複数あり、契約は1つ」の再適用）。
 * 番頭（AIエージェント）は経路に入らない。
 *
 * このモジュールが banto-core にあるのは、Kobo など **banto-host（pi 依存）に依存できない
 * 側からも使う**ため。ランタイム中立に保つ。
 *
 * D6: node:fs / node:http / node:https のみ。
 * I2: 未登録モジュール・未知Tool・非2xx応答は黙って空を返さずエラーにする。
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

// wire 契約は module-protocol.ts（node 非依存）にある。UI からも使うため分離している。
export {
  MODULE_TOOL_PATH,
  type ModuleToolRequest,
  type ModuleToolResult,
  type ModuleToolError,
} from "./module-protocol.js";
import { MODULE_TOOL_PATH } from "./module-protocol.js";
import type { ModuleToolRequest, ModuleToolResult, ModuleToolError } from "./module-protocol.js";

// ── レジストリ（宣言的な設定）─────────────────────────────────────────────────

/** 1モジュール分の接続情報。 */
export interface ModuleRegistryEntry {
  /**
   * 到達先。絶対URL（外部モジュール）または同一オリジンからの相対パス（組み込み）。
   * 相対パスは Node からは呼べないため、モジュール間呼び出しには絶対URLを設定する。
   */
  baseUrl: string;
}

/**
 * モジュールレジストリの設定。宣言的なファイルに置く（決定27b。既存の
 * `meta/config.yaml`・`meta/environments.yaml` と、決定19 の単一インストーラによる
 * 配線に揃える）。
 */
export interface ModuleRegistryConfig {
  modules: Record<string, ModuleRegistryEntry>;
}

/** 既定のレジストリファイル。BANTO_MODULE_REGISTRY で差し替えられる。 */
export function moduleRegistryPath(): string {
  return process.env["BANTO_MODULE_REGISTRY"] ?? "meta/modules.json";
}

/**
 * レジストリを読み込む。ファイルが無ければ空（モジュール間呼び出しを使わない構成）。
 * I2: 壊れた JSON・形の違う内容は黙って空にせずエラーにする。
 */
export function loadModuleRegistryConfig(filePath: string = moduleRegistryPath()): ModuleRegistryConfig {
  if (!fs.existsSync(filePath)) return { modules: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Invalid module registry at ${filePath}: ${String(err)}`);
  }
  const config = parsed as Partial<ModuleRegistryConfig>;
  if (config.modules === undefined || typeof config.modules !== "object") {
    throw new Error(`Invalid module registry at ${filePath}: missing "modules" object`);
  }
  for (const [name, entry] of Object.entries(config.modules)) {
    if (typeof entry?.baseUrl !== "string" || entry.baseUrl.length === 0) {
      throw new Error(`Invalid module registry at ${filePath}: module "${name}" has no baseUrl`);
    }
  }
  return { modules: config.modules };
}

/**
 * モジュール名から到達先を解決する。
 * I2: 未登録は黙って undefined を返さずエラーにする——呼び出し側が気づかないまま
 *     何も起きない状態を作らない。
 */
export function resolveModuleEndpoint(config: ModuleRegistryConfig, moduleName: string): string {
  const entry = config.modules[moduleName];
  if (!entry) {
    const known = Object.keys(config.modules).join(", ");
    throw new Error(`Unknown module "${moduleName}". Registered: ${known || "(none)"}`);
  }
  return entry.baseUrl;
}

// ── クライアント ─────────────────────────────────────────────────────────────

export interface ModuleClient {
  /**
   * 別のモジュールの Tool を呼ぶ。呼び出しは当事者間で直接行われ、Banto を経由しない。
   * @param moduleName レジストリに登録されたモジュール名
   * @param toolName   論理Tool名（例 `file.list`）
   */
  invoke(
    moduleName: string,
    toolName: string,
    args?: Record<string, unknown>
  ): Promise<ModuleToolResult>;
  /** そのモジュールの到達先（診断用）。 */
  endpointOf(moduleName: string): string;
}

/**
 * このクライアントが `fetch` に求める分だけの型。
 *
 * `typeof fetch` より狭いので、標準の `fetch` も下の `longCallFetch` も渡せる。
 * テストが偽物を差し込む口（`fetchImpl`）はそのまま。
 */
export type ModuleFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

/**
 * **返事を待つのに上限を置かない** HTTP クライアント（inc-0036・task-0083）。
 *
 * Node 標準の `fetch`（undici）は**返事のヘッダを 300 秒しか待たない**
 * （`headersTimeout` の既定）。これはモジュール間の呼び出しには短すぎる——
 * `env.run` は検証コマンドそのもので、10 分かかるのが普通（spec-environment §5.1 は
 * 既定10分・上限60分と定めている）。
 *
 * **この穴は task-0079 まで表に出なかった。** それまで docker ドライバが全ての検証を
 * 120 秒で切っていたので、5 分を超える呼び出しがそもそも存在しなかった。実測：
 *
 *   fetch FAILED after 301s: HeadersTimeoutError
 *
 * しかも落ち方が `TypeError: fetch failed` なので、**検証が5分で切られたことが
 * 「モジュールに届かない」に化ける**。実機でマージ前ゲートがこれで落ちた。
 *
 * undici の設定を触るには `dispatcher` が要るが、undici は Node から公開されていない
 * （npm 依存を足すのは D6 に反する）。標準ライブラリの `http` なら**既定で上限が無い**
 * ので、こちらに寄せる。
 *
 * 相手が死んだまま永久に待たないよう、ソケットの無音には上限を置く（既定65分＝
 * `maxRunTimeoutMs` の 60 分より少し長い。ここで先に切ると、正当な検証を殺す）。
 */
export function longCallFetch(idleTimeoutMs = 65 * 60_000): ModuleFetch {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === "https:" ? https : http;
      const req = transport.request(
        target,
        { method: init.method, headers: { ...init.headers, "Content-Length": Buffer.byteLength(init.body).toString() } },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { raw += chunk; });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              statusText: res.statusMessage ?? "",
              // I2: 壊れた本文を空オブジェクトに丸めない
              json: async () => JSON.parse(raw) as unknown,
            });
          });
        }
      );
      // **無音の上限**。返事を待つ上限ではなく、ソケットが黙り込んだときの保険
      req.setTimeout(idleTimeoutMs, () => {
        req.destroy(new Error(`no response for ${Math.round(idleTimeoutMs / 60000)} minutes`));
      });
      req.on("error", reject);
      req.write(init.body);
      req.end();
    });
}

/**
 * モジュール間呼び出しのクライアント。
 *
 * @param config レジストリ設定
 * @param fetchImpl テストで差し替えるための注入口。
 *        **既定は標準の `fetch` ではない**——5分で切られるため（→ `longCallFetch`）
 */
export function createModuleClient(
  config: ModuleRegistryConfig,
  fetchImpl: ModuleFetch = longCallFetch()
): ModuleClient {
  return {
    endpointOf: (moduleName) => resolveModuleEndpoint(config, moduleName),

    async invoke(moduleName, toolName, args = {}) {
      const baseUrl = resolveModuleEndpoint(config, moduleName);
      const url = `${baseUrl.replace(/\/$/, "")}${MODULE_TOOL_PATH}${encodeURIComponent(toolName)}`;

      let response: Awaited<ReturnType<ModuleFetch>>;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ args } satisfies ModuleToolRequest),
        });
      } catch (err) {
        // I2: 到達できない相手を「結果なし」と混同しない
        throw new Error(`Failed to reach module "${moduleName}" at ${url}: ${String(err)}`);
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as Partial<ModuleToolError>;
        throw new Error(
          `Module "${moduleName}" tool "${toolName}" failed (${response.status}): ${
            body.error ?? response.statusText
          }`
        );
      }
      return (await response.json()) as ModuleToolResult;
    },
  };
}
