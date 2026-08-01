/**
 * モジュールが自分の Tool を HTTP で公開する側（ADR-0010 決定27b）。
 *
 * banto-core の呼び出し規約（`{baseUrl}/tools/{論理Tool名}` への POST）を、
 * 登録済みモジュールの Tool 群に対して実装する。これがあることで、各モジュールは
 * 公開の口を自作せずに済む——O(N²) の結合作業を避ける狙いの実装側。
 *
 * 呼び手は2種類あるが契約は1つ（決定25・27b）：
 *   - UI（人の経路）：`details` の構造化データを読む
 *   - 他のモジュール：banto-core の ModuleClient から呼ぶ
 * 番頭（AIエージェント）はこの経路を通らない——番頭は Tool を直接実行する。
 *
 * D5: 判断は無い。Tool を引いて実行し、結果を JSON にするだけ。
 * I2: 未知のモジュール・未知のTool・実行時例外は、黙って空を返さず適切な status で返す。
 */

import type * as http from "node:http";
import { MODULE_TOOL_PATH, type ModuleToolRequest, type ModuleToolResult } from "@banto/core";
import type { ModuleRegistry } from "./module.js";

/**
 * 宣言された必須の引数のうち、渡されていないものを返す。
 *
 * 完全なスキーマ検証はしない——ここで見たいのは「呼び手が名前を間違えた／渡し忘れた」で、
 * それは必須の欠けとして現れる。型の細部まで見るなら検証器を足すことになるが、
 * いま要るのは**分かりにくい壊れ方を分かりやすい断りに変える**ことだけ（D6）。
 */
function missingRequired(parameters: unknown, args: unknown): string[] {
  const schema = (parameters ?? {}) as { required?: unknown };
  if (!Array.isArray(schema.required)) return [];
  const given = (args ?? {}) as Record<string, unknown>;
  return schema.required
    .filter((key): key is string => typeof key === "string")
    .filter((key) => given[key] === undefined);
}

/** ボディを読む。空ボディは `{}` として扱う。 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * モジュールの Tool を公開するリクエストハンドラを作る。
 *
 * 受けるパスは `{module.endpoint.baseUrl}/tools/{論理Tool名}`。登録済みモジュールの
 * baseUrl が相対パス（組み込みモジュール）である場合はそれをそのまま前置きとして使う。
 *
 * @returns 処理したら true。対象外のパスなら false（呼び出し側が次のルートへ回す）
 */
export function createModuleToolHandler(
  modules: ModuleRegistry
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = req.url ?? "";

    // モジュールが自分で捌く面（決定27b・39）。Tool の規約に乗らないパスはここで渡す。
    // ホストは経路を渡すだけで中身を解釈しない——Banto をブローカーにしない（決定27）
    for (const module of modules.list()) {
      if (!module.endpoint.baseUrl.startsWith("/")) continue;
      if (!url.startsWith(module.endpoint.baseUrl.replace(/\/$/, ""))) continue;
      if (module.serve?.(req, res)) return true;
    }

    // baseUrl が相対パスのモジュールだけがこのホストで公開される（決定25）
    const target = modules
      .list()
      .filter((m) => m.endpoint.baseUrl.startsWith("/"))
      .map((m) => ({ module: m, prefix: `${m.endpoint.baseUrl.replace(/\/$/, "")}${MODULE_TOOL_PATH}` }))
      .find(({ prefix }) => url.startsWith(prefix));

    if (!target) return false;

    if (req.method !== "POST") {
      sendJson(res, 405, { error: `use POST to invoke a tool (got ${req.method ?? "?"})` });
      return true;
    }

    const toolName = decodeURIComponent(url.slice(target.prefix.length).split("?")[0] ?? "");
    // internalTools（決定29e）もここには出す。番頭に渡さないだけで、公開の口では一続き
    const exposed = [...target.module.tools, ...(target.module.internalTools ?? [])];
    const tool = exposed.find((t) => t.name === toolName);
    if (!tool) {
      // I2: 未知のToolは黙って空を返さず、そのモジュールが持つToolを添えて 404
      const known = exposed.map((t) => t.name).join(", ");
      sendJson(res, 404, {
        error: `Module "${target.module.name}" has no tool "${toolName}". Available: ${known || "(none)"}`,
      });
      return true;
    }

    let body: ModuleToolRequest;
    try {
      body = (await readJsonBody(req)) as ModuleToolRequest;
    } catch (err) {
      sendJson(res, 400, { error: `invalid JSON body: ${String(err)}` });
      return true;
    }

    // I2: **必須の引数が欠けていたらここで断る。**
    //
    // 素通りさせると、欠けた値が実装の奥まで運ばれて、原因の分からない内部エラーとして
    // 出る——`worker.delegate` を `instruction` ではなく `instructions` で呼んだとき、
    // 職人は起きたのに pi が「Cannot read properties of undefined (reading 'startsWith')」
    // を返した（実際に踏んだ）。呼び手のtypoが、別の層の壊れ方に化けていた。
    const missing = missingRequired(tool.parameters, body?.args);
    if (missing.length > 0) {
      sendJson(res, 400, {
        error:
          `Tool "${toolName}" に必須の引数がありません: ${missing.join(", ")}。` +
          `受け取ったのは: ${Object.keys((body?.args ?? {}) as Record<string, unknown>).join(", ") || "(なし)"}`,
      });
      return true;
    }

    try {
      // 番頭は経由しない。Tool の実装をそのまま呼ぶ。
      const result = await tool.execute((body?.args ?? {}) as never, {
        toolCallId: `http-${Date.now()}`,
      });
      sendJson(res, 200, result as unknown as ModuleToolResult);
    } catch (err) {
      // I2: Tool の失敗を 200 で包まない。呼び手が成功と誤認しないようにする
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  };
}
