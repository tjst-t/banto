/**
 * Environment Pool の独立サービス（ADR-0013 決定61）。
 *
 * Environment Pool は Kobo からも Banto からも独立したサービス。決定27b の呼び出し規約
 * （`{baseUrl}/tools/{Tool名}` への POST）で自分の Tool を公開し、Banto も Kobo も
 * それぞれのクライアントになる——**呼び出しは当事者間で直接**で、Banto は経路に入らない。
 *
 * **なぜ独立プロセスが要るか**（決定61）：banto-host の中に置いたまま Kobo から叩くと、
 * Kobo が番頭の稼働に依存する。決定27b が「Banto が単一障害点になり、依存の向きが
 * 逆転する」として避けた状態そのものになるため。
 *
 * Worker Pool の `service.ts` と同じ形。違うのは2点だけ：
 *   1. **検証環境への中継**（決定39b）を自分の面に生やす（`{prefix}/env/<envId>/...`）。
 *      HTTP も WebSocket の upgrade も通す
 *   2. **既定で 127.0.0.1 しか待ち受けない**（決定40a）。Worker Pool の service は
 *      全インターフェースに出ているが、こちらは sops の復号鍵を持つため既定を閉じる
 *
 * D5: ここに判断は無い。Tool を引いて実行し、結果を JSON にするだけ。
 * D6: node:http のみ（フレームワーク依存なし）。
 * I2: 未知のTool・実行時例外は、黙って空を返さず適切な status で返す。
 */

import * as http from "node:http";
import { MODULE_TOOL_PATH } from "@banto/core";
import type { NamespacedToolDefinition } from "@banto/core";
import type { EnvProxy } from "./proxy-exposer.js";

/** 既定ポート。Kobo(3000) / Banto(4100) / Worker Pool(4300) と衝突しない値。 */
export const ENVIRONMENT_POOL_DEFAULT_PORT = 4400;

/** 既定の待ち受けアドレス（決定40a：認証を持たないので既定は閉じる）。 */
export const ENVIRONMENT_POOL_DEFAULT_BIND = "127.0.0.1";

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

export interface EnvironmentPoolServiceOptions {
  /** 公開する Tool（通常は `createEnvTools` の戻り値）。 */
  tools: NamespacedToolDefinition[];
  /** 待ち受けポート。0 を渡すと空きポートが割り当てられる（テスト用）。 */
  port?: number;
  /**
   * 待ち受けアドレス。既定は 127.0.0.1（決定40a）。
   * 広げるときは呼び出し側が明示し、警告を出すこと。
   */
  host?: string;
  /**
   * 公開パスの接頭辞。`{prefix}/tools/{Tool名}` を受ける。
   * 既定は `/api/environment-pool`（モジュール定義の baseUrl と揃える）。
   */
  pathPrefix?: string;
  /**
   * 検証環境への中継（決定39b）。渡すと `{prefix}/env/<envId>/...` が生える。
   * **中継はこのモジュールの責務**——組み込みで動くときは banto-host が同じ口を渡している。
   */
  proxy?: EnvProxy;
}

/**
 * Environment Pool のサービス。Banto も Kobo も起動せずに単体で立ち上がる。
 */
export class EnvironmentPoolService {
  private constructor(
    private readonly server: http.Server,
    private readonly prefix: string,
    /** 実際に指定された待ち受けアドレス（診断・テスト用）。 */
    readonly host: string
  ) {}

  static async start(options: EnvironmentPoolServiceOptions): Promise<EnvironmentPoolService> {
    const prefix = (options.pathPrefix ?? "/api/environment-pool").replace(/\/$/, "");
    const toolPrefix = `${prefix}${MODULE_TOOL_PATH}`;
    const host = options.host ?? ENVIRONMENT_POOL_DEFAULT_BIND;
    const proxy = options.proxy;

    const server = http.createServer((req, res) => {
      void (async () => {
        const url = req.url ?? "";

        if (req.method === "GET" && url === "/health") {
          sendJson(res, 200, { ok: true, tools: options.tools.map((t) => t.name) });
          return;
        }

        // 検証環境への中継（決定39b）。Tool のルートより先に見る——中継のパスは
        // モジュール側の都合で決まり、ホストは経路を渡すだけで中身を解釈しない
        if (proxy?.handle(req, res)) return;

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
          // I2: 未知の Tool は黙って空を返さず、持っている Tool を添えて返す
          const known = options.tools.map((t) => t.name).join(", ");
          sendJson(res, 404, {
            error: `Environment Pool has no tool "${toolName}". Available: ${known || "(none)"}`,
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

    // WebSocket の upgrade も中継する（決定39b）。捌けなければ黙って握らず切る——
    // 開いたままにすると相手は「応答が無い」としか分からない（I2）
    if (proxy) {
      server.on("upgrade", (req, socket, head) => {
        if (!proxy.handleUpgrade(req, socket as never, head)) socket.destroy();
      });
    }

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? ENVIRONMENT_POOL_DEFAULT_PORT, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return new EnvironmentPoolService(server, prefix, host);
  }

  /** 実際に待ち受けているポート。 */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("EnvironmentPoolService is not listening on a TCP port");
    }
    return address.port;
  }

  /** 他のモジュールがこのサービスへ到達するための URL（レジストリに登録する値）。 */
  get baseUrl(): string {
    return `http://${this.host === "0.0.0.0" ? "localhost" : this.host}:${this.port}${this.prefix}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
