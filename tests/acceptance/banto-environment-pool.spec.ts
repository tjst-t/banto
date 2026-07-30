/**
 * task-0033: Environment Pool（動作検証環境）。ADR-0010 決定32。
 *
 * **Kobo も Banto も起動せずに検証する**（受け入れ条件 a3）——これ自体が
 * 「Environment Pool は独立したモジュールで単体で成立する」ことの証明になる。
 * 参照するのは `@banto/environment-pool` だけで、`@banto/daemon` は import しない。
 *
 * 本タスクは切り出しのみで振る舞いを変えない（決定32a の1段目）。個々のドライバの
 * 契約は `env-driver-contract.spec.ts` 等が既に見ているので、ここで見たいのは
 * **モジュールとしての独立性**——同梱ドライバが自分の中に在り、runner で回せ、
 * 台帳が Kobo 抜きで機能すること。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import {
  BUILTIN_ENV_DRIVERS,
  DEFAULT_DRIVER_TIMEOUT_MS,
  EnvLedger,
  countLiveByProfile,
  resolveCredentialsPath,
  resolveDriverPath,
  runDriverVerb,
} from "@banto/environment-pool";
import type { EnvLedgerEntry } from "@banto/environment-pool";
import type { EnvHandle, ProvisionOutput, HealthcheckOutput } from "@banto/core";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-envpool-"));
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<EnvLedgerEntry> = {}): EnvLedgerEntry {
  return {
    envId: "env-1",
    projectTag: "test",
    taskId: "task-0001",
    profileName: "default",
    driver: "process",
    handle: { pid: 1 } as EnvHandle,
    createdAt: new Date().toISOString(),
    ttlDeadline: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("no address")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

describe("[task-0033/a1] Kobo に依存しない", () => {
  it("[task-0033/a1] 依存は @banto/core だけ（Kobo を引かない）", () => {
    const pkgPath = new URL(
      "../../packages/banto-environment-pool/package.json",
      import.meta.url
    ).pathname;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});

    // 依存の向きが逆転すると「独立したモジュール」が名前だけになる（決定32a）
    assert.ok(!deps.includes("@banto/daemon"), `Kobo に依存している: ${deps.join(", ")}`);
    assert.deepEqual(deps, ["@banto/core"]);
  });

  it("[task-0033/a1] 実装コードが Kobo を import しない", () => {
    const srcDir = new URL("../../packages/banto-environment-pool/src/", import.meta.url).pathname;
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const source = fs.readFileSync(path.join(srcDir, file), "utf8");
      assert.ok(
        !/from\s+["']@banto\/daemon["']/.test(source),
        `${file} が @banto/daemon を import している`
      );
    }
  });
});

describe("[task-0033/a1] 同梱ドライバはこのモジュールの中に在る", () => {
  it("[task-0033/a1] 組み込みドライバの実体が Environment Pool の中に解決される", () => {
    for (const name of BUILTIN_ENV_DRIVERS) {
      const resolved = resolveDriverPath(name);
      assert.ok(
        resolved.includes(`${path.sep}banto-environment-pool${path.sep}`),
        `${name} が Environment Pool の外を指している: ${resolved}`
      );
      // Kobo に置き去りになっていないこと（切り出しの取りこぼしはここで出る）
      assert.ok(
        !resolved.includes("banto-daemon"),
        `${name} がまだ Kobo を指している: ${resolved}`
      );
      assert.ok(fs.existsSync(resolved), `実体が無い: ${resolved}`);
    }
  });

  it("[task-0033/a1] 組み込み以外はパスとしてそのまま扱う", () => {
    assert.equal(resolveDriverPath("/opt/my-driver.ts"), "/opt/my-driver.ts");
  });
});

describe("[task-0033/a1] Kobo 抜きで環境を起こして畳める", () => {
  it("[task-0033/a1] provision → healthcheck → teardown が runner だけで回る", async () => {
    const port = await freePort();
    const taskId = `envpool-standalone-${Date.now()}`;
    const driverPath = resolveDriverPath("process");
    const cmd = `node -e "require('http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1')"`;

    const provisioned = await runDriverVerb(
      driverPath,
      "provision",
      { config: { cmd, port }, taskId },
      DEFAULT_DRIVER_TIMEOUT_MS
    );
    assert.ok(provisioned.ok, `provision が失敗した: ${JSON.stringify(provisioned)}`);
    // runner は出力を解釈しない（D3: handle は不透明）。型は呼び出し側で当てる
    const handle = (provisioned.output as ProvisionOutput).handle;

    try {
      // 立ち上がるまで少し待つ
      await new Promise<void>((r) => setTimeout(r, 500));
      const health = await runDriverVerb(
        driverPath,
        "healthcheck",
        { handle },
        DEFAULT_DRIVER_TIMEOUT_MS
      );
      assert.ok(health.ok, `healthcheck が失敗した: ${JSON.stringify(health)}`);
      assert.equal((health.output as HealthcheckOutput).ok, true, "起こした環境が健康でない");
    } finally {
      const down = await runDriverVerb(driverPath, "teardown", { handle }, DEFAULT_DRIVER_TIMEOUT_MS);
      // 作った者が片付ける（決定32e）。ここを握りつぶすと外にゴミが残る
      assert.ok(down.ok, `teardown が失敗した: ${JSON.stringify(down)}`);
    }
  });

  it("[task-0033/a1] ドライバの失敗は成功に見せない", async () => {
    const result = await runDriverVerb(
      resolveDriverPath("process"),
      "provision",
      { taskId: "no-config" }, // config が無い＝ドライバが拒否する
      DEFAULT_DRIVER_TIMEOUT_MS
    );
    assert.equal(result.ok, false, "設定不足を成功として返している");
  });
});

describe("[task-0033/a1] 環境台帳が Kobo 抜きで機能する", () => {
  it("[task-0033/a1] 足す・引く・畳んだ印が残る", () => {
    const dataDir = path.join(dir, "ledger-basic");
    fs.mkdirSync(dataDir, { recursive: true });
    const { ledger, corruptionError } = EnvLedger.open(dataDir);
    assert.equal(corruptionError, null);

    ledger.add(entry({ envId: "a" }));
    ledger.add(entry({ envId: "b" }));
    assert.equal(ledger.list().length, 2);
    assert.equal(ledger.listLive().length, 2);

    ledger.markTornDown("a");
    assert.deepEqual(ledger.listLive().map((e) => e.envId), ["b"]);
    assert.equal(ledger.get("a")?.tornDownAt !== undefined, true, "畳んだ印が残る");

    ledger.remove("b");
    assert.deepEqual(ledger.list().map((e) => e.envId), ["a"]);
  });

  it("[task-0033/a1] 落ちても台帳は残る（生きている資源を見失わない）", () => {
    const dataDir = path.join(dir, "ledger-restart");
    fs.mkdirSync(dataDir, { recursive: true });
    EnvLedger.open(dataDir).ledger.add(entry({ envId: "keep", profileName: "review" }));

    const reopened = EnvLedger.open(dataDir);
    assert.equal(reopened.corruptionError, null);
    assert.deepEqual(reopened.ledger.list().map((e) => e.envId), ["keep"]);
  });

  it("[task-0033/a1] 壊れた台帳を黙って空扱いにしない（I2）", () => {
    const dataDir = path.join(dir, "ledger-corrupt");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "env-ledger.json"), "NOT JSON", "utf8");

    const { corruptionError } = EnvLedger.open(dataDir);
    assert.ok(corruptionError, "壊れているのに何も言わない");
  });

  it("[task-0033/a1] quota の数は台帳から導く（別に持たない・D3）", () => {
    const entries = [
      entry({ envId: "1", profileName: "review" }),
      entry({ envId: "2", profileName: "review", tornDownAt: new Date().toISOString() }),
      entry({ envId: "3", profileName: "ci" }),
    ];
    assert.equal(countLiveByProfile(entries, "review"), 1, "畳んだ分は数えない");
    assert.equal(countLiveByProfile(entries, "ci"), 1);
    assert.equal(countLiveByProfile(entries, "none"), 0);
  });
});

describe("[task-0033/a1] credentials の口も一緒に移っている", () => {
  it("[task-0033/a1] credentials のパスを解決できる（鍵はこのモジュールが持つ・決定32d）", () => {
    const projectRoot = path.join(dir, "proj");
    const credDir = path.join(projectRoot, "meta", "credentials");
    fs.mkdirSync(credDir, { recursive: true });
    const secrets = path.join(credDir, "staging.yaml");
    fs.writeFileSync(secrets, "x: y", "utf8");

    assert.deepEqual(resolveCredentialsPath(projectRoot, "staging"), {
      ok: true,
      filePath: secrets,
    });
  });

  it("[task-0033/a1] 参照名でディレクトリを抜けさせない", () => {
    const result = resolveCredentialsPath(path.join(dir, "proj"), "../../etc/passwd");
    assert.equal(result.ok, false);
  });
});
