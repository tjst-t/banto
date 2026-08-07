/**
 * プロファイルの `setup` — 立てたあと・検証を回す前に一度だけ走らせる（task-0080）。
 *
 * **なぜ要るか**（inc-0034 で実測した壊れ方）。docker のプロファイルは node_modules を
 * 名前付きボリュームに隔離するのが普通で、`compose up -d` が返っても中は空。
 * 「立った」と「使える」が別なのに、`setup` の置き場が無かった。結果、受け入れ条件の
 * `verify` が自分で `npm ci` する羽目になり、実機で3つ同時に起きた：
 *
 *   1. 受け入れ条件ごとに繰り返す（loamium/task-0005 は a3・a4 で各100秒）
 *   2. タスクを書く側が用意の仕方を当てさせられる（`--include=dev` と書いて外した。
 *      正解は `--ignore-scripts`）
 *   3. **失敗の言葉が間違う**——用意でこけたのに `verify_failed:a3(exit=1)` と出て、
 *      「テストが落ちた」と読める。テストは一度も走っていない
 *
 * **provision の一部にするのが要点**。「provision が成功した」＝「検証コマンドを
 * 走らせられる」にしておかないと、呼び忘れた経路ごとに同じ穴が開く。
 *
 * 直しを戻すと落ちることを確認済み。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { EnvironmentPool } from "@banto/environment-pool";
import { validateProfile } from "../../packages/banto-core/src/env-profile-parser.js";

const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-profile-setup.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-setup-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
});

afterEach(() => {
  for (const p of pools.splice(0)) p.stopMaintenance();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(body: string): void {
  fs.writeFileSync(path.join(repo, "meta", "environments.yaml"), body, "utf-8");
}

function makePool(): EnvironmentPool {
  const p = new EnvironmentPool({ dataDir, driverTimeoutMs: 30_000 });
  pools.push(p);
  return p;
}

// ── 1. 書式 ───────────────────────────────────────────────────────────────────

describe("[task-0080] プロファイルの setup — 書式", () => {
  it("setup はコマンド文字列として読める", () => {
    const r = validateProfile("test", {
      driver: "docker",
      ttl: "30m",
      setup: "npm ci --ignore-scripts",
    });
    assert.equal(r.ok, true, `読めなければならない: ${JSON.stringify(r)}`);
    assert.equal(
      (r as { ok: true; profile: { setup?: string } }).profile.setup,
      "npm ci --ignore-scripts"
    );
  });

  it("setup が無いプロファイルはそのまま通る（後方互換）", () => {
    const r = validateProfile("test", { driver: "docker", ttl: "30m" });
    assert.equal(r.ok, true);
    assert.equal((r as { ok: true; profile: { setup?: string } }).profile.setup, undefined);
  });

  it("空文字・文字列でない setup は黙って無視せず拒否する（I2）", () => {
    for (const bad of ["", "   ", 42, { cmd: "npm ci" }, []]) {
      const r = validateProfile("test", { driver: "docker", ttl: "30m", setup: bad });
      assert.equal(r.ok, false, `拒否しなければならない: setup=${JSON.stringify(bad)}`);
    }
  });
});

// ── 2. 立てるうちに走る（process ドライバ・機構そのもの） ──────────────────────

describe("[task-0080] プロファイルの setup — provision の一部として走る", () => {
  it("setup は provision の中で走り、その成果を後続の run が見られる", async () => {
    const marker = path.join(dir, "setup-ran.txt");
    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        "      cmd: sleep 60\n" +
        `    setup: "echo ready > ${marker}"\n` +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    const env = await pool.provision({ repoPath: repo, profile: "test", taskId: "t-setup" });

    // **provision が返った時点で用意が済んでいること**。
    // 直す前は setup という概念が無く、このファイルは作られなかった
    assert.equal(
      fs.existsSync(marker),
      true,
      "provision が返った時点で setup が済んでいなければならない（『立った』＝『使える』）"
    );
    assert.equal(fs.readFileSync(marker, "utf-8").trim(), "ready");

    // 後続の run から成果が見えること
    const out = await pool.run(env.envId, `cat ${marker}`);
    assert.equal(out.exit, 0);
    assert.match(out.logTail, /ready/);

    await pool.teardown(env.envId);
  });

  it("setup は1環境につき1回だけ走る（run のたびに繰り返さない）", async () => {
    const counter = path.join(dir, "setup-count.txt");
    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        "      cmd: sleep 60\n" +
        `    setup: "echo x >> ${counter}"\n` +
        "    ttl: 5m\n"
    );
    const pool = makePool();
    const env = await pool.provision({ repoPath: repo, profile: "test", taskId: "t-once" });

    await pool.run(env.envId, "true");
    await pool.run(env.envId, "true");

    // **受け入れ条件ごとに繰り返さないこと**が要点（loamium は a3/a4 で各100秒払っていた）
    const lines = fs.readFileSync(counter, "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `setup は1回だけのはず。走った回数: ${lines.length}`);

    await pool.teardown(env.envId);
  });

  it("setup がこけたら provision が失敗し、環境を残さない（I2・I3）", async () => {
    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        "      cmd: sleep 60\n" +
        '    setup: "exit 3"\n' +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    await assert.rejects(
      () => pool.provision({ repoPath: repo, profile: "test", taskId: "t-fail" }),
      (err: Error) => {
        // 「用意できなかった」と分かる言葉であること。
        // **`verify_failed` と同じ言葉にしない**——テストが落ちたと読めてしまう（task-0075）
        assert.match(err.message, /使える状態にできませんでした|setup/);
        return true;
      },
      "setup が失敗したら provision も失敗しなければならない（黙って使えない環境を返さない）"
    );

    // I3: 用意できなかった環境を残さない
    const live = pool.list({ taskId: "t-fail" });
    assert.equal(live.length, 0, `用意に失敗した環境を生かしたまま残してはならない: ${JSON.stringify(live)}`);
  });

  it("setup を持たないプロファイルは今までどおり立つ（後方互換）", async () => {
    writeProfiles(
      "profiles:\n  test:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 5m\n"
    );
    const pool = makePool();
    const env = await pool.provision({ repoPath: repo, profile: "test", taskId: "t-nosetup" });
    assert.equal(pool.list({ taskId: "t-nosetup" }).length, 1);
    await pool.teardown(env.envId);
  });
});

// ── 3. docker：one-off をまたいで残るのはボリュームのぶんだけ ──────────────────

describe("[task-0080] docker の setup は名前付きボリュームを通して次の run へ渡る", () => {
  it("setup がボリュームに置いたものは、あとの run（別の one-off）から見える", async () => {
    const v = childProcess.spawnSync("docker", ["compose", "version"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(v.status, 0, "docker compose が使えない（I1: skip しない）");

    const compose = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../fixtures/docker/setup-volume-compose.yaml"
    );
    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: docker\n" +
        "    config:\n" +
        `      compose: ${compose}\n` +
        '    setup: "mkdir -p /work/persisted && echo installed > /work/persisted/marker"\n' +
        "    ttl: 10m\n"
    );
    const pool = makePool();

    const env = await pool.provision({
      repoPath: repo,
      profile: "test",
      taskId: `t-dockersetup-${Date.now()}`,
    });
    try {
      // **`run` は毎回まっさらな one-off コンテナ**（`compose run --rm`）。本体の書き込み層は
      // 共有されないので、setup の成果が次の run から見えるのは**ボリュームのぶんだけ**。
      // 実プロジェクトの `setup: npm ci` が置く node_modules がまさにこの形なので、
      // その前提をここで押さえる
      const out = await pool.run(env.envId, "cat /work/persisted/marker");
      assert.equal(
        out.exit,
        0,
        `setup がボリュームに置いたものが次の run から見えなければならない: ${out.logTail}`
      );
      assert.match(out.logTail, /installed/);
    } finally {
      await pool.teardown(env.envId);
    }
  });
});
