/**
 * ファイルをそのまま配る口（spec-file-browser §5.8・PO要望 2026-08-08）。
 *
 * `file.read` は構造化データ（行・上限・切り取り）を返す Tool で、**バイトをそのまま
 * 渡す役はできない**。別タブで開く・HTML を静的配信する・画像を出す・ダウンロードする
 * ——この4つはどれも「バイトをそのまま」を要るので、口を1つだけ足してまとめて載せる。
 *
 * ```
 * GET {baseUrl}/raw/{place}/{path…}         そのまま（inline）
 * GET {baseUrl}/raw/{place}/{path…}?dl=1    ダウンロード（attachment）
 * ```
 *
 * **パスはクエリではなく経路で表す。** HTML の中の相対パス（`./style.css`・`img/a.png`）は
 * ブラウザが URL から解決するので、クエリに押し込むと資産が全部 404 になる。
 *
 * D5: 判断は無い。場所を解決し、砦を通し、型を決めて流すだけ。
 * D3: 場所の解決とパスの正規化は `file.*` Tool と同じ実装（`places` / `resolveInWorkspace`）を
 *     通す。ここだけ別の判定を書くと、Tool で塞いだ穴がこちらで開く。
 * I2: 範囲外・不在・ディレクトリは黙って空を返さず、status と理由を返す。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";
import type { PlaceRegistry } from "./places.js";
import { resolveInWorkspace } from "./workspace.js";

/** 経路の接頭辞。`{baseUrl}` の後ろに付く。 */
export const RAW_PATH = "/raw/";

/**
 * 拡張子 → Content-Type の**許可表**（spec-file-browser §5.8.2）。
 *
 * **表に無いものは `text/plain`。** 中身から型を推測（sniff）しない——推測は
 * 「テキストのつもりで置いたものが実行される」経路になる。
 *
 * **HTML の連れ（css / js / font / json）は表に載せる**（PO報告 2026-08-09：
 * 「同じフォルダから配信する CSS が当たらない」）。`nosniff` を付けている以上、
 * `text/plain` で配った `.css` はブラウザが**意匠として使うことを拒む**——「HTML を
 * 静的配信扱いにする」（§5.8 の PO要望②）は、連れが載っていないと成り立たない。
 * 危険は増えない：スクリプトが動くのは §5.8.3 の不透明なオリジンの中だけで、
 * そこでは**元から inline の `<script>` が動く**。外に置いた `.js` を拒む理由が無い。
 *
 * `svg` は**変わらず画像として配らない**——SVG は `<script>` を持て、`<img>` の連れとしてだけ
 * でなく**それ自体を文書として開ける**。ここを緩めるのは §5.8.3 の隔離に触る決めなので D1。
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

const TEXT_FALLBACK = "text/plain; charset=utf-8";

/**
 * 文書として開かれうる型（HTML・PDF）。
 *
 * **`allow-same-origin` を付けない。** 付けないと文書は不透明なオリジンになり、
 * Banto の `localStorage`・Cookie・同一オリジンの `/api/…`（`file.write` を含む）に
 * 届かない。付けてしまうと、リポジトリの中の HTML——外から取り込んだもの・職人が
 * 生成したもの・依存の中の一枚——が **Banto のオリジンで動くスクリプト**になり、
 * 閲覧のための機能がそのまま書き込みの経路になる（spec-file-browser §5.8.3）。
 *
 * `allow-scripts` は付ける（中身が動いて見えないと静的配信の意味がない）。不透明な
 * オリジンなので、動いても Banto へは届かない。PDF はブラウザ内蔵の表示器が
 * スクリプトで動くため同じ扱いにする。
 */
const DOCUMENT_SANDBOX = "sandbox allow-scripts allow-popups";
/** それ以外（画像・素のテキスト）。動かす必要が無いので、いちばん強く閉じる。 */
const INERT_SANDBOX = "sandbox";

function extensionOf(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 拡張子から型を決める。表に無ければ素のテキスト。 */
export function contentTypeOf(filePath: string): string {
  return CONTENT_TYPES[extensionOf(filePath)] ?? TEXT_FALLBACK;
}

/** 文書として開かれうる型か（sandbox の強さを決める）。 */
export function isDocumentType(contentType: string): boolean {
  return contentType.startsWith("text/html") || contentType.startsWith("application/pdf");
}

/**
 * `Content-Disposition` の値。
 *
 * 名前は**そのまま埋めない**——`"` と改行が入るとヘッダが割れる。ASCII に落とした控えと、
 * RFC 5987 の `filename*` の両方を出す（日本語のファイル名がある）。
 */
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function fail(res: http.ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 経路を「場所の id」と「その中の相対パス」に割る。
 *
 * 場所の id は `/` を含みうる（ghq 由来など）ので、**1つ目の区切りまでを id とし、
 * 呼ぶ側は `encodeURIComponent` で寄越す**。`req.url` は復号されないまま届くので、
 * ここで初めて解く。
 */
function splitTarget(rest: string): { place: string; path: string } | undefined {
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const place = decodeURIComponent(rest.slice(0, slash));
  const rel = decodeURIComponent(rest.slice(slash + 1));
  if (place.length === 0 || rel.length === 0) return undefined;
  return { place, path: rel };
}

/**
 * `{baseUrl}/raw/…` を捌くハンドラを作る。`BantoModule.serve` にそのまま渡す。
 *
 * @returns 受け持った（＝このパスだった）なら true。呼び出し側は次のルートへ回さない
 */
export function createFileRawHandler(
  places: PlaceRegistry,
  baseUrl: string
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  const prefix = `${baseUrl.replace(/\/$/, "")}${RAW_PATH}`;

  return (req, res) => {
    const url = req.url ?? "";
    if (!url.startsWith(prefix)) return false;

    // 受け持つと決めた時点で true を返す。中身は非同期に書く
    void serve(req, res, places, prefix, url);
    return true;
  };
}

async function serve(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  places: PlaceRegistry,
  prefix: string,
  url: string
): Promise<void> {
  try {
    // **読むだけの口。** 書き込む動詞をここに生やさない（spec-file-browser §5.8.1）
    if (req.method !== "GET" && req.method !== "HEAD") {
      fail(res, 405, `use GET to read a file (got ${req.method ?? "?"})`);
      return;
    }

    const [rawPath = "", query = ""] = url.slice(prefix.length).split("?", 2);
    const target = splitTarget(rawPath);
    if (!target) {
      fail(res, 400, `expected ${prefix}{place}/{path}`);
      return;
    }

    // 場所の解決は Tool と同じ帳簿を通す（未登録ならここで止まる）
    const place = await places.resolve(target.place);
    // 砦も Tool と同じ（リンクを解いてから範囲を判定する）
    const absolute = resolveInWorkspace(place.path, target.path);

    const stat = await fs.promises.stat(absolute).catch(() => undefined);
    if (!stat) {
      fail(res, 404, `No such file: ${target.path}`);
      return;
    }
    if (stat.isDirectory()) {
      // I2: ディレクトリを黙って索引にしない。一覧は file.list の役
      fail(res, 400, `"${target.path}" is a directory. Use file.list to see what is inside.`);
      return;
    }

    const type = contentTypeOf(absolute);
    const download = new URLSearchParams(query).get("dl") !== null;

    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      // 推測させない。表に無いものを text/plain に落とす意味がなくなる
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": isDocumentType(type) ? DOCUMENT_SANDBOX : INERT_SANDBOX,
      // 場所の中身は POごとのもの。共有のキャッシュに載せない
      "Cache-Control": "private, no-cache",
      "Content-Disposition": disposition(
        download ? "attachment" : "inline",
        path.basename(absolute)
      ),
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    // 大きいファイルを丸ごとメモリに載せない（`file.read` の上限はここには効かない）
    const stream = fs.createReadStream(absolute);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    // I2: 範囲外（砦）・未登録の場所は理由を返す。黙って 404 にしない
    if (res.headersSent) {
      res.destroy();
      return;
    }
    fail(res, 400, err instanceof Error ? err.message : String(err));
  }
}
