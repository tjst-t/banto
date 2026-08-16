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
   * @param options    `idempotent: true` を渡すと、送信後に起きた失敗
   *        （ECONNRESET・socket hang up）も再試行の対象になる（既定は off）。
   *        既定の呼び出しは何も書かなくてよい——書き方を変えずに動く（task-0235 a5）。
   */
  invoke(
    moduleName: string,
    toolName: string,
    args?: Record<string, unknown>,
    options?: ModuleInvokeOptions
  ): Promise<ModuleToolResult>;
  /** そのモジュールの到達先（診断用）。 */
  endpointOf(moduleName: string): string;
}

/** `ModuleClient.invoke` の呼び出しごとのオプション（task-0235）。 */
export interface ModuleInvokeOptions {
  /**
   * この呼び出しが冪等（同じ操作を二重に走らせても安全）だと呼び出し側が知っているとき
   * だけ `true` にする。既定は `false`——職人を起こす（spawn）ような呼び出しがここに
   * 乗っているため、既定で二重発火を許すわけにいかない。
   */
  idempotent?: boolean;
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

// ── 接続段だけの短い再試行（task-0235）───────────────────────────────────────
//
// 2026-08-16、worker-pool の OOM 再起動の最中に呼び出しが接続段で失敗し、タスクが
// 中身と無関係に failed になった（実測：failed の24〜47秒前に worker-pool の OOM）。
// 数十秒後には同じ操作が通っている——一瞬の途切れを、一度きりの例外で終わらせない。
//
// **既定をうんと小さく（1回・50ms後）に留めている。根拠は2つ：**
//   (a) このクライアントは Kobo の tick からも呼ばれる（例：gate-reeval が 200ms
//       ごとに `env.list` を叩く）。相手が落ちている間、呼び出し1本あたりの待ちを
//       伸ばすと、その間ずっと tick が詰まる——製品の話であって試験の都合ではない。
//       実際、既定を [100, 300, 900]（合計1.3秒）にしていたときは
//       `tests/acceptance/tick-jobs.spec.ts` が本当に落ちた（tickIntervalMs=200ms
//       に対し gate-reeval 1回だけで1.3秒待つようになり、間に合わなくなった）。
//   (b) 元の事故は OOM の+24〜47秒後に failed になっている。100+300+900msの
//       再試行では、どのみちこの停止を救えていない。短い再試行が本当に救えるのは
//       「ちょうどソケットの差し替えに当たった一瞬（数十ms）」だけ——これは停止
//       対策ではなく、一瞬の途切れだけを拾う保険に留める。
//
// **再試行してよいのは「要求が相手に届いていないと言い切れる」失敗だけ。**
//   - ECONNREFUSED / ENOTFOUND / EAI_AGAIN：接続確立そのものの失敗。相手は何も
//     受け取っていないので、再試行しても二重には走らない。既定で再試行する。
//   - ECONNRESET / socket hang up：**送ったあとにも起きる。** 相手が処理を始めて
//     から切れた場合、再試行すると同じ操作（職人を起こす spawn など、冪等でない
//     ものが乗る）が二度走りかねない。既定では再試行せず、呼び出し側が
//     `idempotent: true` を渡したときだけ対象にする（オプトイン、既定 off）。
//   - それ以外（ツール側のエラー応答・非2xx）は再試行の対象にしない——ここで
//     見るのは「相手に届いたかどうか」だけで、届いた先の結果は関知しない。

/** 接続確立段の失敗（相手に何も届いていないと言い切れる）。 */
const CONNECT_FAILURE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function isPostSendFailure(err: unknown): boolean {
  const code = errorCode(err);
  if (code === "ECONNRESET") return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("socket hang up");
}

/** 再試行してよい失敗なら理由を、してはいけない失敗なら `undefined` を返す。 */
function classifyRetryableFailure(err: unknown, idempotent: boolean): "connect" | "post-send" | undefined {
  const code = errorCode(err);
  if (code !== undefined && CONNECT_FAILURE_CODES.has(code)) return "connect";
  if (isPostSendFailure(err)) return idempotent ? "post-send" : undefined;
  return undefined;
}

/**
 * 接続段の再試行の最大回数（初回は含まない）。既定1回。
 *
 * 根拠：このクライアントは Kobo の tick（200msごと）からも呼ばれる。再試行を
 * 長く取ると、相手が落ちている間じゅう tick 側の待ちが伸びる——実測で
 * `tests/acceptance/tick-jobs.spec.ts` を壊した（詳細は上のコメント）。
 * また元の事故（OOM 再起動）は+24〜47秒後の復帰で、どんな短い再試行でも
 * 救えない停止だった。ここで拾えるのはソケット差し替えの一瞬（数十ms）だけで
 * 十分——だから1回・短い間隔に留める。`BANTO_MODULE_CONNECT_RETRY_ATTEMPTS` で変えられる。
 */
function connectRetryMaxAttempts(): number {
  const raw = process.env["BANTO_MODULE_CONNECT_RETRY_ATTEMPTS"];
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * 再試行の間隔（ms）。既定 [50]（合計待ち最大50ms）——ソケット差し替えの一瞬を
 * 拾うだけの短さに留める（上のコメント参照）。再試行回数が配列の長さを超えたら、
 * 最後の値を繰り返す。`BANTO_MODULE_CONNECT_RETRY_DELAYS_MS`（カンマ区切り）で変えられる。
 */
function connectRetryDelaysMs(): number[] {
  const raw = process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"];
  if (!raw) return [50];
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : [50];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    async invoke(moduleName, toolName, args = {}, options = {}) {
      const baseUrl = resolveModuleEndpoint(config, moduleName);
      const url = `${baseUrl.replace(/\/$/, "")}${MODULE_TOOL_PATH}${encodeURIComponent(toolName)}`;
      const idempotent = options.idempotent ?? false;
      const maxRetries = connectRetryMaxAttempts();
      const delays = connectRetryDelaysMs();

      let response: Awaited<ReturnType<ModuleFetch>>;
      let attempt = 0;
      for (;;) {
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ args } satisfies ModuleToolRequest),
          });
          if (attempt > 0) {
            // task-0235 a4: 再試行が起きたことを記録に残す（何回目で通ったか）
            console.warn(
              `[banto] module "${moduleName}" への接続が${attempt}回の再試行の後に成功しました`
            );
          }
          break;
        } catch (err) {
          const kind = classifyRetryableFailure(err, idempotent);
          if (kind === undefined || attempt >= maxRetries) {
            if (attempt > 0) {
              // task-0235 a4: 何回試して駄目だったかを記録に残す
              console.warn(
                `[banto] module "${moduleName}" への接続を${attempt}回再試行しましたが失敗しました: ${String(err)}`
              );
            }
            // I2: 到達できない相手を「結果なし」と混同しない
            throw new Error(`Failed to reach module "${moduleName}" at ${url}: ${String(err)}`);
          }
          const delay = delays[Math.min(attempt, delays.length - 1)] as number;
          console.warn(
            `[banto] module "${moduleName}" への接続に失敗（${kind}、${attempt + 1}回目）。` +
              `${delay}ms後に再試行します: ${String(err)}`
          );
          await sleep(delay);
          attempt += 1;
        }
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
