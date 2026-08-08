/**
 * モジュール間の呼び出しは、**返事を待つのに5分の上限を持たない**（inc-0036・task-0083）。
 *
 * **元の壊れ方**：既定の `fetch`（undici）は返事のヘッダを **300 秒しか待たない**
 * （`headersTimeout`）。`env.run` は検証コマンドそのもので10分かかるのが普通なのに、
 * 5分で切られていた。しかも落ち方が `TypeError: fetch failed` なので、
 * **検証が5分で切られたことが「モジュールに届かない」に化ける**。
 *
 * 実測（実機・番頭ホストと同じ fetch で `env.run(cmd="sleep 330")`）:
 *
 *   fetch FAILED after 301s: HeadersTimeoutError
 *
 * 実機のマージ前ゲートが実際にこれで落ちた（loamium/task-0005 の a4）:
 *
 *   [banto-gate] 検証環境でコマンドを走らせられませんでした:
 *   Failed to reach module "environment-pool" ...: TypeError: fetch failed
 *
 * **この穴は task-0079 まで表に出なかった**——それまで docker ドライバが全ての検証を
 * 120 秒で切っていたので、5分を超える呼び出しがそもそも存在しなかった。
 * 一つ塞ぐと次が見える、の典型。
 *
 * ここでは5分待たずに同じ形を見る：**undici の既定を明示的に短くした fetch** と
 * `longCallFetch` を、同じ「遅い相手」に当てて比べる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import { longCallFetch, createModuleClient } from "../../packages/banto-core/src/index.js";

/** 返事を遅らせるモジュール（本物の HTTP サーバ）。 */
let server: http.Server;
let baseUrl: string;
/** 返事までの待ち（ms）。テストごとに変える。 */
let delayMs = 0;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += String(c); });
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [], details: { echoed: JSON.parse(body || "{}") } }));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("[task-0083] モジュール呼び出しは長い返事を待てる", () => {
  it("**遅い相手でも待つ**（既定の fetch は5分で切るので、既定にしない）", async () => {
    delayMs = 1200;
    const client = createModuleClient({ modules: { slow: { baseUrl } } });
    const started = Date.now();
    const r = await client.invoke("slow", "env.run", { cmd: "sleep 600" });
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 1000, `待っていない（${elapsed}ms）——遅らせた意味がない`);
    assert.deepEqual((r.details as { echoed: unknown }).echoed, { args: { cmd: "sleep 600" } });
  });

  it("**上限を短くすると落ちる**（＝上限が実際に効いていることの裏取り）", async () => {
    delayMs = 3000;
    // `longCallFetch` の上限を 500ms にして、同じ相手に当てる。
    // これが落ちなければ「上限が無い」のではなく「上限を見ていない」ことになる
    const client = createModuleClient({ modules: { slow: { baseUrl } } }, longCallFetch(500));
    await assert.rejects(
      () => client.invoke("slow", "env.run", {}),
      /Failed to reach module|no response/,
      "無音の上限が効いていない——相手が死んでも永久に待つことになる"
    );
  });

  it("上限に達しなければ、遅くても通る（境界の確認）", async () => {
    delayMs = 800;
    const client = createModuleClient({ modules: { slow: { baseUrl } } }, longCallFetch(10_000));
    const r = await client.invoke("slow", "env.run", {});
    assert.ok(r.details);
  });

  it("**既定の fetch では同じ形が落ちる**（回帰の見張り）", async () => {
    delayMs = 1500;
    // `AbortSignal.timeout` で undici の headersTimeout と同じ「返事を待てない」形を作る。
    // 既定を標準 fetch に戻すと、実機では300秒でこれと同じことが起きる
    const shortFetch = ((url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(300) })) as never;
    const client = createModuleClient({ modules: { slow: { baseUrl } } }, shortFetch);
    await assert.rejects(
      () => client.invoke("slow", "env.run", {}),
      /Failed to reach module/,
      "返事を待てない相手は「届かない」として落ちる——実機ではこれが検証5分切れの正体だった"
    );
  });
});
