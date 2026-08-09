/**
 * 環境より長生きする置き場と、その上限（`spec-environment` §5.2・PO裁定 2026-08-08）。
 *
 * **上限の仕組みを先に入れる**ことを条件に採った決めなので、まず上限が実際に効くことを
 * 確かめる。置き場そのものが効くこと（`setup` を飛ばす）はその次。
 *
 * ドライバは同梱の `process` を使う——docker を要求すると、docker の無い機械で
 * 「上限が効いているか」を誰も確かめられなくなる。
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CacheLedger,
  computeCacheKey,
  planSweep,
  ensureCacheDir,
  listCacheDirs,
  removeCacheDir,
  assertCacheCeiling,
  DEFAULT_ENV_LIMITS,
  resolveLimits,
  PRIMED_MARKER,
} from "@banto/environment-pool";
import { parseEnvProfiles } from "@banto/core";

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-cache-"));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("上限（PO条件 2026-08-08）", () => {
  it("既定に上限がある。**無制限という設定は無い**", () => {
    assert.equal(typeof DEFAULT_ENV_LIMITS.cacheMaxEntries, "number");
    assert.ok(DEFAULT_ENV_LIMITS.cacheMaxEntries > 0);
    assert.ok(DEFAULT_ENV_LIMITS.cacheMaxAgeMs > 0);
    // 上限を外そうとする設定は、組み立てのときに弾く
    for (const bad of [-1, Infinity, 1.5, Number.NaN]) {
      assert.throws(
        () => assertCacheCeiling(resolveLimits({ cacheMaxEntries: bad })),
        /cacheMaxEntries/,
        `cacheMaxEntries: ${String(bad)} を通してはいけない`
      );
    }
    assert.throws(() => assertCacheCeiling(resolveLimits({ cacheMaxAgeMs: 0 })), /cacheMaxAgeMs/);
  });

  it("0 は「止める」であって「外す」ではない（通る）", () => {
    assert.doesNotThrow(() => assertCacheCeiling(resolveLimits({ cacheMaxEntries: 0 })));
  });
});

describe("落とすものの決め方（LRU）", () => {
  let ledger: CacheLedger;
  let ledgerDir: string;

  beforeEach(() => {
    ledgerDir = fs.mkdtempSync(path.join(dir, "ledger-"));
    ledger = new CacheLedger(ledgerDir);
  });

  const at = (isoDaysAgo: number): Date => new Date(Date.now() - isoDaysAgo * 86_400_000);

  it("新しい順に残し、上限を超えた分を落とす", () => {
    for (const [i, key] of ["a", "b", "c", "d"].entries()) {
      ledger.touch({ key, driver: "process", profile: "test" }, at(i));
    }
    const plan = planSweep({
      present: [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }],
      ledger,
      maxEntries: 2,
      maxAgeMs: 365 * 86_400_000,
    });
    assert.deepEqual(plan.remove.sort(), ["c", "d"]);
    assert.equal(plan.kept, 2);
  });

  it("**いま使っているものは落とさない**（立てた環境の足元を外さない）", () => {
    ledger.touch({ key: "old", driver: "process", profile: "test" }, at(100));
    ledger.touch({ key: "new", driver: "process", profile: "test" }, at(0));
    const plan = planSweep({
      present: [{ key: "old" }, { key: "new" }],
      ledger,
      maxEntries: 1,
      maxAgeMs: 365 * 86_400_000,
      keep: "old",
    });
    assert.ok(!plan.remove.includes("old"), "使用中を落としてはいけない");
  });

  it("古すぎるものは件数に余裕があっても落とす", () => {
    ledger.touch({ key: "stale", driver: "process", profile: "test" }, at(40));
    ledger.touch({ key: "fresh", driver: "process", profile: "test" }, at(1));
    const plan = planSweep({
      present: [{ key: "stale" }, { key: "fresh" }],
      ledger,
      maxEntries: 8,
      maxAgeMs: 30 * 86_400_000,
    });
    assert.deepEqual(plan.remove, ["stale"]);
  });

  it("台帳に無い置き場は「時刻が分からない」＝最初に落ちる", () => {
    ledger.touch({ key: "known", driver: "process", profile: "test" }, at(10));
    const plan = planSweep({
      present: [{ key: "known" }, { key: "orphan" }],
      ledger,
      maxEntries: 1,
      maxAgeMs: 365 * 86_400_000,
    });
    assert.deepEqual(plan.remove, ["orphan"]);
  });

  it("台帳は読み直せる（プロセスを跨いで LRU が続く）", () => {
    ledger.touch({ key: "x", driver: "process", profile: "test" }, at(3));
    const reopened = new CacheLedger(ledgerDir);
    assert.equal(reopened.get("x")?.driver, "process");
  });
});

describe("鍵の作り方（§5.2.1）", () => {
  let repo: string;

  before(() => {
    repo = fs.mkdtempSync(path.join(dir, "repo-"));
    fs.writeFileSync(path.join(repo, "lock"), "v1");
    fs.writeFileSync(path.join(repo, "dockerfile"), "FROM node:22");
  });

  const key = (files: string[], profile = "test", driver = "docker"): string => {
    const out = computeCacheKey({ driver, profile, files: files.map((f) => path.join(repo, f)) });
    assert.ok(out.ok, "鍵が作れること");
    return out.ok ? out.key : "";
  };

  it("中身が同じなら同じ鍵", () => {
    assert.equal(key(["lock"]), key(["lock"]));
  });

  it("中身が変われば別の鍵", () => {
    const before = key(["lock"]);
    fs.writeFileSync(path.join(repo, "lock"), "v2");
    assert.notEqual(key(["lock"]), before);
  });

  it("**プロファイルとドライバを混ぜる**（別の土台で作ったものを同じ鍵で指さない）", () => {
    assert.notEqual(key(["lock"], "test"), key(["lock"], "other"));
    assert.notEqual(key(["lock"], "test", "docker"), key(["lock"], "test", "process"));
  });

  it("挙げたファイルが1つ変わっただけでも鍵が変わる", () => {
    const before = key(["lock", "dockerfile"]);
    fs.writeFileSync(path.join(repo, "dockerfile"), "FROM node:24");
    assert.notEqual(key(["lock", "dockerfile"]), before);
  });

  it("材料が読めなければ**鍵を作らない**（欠けた鍵で別物を指さない）", () => {
    const out = computeCacheKey({
      driver: "docker",
      profile: "test",
      files: [path.join(repo, "missing")],
    });
    assert.equal(out.ok, false);
  });
});

describe("置き場の実体（同梱ドライバ）", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(dir, "root-"));
  });

  it("印が無いうちは primed にならない（半端な置き場を掴まない）", () => {
    const first = ensureCacheDir(root, "abc123");
    assert.equal(first.primed, false);
    fs.writeFileSync(path.join(first.dir, PRIMED_MARKER), "");
    assert.equal(ensureCacheDir(root, "abc123").primed, true);
  });

  it("一覧と削除ができる。削除は冪等", () => {
    ensureCacheDir(root, "aaa");
    ensureCacheDir(root, "bbb");
    assert.deepEqual(listCacheDirs(root).map((e) => e.key).sort(), ["aaa", "bbb"]);
    removeCacheDir(root, "aaa");
    assert.deepEqual(listCacheDirs(root).map((e) => e.key), ["bbb"]);
    assert.doesNotThrow(() => removeCacheDir(root, "aaa"), "既に無いのは成功扱い");
  });

  it("根の外は消さない", () => {
    const outside = path.join(dir, "do-not-delete");
    fs.mkdirSync(outside, { recursive: true });
    // 鍵は濾されるので、経路として解釈されない
    removeCacheDir(root, "../do-not-delete");
    assert.ok(fs.existsSync(outside), "根の外を消してはいけない");
  });
});

describe("プロファイルの宣言（§5.2.1）", () => {
  it("cache を読む", () => {
    const parsed = parseEnvProfiles(`
profiles:
  test:
    driver: docker
    ttl: 45m
    setup: "npm ci"
    cache:
      key: [package-lock.json, docker/Dockerfile.test]
      path: /app/node_modules
`);
    assert.equal(parsed.failures.length, 0);
    assert.deepEqual(parsed.valid[0]?.cache, {
      key: ["package-lock.json", "docker/Dockerfile.test"],
      path: "/app/node_modules",
    });
  });

  it("片方だけの宣言は受け取らない（鍵の無い置き場・行き先の無い鍵を作らない）", () => {
    for (const block of ["cache:\n      key: [a]", "cache:\n      path: /app/x", "cache:\n      key: []\n      path: /app/x"]) {
      const parsed = parseEnvProfiles(`
profiles:
  test:
    driver: docker
    ttl: 45m
    ${block}
`);
      assert.equal(parsed.valid.length, 0, `受け取ってはいけない: ${block}`);
      assert.equal(parsed.failures.length, 1);
    }
  });

  it("cache を書かないプロファイルは今までどおり通る", () => {
    const parsed = parseEnvProfiles(`
profiles:
  test:
    driver: docker
    ttl: 45m
    setup: "npm ci"
`);
    assert.equal(parsed.failures.length, 0);
    assert.equal(parsed.valid[0]?.cache, undefined);
  });
});
