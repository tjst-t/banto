/**
 * Environment Pool が自分の到達先の下で検証環境へ中継する（ADR-0010 決定39・imp-0008）。
 *
 * **どこでも動く既定**。新しい依存も DNS も TLS も要らず、banto が既に公開している
 * 1ポートの下、**このモジュールの到達先**（`/api/environment-pool/env/<envId>/`）に生える。
 * いまのように別のものが管理する箱の中で動いていて Caddy の admin API に届かない配置でも動く。
 *
 * **中継は Environment Pool の責務**（PO指摘）。banto-host に置くと、
 * (a) 検証環境へのトラフィックで Banto がブローカーになる（決定27 が避けたもの）、
 * (b) Environment Pool を独立サービスへ移す段（決定32a の2段目）で必ず移すことになる、
 * (c)「envId → ポート」の対応を台帳の外にもう1つ持つことになる（D3）、の3つが起きる。
 *
 * **banto を守っている認証をそのまま継承する**のが利点。モジュールの到達先は banto と
 * 同じ面に出ているので、画面に入れる人だけが検証環境にも届く——検証環境ごとに認証を
 * 用意しなくても、無認証で外に出る事故が構造的に起きない。
 *
 * 制約：パス配下に置くので、絶対パス（`/assets/...`）で資源を引くアプリは壊れることがある。
 * そこまで要るなら Caddy 実装（サブドメイン）を設定で有効化する——**だから口を分けてある**。
 *
 * D6: node:http のみ。
 * I2: 中継先が居ない・応答しないことを 200 で包まない。
 */

import * as http from "node:http";
import type { EnvExposer, ExposeRequest, ExposedEnv } from "@banto/core";

/** モジュールの到達先の下の入口。`{baseUrl}/env/<envId>/...` を受ける。 */
export const ENV_PROXY_PATH = "/env/";

export interface EnvProxyOptions {
  /**
   * このモジュールの到達先（例 `/api/environment-pool`）。URL を組み立てるのに使う。
   * モジュール定義の `baseUrl` と同じものを渡す。
   */
  baseUrl: string;
  /**
   * 外から見えるときの banto 自身の URL（例 `https://banto.example.com`）。
   * 省略すると相対パスを返す——同じ画面から開く分にはそれで足りる。
   */
  publicBaseUrl?: string;
  /** 中継先のホスト（既定 `127.0.0.1`）。 */
  targetHost?: string;
}

interface Exposure {
  envId: string;
  port: number;
}

export interface EnvProxy extends EnvExposer {
  /**
   * HTTP リクエストを捌く。対象外のパスなら false を返す（呼び出し側が次のルートへ回す）。
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createEnvProxyExposer(options: EnvProxyOptions): EnvProxy {
  const targetHost = options.targetHost ?? "127.0.0.1";
  const base = `${options.publicBaseUrl?.replace(/\/$/, "") ?? ""}${options.baseUrl.replace(/\/$/, "")}`;
  const prefix = `${options.baseUrl.replace(/\/$/, "")}${ENV_PROXY_PATH}`;
  // D3 の例外ではない——「いまどのポートへ流すか」は導出できない事実
  const exposures = new Map<string, Exposure>();

  const urlFor = (envId: string): string => `${base}${ENV_PROXY_PATH}${envId}/`;

  return {
    name: "banto-proxy",

    async expose(request: ExposeRequest): Promise<ExposedEnv> {
      exposures.set(request.envId, { envId: request.envId, port: request.port });
      return {
        envId: request.envId,
        url: urlFor(request.envId),
        port: request.port,
        exposer: "banto-proxy",
      };
    },

    async unexpose(envId: string): Promise<void> {
      // 冪等：無くても成功
      exposures.delete(envId);
    },

    async list(): Promise<ExposedEnv[]> {
      return [...exposures.values()].map((e) => ({
        envId: e.envId,
        url: urlFor(e.envId),
        port: e.port,
        exposer: "banto-proxy",
      }));
    },

    handle(req, res): boolean {
      const url = req.url ?? "";
      if (!url.startsWith(prefix)) return false;

      const rest = url.slice(prefix.length);
      const slash = rest.indexOf("/");
      const envId = slash === -1 ? rest : rest.slice(0, slash);
      const target = exposures.get(envId);
      if (!target) {
        // I2: 知らない環境を 404 で返す。黙って別のどこかへ流さない
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end(`環境 "${envId}" は公開されていません。\n`);
        return true;
      }

      // `/env/<id>` で来たらルート扱い。`/env/<id>/x` なら `/x`
      const path = slash === -1 ? "/" : rest.slice(slash) || "/";
      const upstream = http.request(
        {
          host: targetHost,
          port: target.port,
          method: req.method ?? "GET",
          path,
          headers: { ...req.headers, host: `${targetHost}:${target.port}` },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );

      upstream.on("error", (err) => {
        // I2: 中継先が居ないことを 200 で包まない。壊れているとすぐ分かる形で返す
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        }
        res.end(`検証環境へ中継できません（${target.port}）: ${err.message}\n`);
      });

      req.pipe(upstream);
      return true;
    },
  };
}
