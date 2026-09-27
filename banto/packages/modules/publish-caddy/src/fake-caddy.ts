// **試験用の偽の Caddy**（admin API を HTTP で真似る）。本物の口（`HttpCaddyAdmin`）をそのまま繋いで試すため、
// 中身の差し替えではなく HTTP で立てる。真似るのは文書にある意味だけ（https://caddyserver.com/docs/api）：
//   PUT    配列の添字なら差し込む／オブジェクトなら新しく作る（あれば 409）
//   PATCH  あるものを置き換える（無ければ 404）
//   DELETE 消す（無ければ 404）
//   /id/<@id>/… は `@id` の付いたものを探して、そこから辿る
// 本物との違い（設定の検め・証明書・読み込み直しの挙動）は真似ていない——`reloadFromCaddyfile` は
// 「API で足したものが消える」の最悪の場合を作るだけ。

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Json = unknown;

export interface FakeCaddyRequest {
  method: string;
  path: string;
  body: string;
}

export class FakeCaddy {
  config: Record<string, unknown>;
  readonly requests: FakeCaddyRequest[] = [];
  /** true の間は繋がったらすぐ切る（admin に届かない） */
  down = false;
  private server?: Server;

  constructor(private readonly base: Record<string, unknown>) {
    this.config = structuredClone(base);
  }

  /** Caddyfile から読み込み直した——API で足したものは消える */
  reloadFromCaddyfile(): void {
    this.config = structuredClone(this.base);
  }

  routes(server = "srv0"): Record<string, unknown>[] {
    return (((this.config.apps as Record<string, Json>)?.http as Record<string, Json>)?.servers as Record<string, Record<string, unknown>>)[server]!
      .routes as Record<string, unknown>[];
  }

  writes(): FakeCaddyRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      void readBody(req).then((body) => {
        const path = req.url ?? "/";
        this.requests.push({ method: req.method ?? "", path, body });
        try {
          const out = this.handle(req.method ?? "GET", path, body);
          res.writeHead(200, { "content-type": "application/json" }).end(out === undefined ? "" : JSON.stringify(out));
        } catch (err) {
          const e = err as { status?: number; message: string };
          res.writeHead(e.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
        }
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private handle(method: string, url: string, body: string): Json {
    const segs = this.resolvePath(url);
    const value = body ? JSON.parse(body) : undefined;
    if (method === "GET") return lookup(this.config, segs);
    const parentSegs = segs.slice(0, -1);
    const key = segs[segs.length - 1]!;
    const parent = lookup(this.config, parentSegs) as Record<string, Json> | Json[];
    if (parent === undefined || parent === null) throw fail(404, `親がありません: ${url}`);
    if (method === "PUT") {
      if (Array.isArray(parent)) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i > parent.length) throw fail(400, `添字が範囲外: ${key}`);
        parent.splice(i, 0, value);
      } else {
        if (key in parent) throw fail(409, `もうあります: ${key}`);
        parent[key] = value;
      }
      return undefined;
    }
    const exists = Array.isArray(parent) ? Number(key) < parent.length : key in parent;
    if (!exists) throw fail(404, `ありません: ${url}`);
    if (method === "PATCH") {
      if (Array.isArray(parent)) parent[Number(key)] = value;
      else parent[key] = value;
      return undefined;
    }
    if (method === "DELETE") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      return undefined;
    }
    throw fail(405, method);
  }

  /** `/config/a/b` → [a,b]。`/id/<id>/rest` → その `@id` までの道＋rest */
  private resolvePath(url: string): string[] {
    const parts = url.split("?")[0]!.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] === "config") return parts.slice(1);
    if (parts[0] === "id") {
      const found = findId(this.config, parts[1]!, []);
      if (!found) throw fail(404, `unknown object ID '${parts[1]}'`);
      return [...found, ...parts.slice(2)];
    }
    throw fail(404, url);
  }
}

function fail(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function lookup(root: Json, segs: string[]): Json {
  let cur: Json = root;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(s)] : (cur as Record<string, Json>)[s];
  }
  return cur;
}

function findId(node: Json, id: string, path: string[]): string[] | undefined {
  if (node === null || typeof node !== "object") return undefined;
  if (!Array.isArray(node) && (node as Record<string, Json>)["@id"] === id) return path;
  const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v] as const) : Object.entries(node);
  for (const [k, v] of entries) {
    const hit = findId(v, id, [...path, k]);
    if (hit) return hit;
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/** banto を公開している host の Caddy に似せた設定（Caddyfile から読んだ形：server は srv0、まとめたルートが先にある） */
export function caddyfileLikeConfig(domain = "banto.example.net"): Record<string, unknown> {
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":443"],
            routes: [
              {
                match: [{ host: [domain] }],
                handle: [{ handler: "subroute", routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:4175" }] }] }] }],
                terminal: true,
              },
              {
                match: [{ host: [`*.${domain}`] }],
                handle: [{ handler: "static_response", status_code: 404 }],
                terminal: true,
              },
            ],
          },
        },
      },
    },
  };
}
