/**
 * Caddy の admin API に route を注入して公開する（ADR-0010 決定39・imp-0008）。
 *
 * **Palmux と同じ形**（`palmux2/internal/runtime/incus/caddy_admin.go`）。静的な Caddyfile を
 * 書き換えるのではなく admin API へ route を入れ、**安定した `@id` で冪等に upsert / delete**
 * する。ワイルドカード証明書と apex の認証は静的な Caddyfile 側に置く前提で、ここは
 * 「このホスト名をこのポートへ流す」だけを足す。
 *
 * **使える配置が限られる。** Caddy の admin API は既定でホストの localhost に閉じており
 * （Palmux も `admin localhost:2019`）、別のものが管理する箱の中で動いている banto からは
 * 届かない。**banto が自分の VM に常駐して Caddy を持つ配置**のためのもので、既定ではない。
 *
 * D6: fetch のみ（Caddy の SDK は入れない。HTTP+JSON で足りる）。
 * I2: admin API が失敗したら「公開した」と言わない。
 */

import type { EnvExposer, ExposeRequest, ExposedEnv } from "@banto/core";

export interface CaddyExposerOptions {
  /** admin API の場所（例 `http://localhost:2019`）。 */
  adminUrl: string;
  /**
   * 公開に使う土台のドメイン（例 `env.example.com`）。
   * `*.<baseDomain>` の DNS と証明書が用意されている前提。
   */
  baseDomain: string;
  /** Caddy から検証環境へ届くホスト名（既定 `127.0.0.1`）。 */
  upstreamHost?: string;
  /** テスト用の差し替え口。 */
  fetchImpl?: typeof fetch;
}

/** route を冪等に扱うための識別子。Palmux の `palmux-<inst>-<port>` と同じ考え方。 */
function routeId(envId: string): string {
  return `banto-env-${envId}`;
}

/** DNS に使える形へ均す。 */
function dnsLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function createCaddyExposer(options: CaddyExposerOptions): EnvExposer {
  const admin = options.adminUrl.replace(/\/$/, "");
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  const doFetch = options.fetchImpl ?? fetch;

  const hostFor = (envId: string, port: number): string =>
    `${port}--${dnsLabel(envId)}.${options.baseDomain}`;

  async function call(path: string, init?: RequestInit): Promise<Response> {
    const response = await doFetch(`${admin}${path}`, init);
    // I2: admin API の失敗は握りつぶさない。黙ると「公開したのに繋がらない」になる
    if (!response.ok && response.status !== 404) {
      const body = await response.text().catch(() => "");
      throw new Error(`Caddy admin API ${path} が ${response.status}: ${body.slice(0, 200)}`);
    }
    return response;
  }

  return {
    name: "caddy",

    async expose(request: ExposeRequest): Promise<ExposedEnv> {
      const host = hostFor(request.envId, request.port);
      const id = routeId(request.envId);

      // 冪等にするため、同じ id の route があれば先に消してから入れ直す
      await call(`/id/${id}`, { method: "DELETE" });

      const route = {
        "@id": id,
        match: [{ host: [host] }],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: `${upstreamHost}:${request.port}` }],
          },
        ],
        terminal: true,
      };

      // 既定のHTTPサーバの route 一覧の先頭へ入れる（apex の設定より先に当てる）
      await call("/config/apps/http/servers/srv0/routes/0", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route),
      });

      return { envId: request.envId, url: `https://${host}/`, port: request.port, exposer: "caddy" };
    },

    async unexpose(envId: string): Promise<void> {
      // 冪等：無ければ 404 が返るが、それは「既に取り下がっている」と同じ
      await call(`/id/${routeId(envId)}`, { method: "DELETE" });
    },

    async list(): Promise<ExposedEnv[]> {
      const response = await call("/config/apps/http/servers/srv0/routes");
      if (!response.ok) return [];
      const routes = (await response.json().catch(() => [])) as Array<Record<string, unknown>>;
      if (!Array.isArray(routes)) return [];

      const exposed: ExposedEnv[] = [];
      for (const route of routes) {
        const id = route["@id"];
        if (typeof id !== "string" || !id.startsWith("banto-env-")) continue;
        const match = (route["match"] as Array<{ host?: string[] }> | undefined)?.[0];
        const host = match?.host?.[0];
        if (!host) continue;
        const port = Number.parseInt(host.split("--")[0] ?? "", 10);
        exposed.push({
          envId: id.slice("banto-env-".length),
          url: `https://${host}/`,
          port: Number.isFinite(port) ? port : 0,
          exposer: "caddy",
        });
      }
      return exposed;
    },
  };
}
