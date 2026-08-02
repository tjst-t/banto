/**
 * 検証環境を外から見えるようにする（ADR-0010 決定39・imp-0008）。
 *
 * **公開の手段は配置で決まる**ので口を差し替え可能にした。ここで見たいのは、
 * (a) 既定の中継が実際に中身を返すこと、(b) 畳んだら必ず取り下がること、
 * (c) 公開できなかったときに環境だけ残らないこと。
 *
 * (b)(c) はどちらも I3——外に残ったものは費用であり、「畳んだつもり」が一番危ない。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  COLLECTED_PLACE_ID,
  EnvironmentPool,
  createCaddyExposer,
  createCollectedPlaceProvider,
  createEnvProxyExposer,
} from "@banto/environment-pool";
import { PlaceRegistry, assertWritable, resolveInPlace } from "@banto/host";
import type { EnvExposer } from "@banto/core";

// imp-0012: テスト用の一時 state に隔離（本番の /tmp/banto-process-driver-state.json を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-exposure.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

/** モジュールの到達先。中継はこの下に生える（決定27・39）。 */
const BASE = "/api/environment-pool";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-expose-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 中身を返す小さなサーバ（検証環境の代わり）。 */
async function serveOn(body: string): Promise<{ port: number; close(): void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => server.close() };
}

/** 中継を載せたホストを立てる。 */
async function hostWith(proxy: ReturnType<typeof createEnvProxyExposer>): Promise<{
  url: string;
  close(): void;
}> {
  const server = http.createServer((req, res) => {
    if (proxy.handle(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe("[決定39/b] 既定の中継は実際に中身を返す", () => {
  it("公開すると /env/<envId>/ で届き、取り下げると届かなくなる", async () => {
    const upstream = await serveOn("検証環境の中身");
    const proxy = createEnvProxyExposer({ baseUrl: BASE });
    const host = await hostWith(proxy);
    try {
      const exposed = await proxy.expose({ envId: "env-1", port: upstream.port });
      assert.equal(exposed.url, `${BASE}/env/env-1/`);
      assert.equal(exposed.exposer, "banto-proxy");

      const ok = await fetch(`${host.url}${BASE}/env/env-1/`);
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), "検証環境の中身");

      await proxy.unexpose("env-1");
      const gone = await fetch(`${host.url}${BASE}/env/env-1/`);
      // I2: 取り下げた後に別のどこかへ流さず、はっきり無いと返す
      assert.equal(gone.status, 404);
    } finally {
      host.close();
      upstream.close();
    }
  });

  it("中継先が居ないと 502。200 で包まない（壊れているとすぐ分かる）", async () => {
    const proxy = createEnvProxyExposer({ baseUrl: BASE });
    const host = await hostWith(proxy);
    try {
      // 誰も待っていないポートを指す
      await proxy.expose({ envId: "env-dead", port: 1 });
      const response = await fetch(`${host.url}${BASE}/env/env-dead/`);
      assert.equal(response.status, 502);
      assert.match(await response.text(), /中継できません/);
    } finally {
      host.close();
    }
  });

  it("unexpose は冪等（公開していないものへ呼んでも落ちない）", async () => {
    const proxy = createEnvProxyExposer({ baseUrl: BASE });
    await proxy.unexpose("env-知らない");
    assert.deepEqual(await proxy.list(), []);
  });

  it("公開URLの土台を設定すると絶対URLになる", async () => {
    const proxy = createEnvProxyExposer({ baseUrl: BASE, publicBaseUrl: "https://banto.example.com/" });
    const exposed = await proxy.expose({ envId: "env-2", port: 8080 });
    assert.equal(exposed.url, `https://banto.example.com${BASE}/env/env-2/`);
  });
});

describe("[決定39/d] 畳むときは公開も取り下げる（I3）", () => {
  it("teardown で公開が取り下がる", async () => {
    const proxy = createEnvProxyExposer({ baseUrl: BASE });
    const pool = new EnvironmentPool({ dataDir: dir, exposer: proxy, driverTimeoutMs: 20_000 });

    const created = await pool.provision({
      driver: "process",
      config: { cmd: "sleep 30" },
      expose: 4321,
    });
    assert.equal(created.url, `${BASE}/env/${created.envId}/`);
    assert.deepEqual((await proxy.list()).map((e: { envId: string }) => e.envId), [created.envId]);

    await pool.teardown(created.envId);
    assert.deepEqual(await proxy.list(), [], "畳んだら公開も消えること");
  });

  it("公開に失敗したら環境を残さない（畳んでから断る）", async () => {
    const broken: EnvExposer = {
      name: "壊れている",
      expose: async () => {
        throw new Error("公開先が居ません");
      },
      unexpose: async () => undefined,
      list: async () => [],
    };
    const pool = new EnvironmentPool({ dataDir: dir, exposer: broken, driverTimeoutMs: 20_000 });

    await assert.rejects(
      () => pool.provision({ driver: "process", config: { cmd: "sleep 30" }, expose: 1234 }),
      /外から見えるようにできませんでした/
    );
    // I3: 公開できなかったのに環境だけ動き続ける、が一番まずい
    assert.deepEqual(pool.list(), [], "生きた環境が残っていないこと");
  });

  it("公開の口が無いのに expose を頼まれたら断る", async () => {
    const pool = new EnvironmentPool({ dataDir: dir, driverTimeoutMs: 20_000 });
    assert.equal(pool.canExpose(), false);
    await assert.rejects(
      () => pool.provision({ driver: "process", config: { cmd: "sleep 30" }, expose: 1234 }),
      /口を持っていません/
    );
    assert.deepEqual(pool.list(), []);
  });
});

describe("[決定39/c] Caddy 実装（admin API を差し替えて見る）", () => {
  /** admin API の呼び出しを記録する偽物。 */
  function fakeCaddy(): { calls: Array<{ method: string; path: string; body?: string }>; impl: typeof fetch } {
    const calls: Array<{ method: string; path: string; body?: string }> = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        ...(init?.body ? { body: String(init.body) } : {}),
      });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("同じ @id で消してから入れ直す（冪等な upsert）", async () => {
    const caddy = fakeCaddy();
    const exposer = createCaddyExposer({
      adminUrl: "http://localhost:2019",
      baseDomain: "env.example.com",
      fetchImpl: caddy.impl,
    });

    const exposed = await exposer.expose({ envId: "env-abc", port: 5173 });
    assert.equal(exposed.url, "https://5173--env-abc.env.example.com/");

    assert.deepEqual(
      caddy.calls.map((c) => [c.method, c.path]),
      [
        ["DELETE", "/id/banto-env-env-abc"],
        ["PUT", "/config/apps/http/servers/srv0/routes/0"],
      ],
      "先に消してから入れること（二重登録を作らない）"
    );
    const body = JSON.parse(caddy.calls[1]!.body!) as {
      "@id": string;
      handle: Array<{ upstreams: Array<{ dial: string }> }>;
    };
    assert.equal(body["@id"], "banto-env-env-abc");
    assert.equal(body.handle[0]!.upstreams[0]!.dial, "127.0.0.1:5173");
  });

  it("取り下げは @id を消すだけ（冪等）", async () => {
    const caddy = fakeCaddy();
    const exposer = createCaddyExposer({
      adminUrl: "http://localhost:2019",
      baseDomain: "env.example.com",
      fetchImpl: caddy.impl,
    });
    await exposer.unexpose("env-abc");
    assert.deepEqual(caddy.calls, [{ method: "DELETE", path: "/id/banto-env-env-abc" }]);
  });

  it("admin API が失敗したら公開したことにしない", async () => {
    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const exposer = createCaddyExposer({
      adminUrl: "http://localhost:2019",
      baseDomain: "env.example.com",
      fetchImpl: failing,
    });
    await assert.rejects(() => exposer.expose({ envId: "env-x", port: 80 }), /Caddy admin API/);
  });
});

describe("[imp-0007 裁定] 回収した成果物は番頭が読める（が書けない）", () => {
  it("置き場所は機構が決め、番頭はパスを指定しない", async () => {
    const pool = new EnvironmentPool({ dataDir: dir, driverTimeoutMs: 20_000 });
    const created = await pool.provision({ driver: "process", config: { cmd: "sleep 30" } });

    const { dest } = await pool.collect(created.envId);
    // 呼び出し側は dest を渡していない——任意の絶対パスへ書ける穴を作らないため
    assert.ok(dest.startsWith(pool.collectedRoot()), "機構の管理下に置かれること");
    assert.ok(dest.includes(created.envId), "環境ごとに分かれること");
    assert.ok(fs.existsSync(dest));

    await pool.teardown(created.envId);
  });

  it("**回収先が読み取り専用の場所として出る**（読めないと回収の意味がない）", async () => {
    const pool = new EnvironmentPool({ dataDir: dir, driverTimeoutMs: 20_000 });
    const provider = createCollectedPlaceProvider(pool.collectedRoot());

    // まだ何も回収していないうちは場所として出さない（空の場所を並べない）
    assert.deepEqual(await provider.list(), []);

    const created = await pool.provision({ driver: "process", config: { cmd: "sleep 30" } });
    const { dest } = await pool.collect(created.envId);
    fs.writeFileSync(path.join(dest, "result.txt"), "検証の結果\n");

    const places = await provider.list();
    assert.equal(places.length, 1);
    assert.equal(places[0]!.id, COLLECTED_PLACE_ID);
    // 読めること：砦（PlaceRegistry）越しに実際に引く
    const registry = new PlaceRegistry([provider]);
    const place = await registry.require(COLLECTED_PLACE_ID);
    const read = fs.readFileSync(
      resolveInPlace(place, path.join(created.envId, "result.txt")),
      "utf-8"
    );
    assert.equal(read, "検証の結果\n");

    // 書けないこと：読み取り専用（writable を持たない）
    assert.equal(place.writable, undefined);
    assert.throws(
      () => assertWritable(place, path.join(created.envId, "勝手に書く.txt")),
      /読み取り専用/
    );

    await pool.teardown(created.envId);
  });
});
