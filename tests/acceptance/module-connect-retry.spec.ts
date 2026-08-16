/**
 * task-0235: モジュールへの接続が一瞬途切れただけで仕事を落とさない。
 *
 * 2026-08-16、worker-pool の OOM 再起動の最中に呼び出しが接続段で失敗し、タスクが
 * 中身と無関係に failed になった（実測：failed の24〜47秒前に worker-pool の OOM）。
 * 数十秒後には同じ操作が通っている。ここでは**偽の fetch**を渡して決定的に再現する
 * ——本物のポートを使って偶然を待つ形にはしない。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createModuleClient, type ModuleRegistryConfig } from "@banto/core";

type FetchResult = { ok: boolean; status: number; statusText: string; json(): Promise<unknown> };
/** `ModuleFetch`（module-invocation.ts）と構造的に同じ形。型はここでは export されていない。 */
type FakeModuleFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchResult>;

function connectError(code: "ECONNREFUSED" | "ENOTFOUND" | "EAI_AGAIN"): NodeJS.ErrnoException {
  const err = new Error(`connect ${code} 127.0.0.1:1`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function connResetError(): NodeJS.ErrnoException {
  const err = new Error("read ECONNRESET") as NodeJS.ErrnoException;
  err.code = "ECONNRESET";
  return err;
}

/** 実機ではこの形（`code` が付かず、メッセージだけ "socket hang up"）でも起きる。 */
function socketHangUpError(): Error {
  return new Error("socket hang up");
}

function okResult(): FetchResult {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };
}

function httpErrorResult(): FetchResult {
  return {
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    json: async () => ({ error: "boom" }),
  };
}

type Step = () => FetchResult | never;

function failWith(err: unknown): Step {
  return () => {
    throw err;
  };
}

function succeed(): Step {
  return () => okResult();
}

/** 台本どおりに振る舞う偽 fetch。相手が起き直る様子を決定的に作る。 */
function scriptedFetch(steps: Step[]) {
  const timestamps: number[] = [];
  let count = 0;
  const fetchImpl: FakeModuleFetch = async () => {
    timestamps.push(Date.now());
    const step = steps[Math.min(count, steps.length - 1)];
    count += 1;
    return step();
  };
  return { fetchImpl, callCount: () => count, timestamps };
}

const REGISTRY: ModuleRegistryConfig = { modules: { flaky: { baseUrl: "http://127.0.0.1:1" } } };

const ENV_KEYS = ["BANTO_MODULE_CONNECT_RETRY_ATTEMPTS", "BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** console.warn の出力を横取りする。再試行の記録（a4）を確かめるため。 */
async function captureWarnings<T>(
  fn: () => Promise<T>
): Promise<{ warnings: string[]; result?: T; error?: unknown }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { warnings, result };
  } catch (error) {
    return { warnings, error };
  } finally {
    console.warn = original;
  }
}

describe("[task-0235/a1] 接続確立の失敗（ECONNREFUSED/ENOTFOUND/EAI_AGAIN）は短く再試行される", () => {
  it("ECONNREFUSED が2回続いても、3回目で相手が起き直っていれば成功する", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5,5";
    const { fetchImpl, callCount } = scriptedFetch([
      failWith(connectError("ECONNREFUSED")),
      failWith(connectError("ECONNREFUSED")),
      succeed(),
    ]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    const result = await client.invoke("flaky", "any.tool");

    assert.equal(callCount(), 3, "1回目・2回目は失敗、3回目で成功するまで試している");
    assert.match(String(result.content[0]?.text), /ok/);
  });

  it("ENOTFOUND / EAI_AGAIN も同様に再試行される", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5,5";
    for (const code of ["ENOTFOUND", "EAI_AGAIN"] as const) {
      const { fetchImpl, callCount } = scriptedFetch([failWith(connectError(code)), succeed()]);
      const client = createModuleClient(REGISTRY, fetchImpl);
      const result = await client.invoke("flaky", "any.tool");
      assert.equal(callCount(), 2, `${code} は1回失敗のあと再試行で通る`);
      assert.match(String(result.content[0]?.text), /ok/);
    }
  });
});

describe("[task-0235/a2] 送信後の失敗（ECONNRESET/socket hang up）は既定では再試行されない", () => {
  it("ECONNRESET は既定では1回で諦める（冪等でない呼び出しを二重に走らせない）", async () => {
    const { fetchImpl, callCount } = scriptedFetch([failWith(connResetError()), succeed()]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    await assert.rejects(() => client.invoke("flaky", "worker.delegate"), /Failed to reach module "flaky"/);
    assert.equal(callCount(), 1, "再試行していない——2度目が呼ばれていたら二重発火の危険");
  });

  it("socket hang up（code無しの形）も既定では再試行されない", async () => {
    const { fetchImpl, callCount } = scriptedFetch([failWith(socketHangUpError()), succeed()]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    await assert.rejects(() => client.invoke("flaky", "worker.delegate"), /Failed to reach module "flaky"/);
    assert.equal(callCount(), 1);
  });

  it("呼び出し側が idempotent: true を渡したときだけ、送信後の失敗も再試行される", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5,5";
    const { fetchImpl, callCount } = scriptedFetch([failWith(connResetError()), succeed()]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    const result = await client.invoke("flaky", "file.list", {}, { idempotent: true });

    assert.equal(callCount(), 2, "オプトインしたときだけ再試行が起きる");
    assert.match(String(result.content[0]?.text), /ok/);
  });

  it("idempotent: true でも、接続確立でない失敗が続けば規定回数で諦める", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_ATTEMPTS"] = "2";
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5";
    const { fetchImpl, callCount } = scriptedFetch([failWith(connResetError())]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    await assert.rejects(
      () => client.invoke("flaky", "worker.delegate", {}, { idempotent: true }),
      /Failed to reach module "flaky"/
    );
    assert.equal(callCount(), 3, "初回 + 再試行2回 = 3回で打ち切り");
  });
});

describe("[task-0235/a3] 再試行の回数・間隔には上限があり、環境変数で変えられる", () => {
  it("既定でも合計の待ちは数秒を超えない", async () => {
    const { fetchImpl, callCount } = scriptedFetch([failWith(connectError("ECONNREFUSED"))]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    const started = Date.now();
    await assert.rejects(() => client.invoke("flaky", "any.tool"), /Failed to reach module "flaky"/);
    const elapsedMs = Date.now() - started;

    assert.ok(callCount() >= 2, "1回きりではなく再試行している");
    assert.ok(elapsedMs < 5000, `既定の合計待ちは数秒を超えないはず（実測 ${elapsedMs}ms）`);
  });

  it("BANTO_MODULE_CONNECT_RETRY_ATTEMPTS / _DELAYS_MS で回数と間隔を変えられる", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_ATTEMPTS"] = "1";
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "20";
    const { fetchImpl, callCount, timestamps } = scriptedFetch([failWith(connectError("ECONNREFUSED"))]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    await assert.rejects(() => client.invoke("flaky", "any.tool"), /Failed to reach module "flaky"/);

    assert.equal(callCount(), 2, "初回 + 再試行1回 = 2回で打ち切り（環境変数どおり）");
    assert.ok((timestamps[1] ?? 0) - (timestamps[0] ?? 0) >= 15, "指定した間隔（20ms前後）を空けている");
  });
});

describe("[task-0235/a4] 再試行しても届かなければ、これまでと同じ形で例外を投げ、記録が残る", () => {
  it("最終的な例外は従来と同じ文言（呼び出し側の catch を壊さない）", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5,5";
    const { fetchImpl } = scriptedFetch([failWith(connectError("ECONNREFUSED"))]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    // assert.rejects は RegExp を渡すと `String(error)`（= `Error: ` 接頭辞つき）と照合する
    // （node:assert の挙動。`error.message` 単体ではない）。
    await assert.rejects(
      () => client.invoke("flaky", "worker.delegate"),
      /^Error: Failed to reach module "flaky" at http:\/\/127\.0\.0\.1:1\/tools\/worker\.delegate: .*ECONNREFUSED/s
    );
  });

  it("何回試して駄目だったかが記録に残る", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_ATTEMPTS"] = "2";
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5";
    const { fetchImpl } = scriptedFetch([failWith(connectError("ECONNREFUSED"))]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    const { warnings, error } = await captureWarnings(() => client.invoke("flaky", "any.tool"));

    assert.match(String(error), /Failed to reach module "flaky"/);
    assert.ok(
      warnings.some((w) => w.includes("2") && /再試行/.test(w)),
      `再試行の回数が記録に残っていない: ${JSON.stringify(warnings)}`
    );
  });

  it("何回目で通ったかが記録に残る", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5,5";
    const { fetchImpl } = scriptedFetch([failWith(connectError("ECONNREFUSED")), succeed()]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    const { warnings, result } = await captureWarnings(() => client.invoke("flaky", "any.tool"));

    assert.ok(result, "成功しているはず");
    assert.ok(
      warnings.some((w) => /成功/.test(w)),
      `成功した旨が記録に残っていない: ${JSON.stringify(warnings)}`
    );
  });
});

describe("[task-0235/a5] ツール側のエラー応答（非2xx）は再試行されない。既存の呼び出しは書き方を変えずに動く", () => {
  it("HTTPのエラー応答は1回で伝わる（再試行しない）", async () => {
    process.env["BANTO_MODULE_CONNECT_RETRY_DELAYS_MS"] = "5,5,5";
    const { fetchImpl, callCount } = scriptedFetch([() => httpErrorResult()]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    await assert.rejects(() => client.invoke("flaky", "any.tool"), /Module "flaky" tool "any\.tool" failed \(500\)/);
    assert.equal(callCount(), 1, "ツール側のエラーは接続の失敗ではないので再試行しない");
  });

  it("options を渡さない既存の呼び出し方のままでも動く", async () => {
    const { fetchImpl } = scriptedFetch([succeed()]);
    const client = createModuleClient(REGISTRY, fetchImpl);

    // 3引数まで（options 無し）——task-0018 時点の書き方のまま
    const result = await client.invoke("flaky", "any.tool", { a: 1 });
    assert.match(String(result.content[0]?.text), /ok/);
  });
});
