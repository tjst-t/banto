/**
 * そのまま配る口（`file.raw`・spec-file-browser §5.8）。
 *
 * **見たいのは安全側の作りが実際に立っているか。** HTML を素のオリジンで配ると、
 * リポジトリの中の HTML が Banto のオリジンで動くスクリプトになり、
 * 同一オリジンの `/api/…`（`file.write` を含む）を POのセッションのまま叩ける
 * ——閲覧のための機能がそのまま書き込みの経路になる（§5.8.3）。
 *
 * 実物のファイルと実物の HTTP サーバで確かめる（モックしない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { PlaceRegistry, createStaticPlaceProvider } from "@banto/host";
import { createFileRawHandler } from "../../packages/banto-host/src/file-raw.js";

const BASE = "/api/workspace";

let root: string;
let server: http.Server;
let port: number;

interface Fetched {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function get(url: string, method = "GET"): Promise<Fetched> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method });
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()) as http.IncomingHttpHeaders,
    body: await res.text(),
  };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "banto-raw-"));
  fs.writeFileSync(path.join(root, "index.html"), "<h1>report</h1><script>1</script>");
  fs.writeFileSync(path.join(root, "notes.md"), "# 見出し\n本文\n");
  fs.writeFileSync(path.join(root, "danger.svg"), "<svg onload='alert(1)'></svg>");
  fs.writeFileSync(path.join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "style.css"), "body{}");

  const places = new PlaceRegistry([
    createStaticPlaceProvider([{ id: "demo", label: "デモ", path: root }]),
  ]);
  const handle = createFileRawHandler(places, BASE);

  server = http.createServer((req, res) => {
    if (handle(req, res)) return;
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("file.raw: そのまま配る", () => {
  it("テキストをそのまま返す", async () => {
    const res = await get(`${BASE}/raw/demo/notes.md`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^text\/plain/);
    assert.equal(res.body, "# 見出し\n本文\n");
  });

  it("パスは経路で表す（相対パスの資産が解決できる）", async () => {
    const res = await get(`${BASE}/raw/demo/sub/style.css`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "body{}");
  });

  it("画像は画像の型で返す", async () => {
    const res = await get(`${BASE}/raw/demo/shot.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "image/png");
  });

  it("?dl=1 は添付として返す", async () => {
    const res = await get(`${BASE}/raw/demo/notes.md?dl=1`);
    assert.match(String(res.headers["content-disposition"]), /^attachment;/);
    // 日本語のファイル名でもヘッダが割れないよう filename* を併記する
    assert.match(String(res.headers["content-disposition"]), /filename\*=UTF-8''/);
  });

  it("既定は inline", async () => {
    const res = await get(`${BASE}/raw/demo/notes.md`);
    assert.match(String(res.headers["content-disposition"]), /^inline;/);
  });
});

describe("file.raw: 安全側の作り（§5.8.3）", () => {
  it("HTML は text/html で配るが、**不透明なオリジンに閉じる**", async () => {
    const res = await get(`${BASE}/raw/demo/index.html`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /^text\/html/);

    const csp = String(res.headers["content-security-policy"]);
    assert.match(csp, /sandbox/, "sandbox が無いと Banto のオリジンで動く");
    // **これが本丸。** allow-same-origin が入った瞬間、リポジトリの中の HTML から
    // localStorage も /api/… も触れるようになる
    assert.doesNotMatch(csp, /allow-same-origin/, "allow-same-origin を付けてはいけない");
    // 中身は動いて見えてよい（不透明なオリジンなので Banto へは届かない）
    assert.match(csp, /allow-scripts/);
  });

  it("SVG は画像として配らない（スクリプトを持てるため）", async () => {
    const res = await get(`${BASE}/raw/demo/danger.svg`);
    assert.match(String(res.headers["content-type"]), /^text\/plain/);
  });

  it("型を推測させない（nosniff）", async () => {
    for (const file of ["notes.md", "index.html", "shot.png"]) {
      const res = await get(`${BASE}/raw/demo/${file}`);
      assert.equal(res.headers["x-content-type-options"], "nosniff", file);
    }
  });

  it("表に無い型は素のテキストに落ちる", async () => {
    fs.writeFileSync(path.join(root, "app.js"), "alert(1)");
    const res = await get(`${BASE}/raw/demo/app.js`);
    assert.match(String(res.headers["content-type"]), /^text\/plain/);
  });
});

describe("file.raw: 砦（I2）", () => {
  /**
   * 素の `../../` はブラウザが送る前に畳んでしまうので、砦を試すことにならない。
   * **符号化して送る**——経路の途中で復号する実装（ここもそう）は、畳まれずに
   * `..` を受け取る。これが実際に効く形の抜け道。
   */
  it("場所の外は弾く（符号化した `..` でも）", async () => {
    const res = await get(`${BASE}/raw/demo/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(res.status, 400);
    assert.match(res.body, /outside the workspace/);
  });

  it("未登録の場所は弾く", async () => {
    const res = await get(`${BASE}/raw/nope/notes.md`);
    assert.equal(res.status, 400);
  });

  it("無いファイルは 404（黙って空を返さない）", async () => {
    const res = await get(`${BASE}/raw/demo/missing.txt`);
    assert.equal(res.status, 404);
  });

  it("ディレクトリは索引にしない", async () => {
    const res = await get(`${BASE}/raw/demo/sub`);
    assert.equal(res.status, 400);
    assert.match(res.body, /directory/);
  });

  it("**読むだけの口**。書き込む動詞は通さない", async () => {
    const res = await get(`${BASE}/raw/demo/notes.md`, "POST");
    assert.equal(res.status, 405);
  });
});
