/**
 * Worker Pool の独立サービス（ADR-0010 決定23・27b・27c）。
 *
 * Worker Pool は Kobo からも Banto からも独立したサービス。決定27b の呼び出し規約
 * （`{baseUrl}/tools/{Tool名}` への POST）で自分のToolを公開し、Banto も Kobo も
 * それぞれのクライアントになる——**呼び出しは当事者間で直接**で、Banto は経路に入らない。
 *
 * D5: ここに判断は無い。Tool を引いて実行し、結果を JSON にするだけ。
 * D6: node:http のみ（フレームワーク依存なし。Kobo の http-server と同じ流儀）。
 * I2: 未知のTool・実行時例外は、黙って空を返さず適切な status で返す。
 */

import * as http from "node:http";
import { MODULE_TOOL_PATH } from "@banto/core";
import type { NamespacedToolDefinition } from "@banto/core";

/** 既定ポート。Kobo(4500) / Banto(4100) と衝突しない値。 */
export const WORKER_POOL_DEFAULT_PORT = 4300;

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export interface WorkerPoolServiceOptions {
  /** 公開するTool（通常は createWorkerTools の戻り値）。 */
  tools: NamespacedToolDefinition[];
  /** 待ち受けポート。0 を渡すと空きポートが割り当てられる（テスト用）。 */
  port?: number;
  /**
   * 待ち受けるアドレス（決定40）。**既定は 127.0.0.1**。
   *
   * この面は**任意のディレクトリで任意のコマンドを実行できる職人**を起こせるので、
   * 認証を持たないまま外へ出さない。広げるのは明示のときだけ。
   */
  host?: string;
  /**
   * 公開パスの接頭辞。`{prefix}/tools/{Tool名}` を受ける。
   * 既定は `/api/worker-pool`（モジュール定義の baseUrl と揃える）。
   */
  pathPrefix?: string;
}

/**
 * Worker Pool のサービス。Banto も Kobo も起動せずに単体で立ち上がる。
 */
export class WorkerPoolService {
  private constructor(
    private readonly server: http.Server,
    private readonly prefix: string
  ) {}

  static async start(options: WorkerPoolServiceOptions): Promise<WorkerPoolService> {
    const prefix = (options.pathPrefix ?? "/api/worker-pool").replace(/\/$/, "");
    const toolPrefix = `${prefix}${MODULE_TOOL_PATH}`;

    const server = http.createServer((req, res) => {
      void (async () => {
        const url = req.url ?? "";

        if (req.method === "GET" && url === "/health") {
          sendJson(res, 200, { ok: true, tools: options.tools.map((t) => t.name) });
          return;
        }
        if (!url.startsWith(toolPrefix)) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: `use POST to invoke a tool (got ${req.method ?? "?"})` });
          return;
        }

        const toolName = decodeURIComponent(url.slice(toolPrefix.length).split("?")[0] ?? "");
        const tool = options.tools.find((t) => t.name === toolName);
        if (!tool) {
          // I2: 未知のToolは黙って空を返さず、持っているToolを添えて返す
          const known = options.tools.map((t) => t.name).join(", ");
          sendJson(res, 404, {
            error: `Worker Pool has no tool "${toolName}". Available: ${known || "(none)"}`,
          });
          return;
        }

        let body: { args?: Record<string, unknown> };
        try {
          body = (await readJsonBody(req)) as { args?: Record<string, unknown> };
        } catch (err) {
          sendJson(res, 400, { error: `invalid JSON body: ${String(err)}` });
          return;
        }

        try {
          const result = await tool.execute((body?.args ?? {}) as never, {
            toolCallId: `http-${Date.now()}`,
          });
          sendJson(res, 200, result);
        } catch (err) {
          // I2: Tool の失敗を 200 で包まない
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      })().catch((err: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? WORKER_POOL_DEFAULT_PORT, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return new WorkerPoolService(server, prefix);
  }

  /** 実際に待ち受けているポート。 */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("WorkerPoolService is not listening on a TCP port");
    }
    return address.port;
  }

  /** 他のモジュールがこのサービスへ到達するためのURL（レジストリに登録する値）。 */
  get baseUrl(): string {
    return `http://localhost:${this.port}${this.prefix}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
