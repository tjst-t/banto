// Module の Canvas を隔離するサンドボックスの配信口（決定・2026-09-06、Phase 1）。
//
// **ここは守りそのもの**なので、「配れた」ではなく「**守りが効いている**」を見る。
// 公式仕様（MCP Apps 2026-01-26）は **Host と Sandbox が別オリジンであること**を
// 要求する——内側の iframe は `allow-same-origin` を持つが、そのオリジンが
// banto でなければ banto の cookie・localStorage・DOM には届かない。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createSandboxServer } from "./sandbox-server.js";

const EMBEDDERS = ["http://banto.tjstkm.net", "http://127.0.0.1:4175"];

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const server = createSandboxServer({ allowedEmbedderOrigins: EMBEDDERS });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("サンドボックスのページを配る", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/sandbox.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    // 中身は「内側のiframeを作って中継する」スクリプトを読むだけ
    assert.match(html, /sandbox\.js/);
  });
});

test("**埋め込めるのは決めた相手だけ**——frame-ancestors で縛る", async () => {
  await withServer(async (base) => {
    const csp = (await fetch(`${base}/sandbox.html`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors /);
    for (const origin of EMBEDDERS) {
      assert.ok(csp.includes(origin), `${origin} が frame-ancestors に無い`);
    }
    // 知らない相手は入っていない
    assert.ok(!csp.includes("evil.example"));
    // `*` で全部許してしまっていないこと（これをやると守りが消える）
    assert.ok(!/frame-ancestors[^;]*\*/.test(csp), "frame-ancestors に * がある");
  });
});

test("既定は最も厳しい CSP——Module が何も申告しなければ外に出られない", async () => {
  await withServer(async (base) => {
    const csp = (await fetch(`${base}/sandbox.html`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'none'/);
  });
});

test("Module が申告したドメインだけ、CSP に足す", async () => {
  await withServer(async (base) => {
    const declared = {
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    };
    const res = await fetch(`${base}/sandbox.html?csp=${encodeURIComponent(JSON.stringify(declared))}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.ok(csp.includes("https://api.example.com"), "connect に申告先が入っていない");
    assert.ok(csp.includes("https://cdn.example.com"), "resource に申告先が入っていない");
    // 申告していないものは入らない
    assert.ok(!csp.includes("https://other.example.com"));
  });
});

test("壊れた申告は**無視して厳しい既定に落とす**——緩い方へ倒れない（規則2）", async () => {
  await withServer(async (base) => {
    for (const bad of ["not-json", JSON.stringify({ connectDomains: "*" }), JSON.stringify(["x"])]) {
      const res = await fetch(`${base}/sandbox.html?csp=${encodeURIComponent(bad)}`);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /connect-src 'none'/, `壊れた申告(${bad})で緩くなっている`);
    }
  });
});

test("素性の怪しい申告は CSP に混ぜない（ディレクティブの注入を防ぐ）", async () => {
  await withServer(async (base) => {
    // `* 'unsafe-inline'` のように**空白を含む値**を書かれると、通してしまえば
    // 別のディレクティブを注入されたのと同じことになる
    const evil = JSON.stringify({
      connectDomains: ["* 'unsafe-inline'", "javascript:", "*"],
      frameDomains: ["' ; default-src *"],
    });
    const res = await fetch(`${base}/sandbox.html?csp=${encodeURIComponent(evil)}`);
    const csp = res.headers.get("content-security-policy") ?? "";

    // 申告は1つも通っていない＝既定の最も厳しい形のまま
    assert.match(csp, /connect-src 'none'/, "怪しい申告が connect に通った");
    assert.match(csp, /frame-src 'none'/, "怪しい申告が frame に通った");
    assert.ok(!csp.includes("javascript:"), "javascript: が混ざった");
    assert.ok(!/(^|; )default-src \*/.test(csp), "default-src が上書きされた");
    // `'unsafe-inline'` は script/style に**設計として**入る（公式の既定と同じ）。
    // 混ざってはいけないのは connect 側なので、そこだけを見る
    assert.ok(!/connect-src[^;]*unsafe-inline/.test(csp));
  });
});

test("知らない道は 404——この口では他に何も配らない", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/api/projects`)).status, 404);
  });
});
