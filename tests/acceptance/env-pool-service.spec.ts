/**
 * task-0058: Environment Pool を独立サービスにする（ADR-0013 決定61）。
 *
 * **Kobo も Banto も起こさない。** 決定27b の呼び出し規約（`{baseUrl}/tools/{Tool名}`）
 * だけで、当事者間で直接呼べることを見る——これが成立しないと、Kobo が `env.*` を使うのに
 * 番頭ホストの稼働に依存し、決定27b が避けた依存の逆転が起きる。
 *
 * a5（組み込みモジュールとしての従来の使い方が壊れない）は既存の
 * `env-pool-tools.spec.ts` / `env-exposure.spec.ts` / `banto-host-server.spec.ts` が
 * 見張っているので、ここでは重ねない（D3：同じことを二度検査しない）。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  EnvironmentPool,
  EnvironmentPoolService,
  ENVIRONMENT_POOL_DEFAULT_BIND,
  ENVIRONMENT_POOL_DEFAULT_PORT,
  createEnvTools,
  createEnvProxyExposer,
  ENVIRONMENT_POOL_BASE_URL,
} from "@banto/environment-pool";
import { WORKER_POOL_DEFAULT_PORT } from "@banto/worker-pool";
import { createModuleClient } from "@banto/core";

// imp-0012: テスト用の一時 state に隔離（本番のドライバ state を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-pool-service.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let pool: EnvironmentPool;
let service: EnvironmentPoolService | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-pool-service-"));
  pool = new EnvironmentPool({ dataDir: path.join(dir, "data") });
});

afterEach(async () => {
  await service?.close();
  service = undefined;
  pool.stopMaintenance();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[task-0058/a1] 独立サービスとして env.* を公開する", () => {
  it("[task-0058/a1] Banto も Kobo も起こさずに env.* を呼べる", async () => {
    service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

    // 呼び出しは当事者間で直接。Banto は経路に入らない（決定27b）
    const client = createModuleClient({
      modules: { "environment-pool": { baseUrl: service.baseUrl } },
    });
    const result = await client.invoke("environment-pool", "env.list");

    assert.ok(result.content.length > 0, "結果が返る");
    assert.equal(pool.list().length, 0, "サービス経由でも同じ Pool を見ている");
  });

  it("[task-0058/a1] /health が公開している Tool を返す", async () => {
    service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

    const res = await fetch(`http://127.0.0.1:${service.port}/health`);
    const body = (await res.json()) as { ok: boolean; tools: string[] };

    assert.equal(body.ok, true);
    assert.ok(body.tools.includes("env.verify"), "高位の動詞が出る");
    assert.ok(body.tools.includes("env.provision"), "低位の動詞も出る");
  });

  it("[task-0058/a1] 未知の Tool は持っている Tool を添えて 404（I2）", async () => {
    service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });
    const client = createModuleClient({
      modules: { "environment-pool": { baseUrl: service.baseUrl } },
    });

    await assert.rejects(
      () => client.invoke("environment-pool", "env.nope"),
      /has no tool "env.nope".*env\.verify/s
    );
  });

  it("[task-0058/a1] POST 以外は 405（黙って握らない・I2）", async () => {
    service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

    const res = await fetch(`${service.baseUrl}/tools/env.list`, { method: "GET" });
    assert.equal(res.status, 405);
  });
});

describe("[task-0058/a2] 既定ポートが他のサービスと衝突しない", () => {
  it("[task-0058/a2] Kobo(3000) / Banto(4100) / Worker Pool(4300) のいずれとも違う", () => {
    assert.equal(ENVIRONMENT_POOL_DEFAULT_PORT, 4400);
    for (const taken of [3000, 4100, 4200, WORKER_POOL_DEFAULT_PORT]) {
      assert.notEqual(ENVIRONMENT_POOL_DEFAULT_PORT, taken);
    }
  });
});

describe("[task-0058/a3] 既定で 127.0.0.1 しか待ち受けない（決定40a）", () => {
  it("[task-0058/a3] 既定の待ち受けアドレスは 127.0.0.1", async () => {
    assert.equal(ENVIRONMENT_POOL_DEFAULT_BIND, "127.0.0.1");

    service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });
    assert.equal(service.host, "127.0.0.1", "明示しなければ閉じている");
  });

  it("[task-0058/a3] 外向きのアドレスからは届かない", async () => {
    service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });
    const port = service.port;

    // ループバック以外のアドレスを1つ探す。無い環境（コンテナ等）ではこの検査は飛ばす
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!external) return;

    await assert.rejects(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = net.connect({ host: external, port, timeout: 2000 });
          socket.on("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.on("timeout", () => {
            socket.destroy();
            reject(new Error("timeout"));
          });
          socket.on("error", reject);
        }),
      "127.0.0.1 に閉じているので外向きのアドレスでは繋がらない"
    );
  });
});

describe("[task-0058/a4] 検証環境への中継が独立プロセスでも生える（決定39b）", () => {
  /** 中継先として立てる、ただ答えるだけのサーバ。 */
  async function startUpstream(body: string): Promise<{ port: number; close(): Promise<void> }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return {
      port: address.port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("[task-0058/a4] 公開した環境へ {prefix}/env/<envId>/ で中継される", async () => {
    const upstream = await startUpstream("検証環境の中身");
    const proxy = createEnvProxyExposer({ baseUrl: ENVIRONMENT_POOL_BASE_URL });
    await proxy.expose({ envId: "env-1", port: upstream.port });

    service = await EnvironmentPoolService.start({
      tools: createEnvTools(pool),
      port: 0,
      proxy,
    });

    const res = await fetch(`${service.baseUrl}/env/env-1/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "検証環境の中身");

    await upstream.close();
  });

  it("[task-0058/a4] 公開していない環境は 404。黙って別のどこかへ流さない（I2）", async () => {
    const proxy = createEnvProxyExposer({ baseUrl: ENVIRONMENT_POOL_BASE_URL });
    service = await EnvironmentPoolService.start({
      tools: createEnvTools(pool),
      port: 0,
      proxy,
    });

    const res = await fetch(`${service.baseUrl}/env/env-unknown/`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /公開されていません/);
  });

  it("[task-0058/a4] 中継の対象外への upgrade は握らず切る（I2）", async () => {
    const proxy = createEnvProxyExposer({ baseUrl: ENVIRONMENT_POOL_BASE_URL });
    service = await EnvironmentPoolService.start({
      tools: createEnvTools(pool),
      port: 0,
      proxy,
    });

    const closed = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port: service!.port }, () => {
        socket.write(
          "GET /nowhere HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
        );
      });
      socket.on("close", () => resolve(true));
      socket.on("error", () => resolve(true));
      setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 2000);
    });

    assert.equal(closed, true, "開いたまま放置しない");
  });
});
