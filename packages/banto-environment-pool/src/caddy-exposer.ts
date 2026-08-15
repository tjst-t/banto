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

/** route を入れる先。スキームもここの待ち受けから読む（同じサーバを指す）。 */
const SERVER_PATH = "/config/apps/http/servers/srv0";

/**
 * 待ち受けの住所に 443 が含まれるか。
 *
 * Caddy の listen は `":443"` `"192.168.1.47:443"` `"tcp/:443"` `"[::1]:443"` `":440-450"`
 * のいろいろな形で書ける。末尾のポート（範囲なら区間）だけ見る。
 */
function listensOnTls(address: string): boolean {
  const withoutNetwork = address.replace(/^[a-z0-9]+\//i, ""); // `tcp/` `udp/` の接頭辞
  const colon = withoutNetwork.lastIndexOf(":");
  if (colon < 0) return false; // `unix//path` などポートを持たない形
  const [start, end] = withoutNetwork.slice(colon + 1).split("-");
  const from = Number.parseInt(start ?? "", 10);
  const to = end === undefined ? from : Number.parseInt(end, 10);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return from <= 443 && 443 <= to;
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

  /** config を1鍵だけ引く。鍵が無いとき Caddy は 200 で `null`、経路ごと無ければ 404。 */
  async function readConfig(path: string): Promise<unknown> {
    const response = await call(path);
    if (!response.ok) return undefined; // 404（call が通す唯一の非 200）
    return await response.json().catch(() => undefined);
  }

  /**
   * 案内する URL のスキームを、**実際の待ち受けから決める**（imp-0009 決めること3）。
   *
   * 以前は `https://` 決め打ちだった。この機械の Caddy は :80 しか待ち受けておらず
   * （静的な Caddyfile が `http://…` とスキームを明示＝自動HTTPSを切る設計）、
   * 番頭が案内した URL は必ず接続拒否になった。**443 を生やせば勝手に追随する**よう、
   * route を入れているのと同じサーバの listen と TLS 設定を読んで決める。
   *
   * 毎回読む——設定を変えたのに古いスキームを案内し続けないため（expose も list も
   * 頻度が低いので、admin API への GET 2本は無視できる）。
   */
  async function resolveScheme(): Promise<"http" | "https"> {
    const [listen, policies] = await Promise.all([
      readConfig(`${SERVER_PATH}/listen`),
      readConfig(`${SERVER_PATH}/tls_connection_policies`),
    ]);

    // TLS の方針が付いているなら、口が 443 でなくとも https で終端している
    if (Array.isArray(policies) && policies.length > 0) return "https";

    // I1: 読めなかったら「たぶん https」で名乗らない。開けない URL を配るくらいなら断る。
    // ここで断れば route はまだ入れていない＝取り残しも作らない
    if (!Array.isArray(listen) || listen.length === 0) {
      throw new Error(
        `Caddy admin API の ${SERVER_PATH}/listen を読めませんでした（返り値: ${JSON.stringify(listen)}）。` +
          "待ち受けが分からないので、案内できる URL のスキームを決められません。"
      );
    }

    return listen.some((a) => typeof a === "string" && listensOnTls(a)) ? "https" : "http";
  }

  return {
    name: "caddy",

    async expose(request: ExposeRequest): Promise<ExposedEnv> {
      const host = hostFor(request.envId, request.port);
      const id = routeId(request.envId);

      // **入れる前にスキームを決める**——名乗れない URL のために route を残さない
      const scheme = await resolveScheme();

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
      await call(`${SERVER_PATH}/routes/0`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route),
      });

      return {
        envId: request.envId,
        url: `${scheme}://${host}/`,
        port: request.port,
        exposer: "caddy",
      };
    },

    async unexpose(envId: string): Promise<void> {
      // 冪等：無ければ 404 が返るが、それは「既に取り下がっている」と同じ
      await call(`/id/${routeId(envId)}`, { method: "DELETE" });
    },

    async list(): Promise<ExposedEnv[]> {
      // expose と同じ規則で名乗る（片方だけ直しても、見る場所を変えれば嘘に戻る）
      const scheme = await resolveScheme();
      const response = await call(`${SERVER_PATH}/routes`);
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
          url: `${scheme}://${host}/`,
          port: Number.isFinite(port) ? port : 0,
          exposer: "caddy",
        });
      }
      return exposed;
    },
  };
}
