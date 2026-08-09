/**
 * 置き場が実際に効くこと（`spec-environment` §5.2）。実物の `EnvironmentPool` と
 * 同梱の `process` ドライバで、**`setup` が2回目に走らない**ことを確かめる。
 *
 * 見たいのは3つ。
 *   ① 同じ鍵の2回目は `setup` を飛ばす（＝毎タスク60秒を払い直さない）
 *   ② 鍵が変われば飛ばさない（古い置き場を掴まない）
 *   ③ 上限を超えたら落ちる（PO条件。落とすのは正常な動作）
 *
 * `setup` は「呼ばれた回数をファイルに1行足す」だけにする——回数が事実として残るので、
 * 飛ばしたかどうかを自己申告ではなく実測で見られる（I1）。
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EnvironmentPool } from "@banto/environment-pool";

let dir: string;
let repo: string;
/** `setup` が走るたびに1行増える。 */
let setupLog: string;

/** `cache` を宣言したプロファイル。`process` ドライバなので置き場は symlink で繋がる。 */
function writeProfiles(opts: { cache: boolean }): void {
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "meta", "environments.yaml"),
    [
      "profiles:",
      "  test:",
      "    driver: process",
      "    ttl: 10m",
      "    config:",
      '      cmd: "sleep 30"',
      `    setup: "echo ran >> ${setupLog}"`,
      ...(opts.cache
        ? ["    cache:", "      key: [lockfile]", "      path: deps"]
        : []),
      "",
    ].join("\n")
  );
}

const setupRuns = (): number =>
  fs.existsSync(setupLog) ? fs.readFileSync(setupLog, "utf-8").trim().split("\n").filter(Boolean).length : 0;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-cache-e2e-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  setupLog = path.join(dir, "setup.log");
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(setupLog, { force: true });
  fs.writeFileSync(path.join(repo, "lockfile"), "v1");
});

/** 立てて畳む（毎回別の環境＝いまの動き）。 */
async function cycle(pool: EnvironmentPool, taskId: string): Promise<void> {
  const created = await pool.provision({ repoPath: repo, workdir: repo, profile: "test", taskId });
  await pool.teardown(created.envId);
}

describe("[spec-environment §5.2] 置き場が setup を飛ばす", () => {
  it("cache を書いていなければ、毎回 setup が走る（今までどおり）", async () => {
    writeProfiles({ cache: false });
    const pool = new EnvironmentPool({ dataDir: path.join(dir, "d-nocache"), driverTimeoutMs: 20_000 });
    await cycle(pool, "t1");
    await cycle(pool, "t2");
    assert.equal(setupRuns(), 2, "cache 無しでは2回とも走る");
  });

  it("**同じ鍵の2回目は setup を飛ばす**", async () => {
    writeProfiles({ cache: true });
    const pool = new EnvironmentPool({ dataDir: path.join(dir, "d-hit"), driverTimeoutMs: 20_000 });
    await cycle(pool, "t1");
    assert.equal(setupRuns(), 1, "1回目は用意が要る");
    await cycle(pool, "t2");
    assert.equal(setupRuns(), 1, "2回目は用意済みのものを掴む（ここが 60 秒の節約）");
  });

  it("鍵が変われば飛ばさない（古い置き場を掴まない）", async () => {
    writeProfiles({ cache: true });
    const pool = new EnvironmentPool({ dataDir: path.join(dir, "d-miss"), driverTimeoutMs: 20_000 });
    await cycle(pool, "t1");
    assert.equal(setupRuns(), 1);

    fs.writeFileSync(path.join(repo, "lockfile"), "v2"); // ロックが変わった
    await cycle(pool, "t2");
    assert.equal(setupRuns(), 2, "中身が変われば用意し直す");
  });

  it("上限 0 は機構を止める（cache を書いていても毎回 setup）", async () => {
    writeProfiles({ cache: true });
    const pool = new EnvironmentPool({
      dataDir: path.join(dir, "d-off"),
      driverTimeoutMs: 20_000,
      limits: { cacheMaxEntries: 0 },
    });
    await cycle(pool, "t1");
    await cycle(pool, "t2");
    assert.equal(setupRuns(), 2, "止めてあるなら置き場を使わない");
  });
});

describe("[spec-environment §5.2.3] 上限で落ちる（PO条件）", () => {
  it("上限を超えた置き場は落ちる。**落ちても正しさは変わらない**", async () => {
    writeProfiles({ cache: true });
    const dataDir = path.join(dir, "d-sweep");
    const cacheRoot = path.join(dataDir, "env-cache");
    const pool = new EnvironmentPool({
      dataDir,
      driverTimeoutMs: 20_000,
      limits: { cacheMaxEntries: 2 },
    });

    // 鍵を3つ作る（ロックを書き換えるたびに別の置き場になる）
    for (const [i, content] of ["v1", "v2", "v3"].entries()) {
      fs.writeFileSync(path.join(repo, "lockfile"), content);
      await cycle(pool, `t${i}`);
    }

    const left = fs.existsSync(cacheRoot)
      ? fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((e) => e.isDirectory())
      : [];
    assert.ok(left.length <= 2, `上限 2 を超えて残っている: ${left.length} 件`);
    assert.equal(setupRuns(), 3, "3つとも用意はした（落ちたのは用意のあと）");

    // 落ちた鍵に戻れば、また作り直すだけ——**正しさは変わらない**
    fs.writeFileSync(path.join(repo, "lockfile"), "v1");
    await cycle(pool, "again");
    assert.equal(setupRuns(), 4, "落としたぶんは次に使うとき作り直される");
  });

  it("いま立てた置き場は落とさない（足元を外さない）", async () => {
    writeProfiles({ cache: true });
    const dataDir = path.join(dir, "d-keep");
    const cacheRoot = path.join(dataDir, "env-cache");
    const pool = new EnvironmentPool({
      dataDir,
      driverTimeoutMs: 20_000,
      // 1 件しか置けない状況でも、いま使っているものは残る
      limits: { cacheMaxEntries: 1 },
    });
    for (const [i, content] of ["a", "b"].entries()) {
      fs.writeFileSync(path.join(repo, "lockfile"), content);
      await cycle(pool, `k${i}`);
    }
    const left = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(left.length, 1, "上限どおり1件");
    // 残ったのは最後に使ったもの。もう一度同じ鍵で立てれば setup は走らない
    const before = setupRuns();
    await cycle(pool, "k2");
    assert.equal(setupRuns(), before, "残っている置き場は使える");
  });
});
