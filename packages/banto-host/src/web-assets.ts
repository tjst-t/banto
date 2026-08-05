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
 * ## 圧縮とキャッシュ（PO報告 2026-08-05：モバイル回線で開くのが遅い）
 *
 * 素で配ると本体の JS は約 490KB あり、**毎回まるごと落ちてくる**——圧縮も
 * キャッシュの指示も無かった。回線が細いとこれがそのまま待ち時間になる。
 *
 * - **圧縮**：`Accept-Encoding` に応じて brotli / gzip で返す。gzip で約 30%、
 *   brotli で約 26% まで縮む。**前段（Caddy 等）に任せない**——ここで返せば
 *   :4100 へ直に来る経路（開発・Tailscale 直結）でも同じだけ速くなる
 * - **キャッシュ**：`/assets/` の下は vite が内容ハッシュで名前を付けるので
 *   `immutable` で1年。**中身が変われば名前が変わる**から、古いものを掴み続ける事故は起きない。
 *   `index.html` だけは `no-cache`（＋ETag）——ここが更新の入口なので、
 *   新しいビルドに気づけなくなるのが一番困る
 * - **圧縮した結果は覚えておく**。内容ハッシュ付きの資産は変わらないので、
 *   要求のたびに圧縮し直す理由が無い（変わったかは mtime で見る）
 *
 * D6: node:fs / node:path / node:zlib / node:crypto のみ。
 * I2: 資産があるのに読めないことを 200 で包まない。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as zlib from "node:zlib";

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
 * 圧縮して意味のある種類。
 *
 * png / jpg / woff2 は既に圧縮済みで、掛け直しても縮まないうえ CPU だけ食う。
 */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

/** これより小さいものは圧縮しない（ヘッダの分で損をする）。 */
const MIN_COMPRESS_BYTES = 1024;

/**
 * brotli の強さ。**最強（11）は使わない。**
 *
 * 本体の JS（約 490KB）で実測（2026-08-05）:
 *
 * | 設定 | 大きさ | 圧縮にかかる時間 |
 * |---|---|---|
 * | q5  | 146KB（29.2%） | 14ms |
 * | q11 | 133KB（26.5%） | **1,024ms** |
 *
 * 差は 13KB。細い回線でも 0.1 秒ほどの違いにしかならないのに、**再起動後の最初の1人が
 * 1秒待たされる**（圧縮した結果は覚えるので、待つのは最初の1回だけ）。
 * 待ち時間を減らすためにやっているのに、待ち時間を作っては本末転倒なので 5 を採る。
 */
const BROTLI_QUALITY = 5;

/** 1つの資産の、読み込み済み・圧縮済みの姿。 */
interface CachedAsset {
  raw: Buffer;
  gzip?: Buffer;
  br?: Buffer;
  etag: string;
  mtimeMs: number;
}

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
  const assetsDir = root ? path.join(root, "assets") : undefined;
  /** 圧縮済みの写し。**mtime が変わったら捨てる**（ビルドし直したら作り直す）。 */
  const cache = new Map<string, CachedAsset>();

  const load = (file: string, ext: string): CachedAsset => {
    const stat = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit;

    const raw = fs.readFileSync(file);
    const asset: CachedAsset = {
      raw,
      etag: `"${createHash("sha1").update(raw).digest("base64url").slice(0, 20)}"`,
      mtimeMs: stat.mtimeMs,
    };
    if (COMPRESSIBLE.has(ext) && raw.length >= MIN_COMPRESS_BYTES) {
      asset.gzip = zlib.gzipSync(raw, { level: 9 });
      asset.br = zlib.brotliCompressSync(raw, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      });
    }
    cache.set(file, asset);
    return asset;
  };

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
      const ext = path.extname(file);
      const asset = load(file, ext);

      // `/assets/` の下は内容ハッシュ付き＝中身が変われば名前が変わる。だから長く持たせてよい。
      // それ以外（index.html）は毎回確かめる——ここが新しいビルドに気づく入口
      const hashed = assetsDir !== undefined && file.startsWith(assetsDir + path.sep);
      const cacheControl = hashed ? "public, max-age=31536000, immutable" : "no-cache";

      // 中身が同じなら本体を送らない（index.html の再訪が軽くなる）
      if (req.headers["if-none-match"] === asset.etag) {
        res.writeHead(304, { ETag: asset.etag, "Cache-Control": cacheControl });
        res.end();
        return true;
      }

      const accept = String(req.headers["accept-encoding"] ?? "");
      const encoded =
        asset.br && accept.includes("br")
          ? { body: asset.br, encoding: "br" }
          : asset.gzip && accept.includes("gzip")
            ? { body: asset.gzip, encoding: "gzip" }
            : { body: asset.raw, encoding: undefined };

      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Content-Length": encoded.body.length,
        "Cache-Control": cacheControl,
        ETag: asset.etag,
        // 同じ URL でも Accept-Encoding 次第で中身が変わる。中継のキャッシュに教える
        Vary: "Accept-Encoding",
        ...(encoded.encoding ? { "Content-Encoding": encoded.encoding } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : encoded.body);
    } catch (err) {
      // I2: 資産があるのに読めないことを 200 で包まない
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`WebUI の資産を読めません: ${String(err)}\n`);
    }
    return true;
  };
}
