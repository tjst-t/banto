/**
 * ビルド済みの WebUI を配る（task-0048）。
 *
 * **常駐させるために要る。** 開発中は vite の開発サーバ（:4200）が UI を出し、`/api` と
 * `/ws` をホストへ中継している。しかしサービスとして常駐させるとき、開発サーバを
 * 動かし続けるのは筋が悪い——ビルド済みの資産をホスト自身が配れば、**1プロセス・
 * 1ポート**で UI もAPIも揃う。前段（Caddy 等）で守るのもそのポート1つで済む。
 *
 * 資産が無ければ何もしない（開発中はそれでよい。vite が出す）。
 *
 * D6: node:fs / node:path のみ。
 * I2: 資産があるのに読めないことを 200 で包まない。
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/** 拡張子 → Content-Type。UI が必要とする分だけ持つ（D6：ライブラリを足さない）。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * ビルド済み資産を配るハンドラを作る。
 *
 * @param dir `packages/banto-web/dist` 等。無ければ常に false を返す（何も配らない）
 * @returns 配ったら true。対象外なら false（呼び出し側が次のルートへ回す）
 */
export function createWebAssetHandler(
  dir: string | undefined
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  const root = dir && fs.existsSync(path.join(dir, "index.html")) ? path.resolve(dir) : undefined;

  return (req, res) => {
    if (!root) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;

    const url = (req.url ?? "/").split("?")[0] ?? "/";
    // API・WS・検証環境への中継はこちらの持ち物ではない
    if (url.startsWith("/api") || url.startsWith("/ws") || url === "/health") return false;

    const requested = path.join(root, decodeURIComponent(url));
    const resolved = path.resolve(requested);
    // 資産の外へ出るパスは配らない（`..` で外を読ませない）
    const inside = resolved === root || resolved.startsWith(root + path.sep);

    // 画面の中の遷移は index.html へ返す（1ページのアプリなので）
    const file =
      inside && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : path.join(root, "index.html");

    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "Content-Length": body.length,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (err) {
      // I2: 資産があるのに読めないことを 200 で包まない
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`WebUI の資産を読めません: ${String(err)}\n`);
    }
    return true;
  };
}
