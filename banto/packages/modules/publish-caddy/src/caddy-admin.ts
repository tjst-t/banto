// Caddy の admin API（https://caddyserver.com/docs/api）に話す口。**差し替えられる穴**にしてある——
// host の Caddy の実物（admin の場所・Caddyfile との関係）はまだ確かめていない（docs/specs/v4-modules.md §4.3）。
//
// 使うのは admin API の決まった意味だけ（規則12）：
//   GET    /config/<path>   読む
//   PUT    /config/<path>   新しく作る。**配列の添字なら、その位置に差し込む**
//   PATCH  /config/<path>   あるものを置き換える
//   DELETE /config/<path>   消す
//   /id/<@id>/...           `@id` を付けたものを、場所を知らずに指す

import { request } from "node:http";

export interface CaddyAdmin {
  get(path: string): Promise<unknown>;
  put(path: string, body: unknown): Promise<void>;
  patch(path: string, body: unknown): Promise<void>;
  delete(path: string): Promise<void>;
}

export class CaddyAdminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * HTTP か Unix ソケット（`unix:/run/caddy/admin.sock`）で繋ぐ。Caddy の admin は既定で `localhost:2019`。
 * **本文を短く切って理由に入れる**——Caddy の断り文句（設定のどこが悪いか）が無いと直せない（規則2）
 */
export class HttpCaddyAdmin implements CaddyAdmin {
  private readonly target: { socketPath: string } | { host: string; port: number; base: string };

  constructor(adminUrl: string) {
    if (adminUrl.startsWith("unix:")) {
      this.target = { socketPath: adminUrl.slice("unix:".length) };
    } else {
      const u = new URL(adminUrl);
      if (u.protocol !== "http:") throw new CaddyAdminError(`Caddy の admin は http: か unix: で指してください（${adminUrl}）`);
      this.target = { host: u.hostname, port: Number(u.port || 80), base: u.pathname.replace(/\/$/, "") };
    }
  }

  private send(method: string, path: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          ...("socketPath" in this.target
            ? { socketPath: this.target.socketPath, path }
            : { host: this.target.host, port: this.target.port, path: this.target.base + path }),
          method,
          headers: {
            ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new CaddyAdminError(`Caddy が ${method} ${path} を断りました（${status}）：${text.trim().slice(0, 300)}`, status));
              return;
            }
            if (text.trim() === "") return resolve(undefined);
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new CaddyAdminError(`Caddy の返事が JSON ではありません（${method} ${path}）`));
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("10 秒で返事がありませんでした")));
      req.on("error", (err) => reject(new CaddyAdminError(`Caddy の admin に届きません（${method} ${path}）：${err.message}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  get(path: string): Promise<unknown> {
    return this.send("GET", path);
  }
  async put(path: string, body: unknown): Promise<void> {
    await this.send("PUT", path, body);
  }
  async patch(path: string, body: unknown): Promise<void> {
    await this.send("PATCH", path, body);
  }
  async delete(path: string): Promise<void> {
    await this.send("DELETE", path);
  }
}
