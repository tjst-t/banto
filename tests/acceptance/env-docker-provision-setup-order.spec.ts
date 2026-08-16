/**
 * 立てる順序（docker ドライバ側） — **用意（`setup`）は `compose up` の前に済ませる**（task-0089）。
 *
 * 経緯と process ドライバ側の検体は `env-provision-setup-order.spec.ts` を見よ。ここは
 * **ホストの docker を要る分**だけを切り出したもの。
 *
 * **なぜ別ファイルなのか**（`meta/environments.yaml` の `test-docker` プロファイル）。
 * マージ前ゲートの器（`docker/test.yaml`）には docker socket が無く、`docker compose`
 * サブコマンドも入っていない——socket を渡すのはホスト root 相当の権限を器に渡すのと
 * 同じなので、渡さないと PO が裁定している。docker を叩く受け入れテストは I1 により
 * skip せず**必ず落ちる**設計なので、器の中で回すと中身と無関係に落ち続ける。
 * だから `npm test`（器の中）から外し、`npm run test:docker`（driver: process＝ホストで
 * そのまま回す）へ寄せる。ファイル名の `env-docker-` が `npm test` 側の除外に効き、
 * package.json の `test:docker` に列挙することで実際に回る——**2つを足して初めて全部が回る**。
 *
 * I1: 直しを戻すと落ちることを確認済み（docker 側）。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import { EnvironmentPool } from "@banto/environment-pool";
import { createComposeCleanup } from "../helpers/compose-cleanup.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const DEV_SERVER_COMPOSE = path.resolve(_thisDir, "../fixtures/docker/dev-server-compose.yaml");
const WAITING_COMPOSE = path.resolve(_thisDir, "../fixtures/docker/test-compose.yaml");

let dir: string;
let dataDir: string;
let repo: string;
const pools: EnvironmentPool[] = [];
/**
 * 立てた compose プロジェクトの控え（inc-0083・task-0214）。
 * 畳むのは `afterEach`——本文の中で畳むと、アサーションが落ちた回だけ残る。
 */
const cleanup = createComposeCleanup();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-setup-order-docker-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
});

afterEach(async () => {
  try {
    // 1件が投げても残りは畳む。畳み損ねたらここで落ちる（I2）
    await cleanup.teardownAll();
  } finally {
    for (const p of pools.splice(0)) p.stopMaintenance();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeProfiles(body: string): void {
  fs.writeFileSync(path.join(repo, "meta", "environments.yaml"), body, "utf-8");
}

function makePool(): EnvironmentPool {
  const p = new EnvironmentPool({ dataDir, driverTimeoutMs: 30_000 });
  pools.push(p);
  return p;
}

/**
 * docker が使えることは前提（I1: 使えないなら skip せずに落とす）。
 *
 * ここは `test-docker` プロファイル＝**ホストで直接**回る前提の場所なので、この前提は
 * 素直に成り立つ。器の中で回ってしまった（＝除外の掛け違い）ならここで落ちて気づける。
 */
function requireDockerCompose(): void {
  const v = childProcess.spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(v.status, 0, "docker compose が使えない（I1: skip しない）");
}

// ── a1: 用意が要る長命のコマンドが、起動直後に即死しない ──────────────────────

describe("[task-0089/a1] 用意は compose up の前に済む（docker）", () => {
  it("**node_modules に当たる置き場が空でも、dev server 系のコマンドが即死しない**", async () => {
    requireDockerCompose();

    writeProfiles(
      "profiles:\n" +
        "  dev:\n" +
        "    driver: docker\n" +
        "    config:\n" +
        `      compose: ${DEV_SERVER_COMPOSE}\n` +
        '    setup: "mkdir -p /work/deps && echo \'while true; do sleep 1; done\' > ' +
        "/work/deps/dev-server && echo prepared > /work/deps/marker\"\n" +
        "    ttl: 10m\n"
    );
    const pool = makePool();

    const taskId = `t-devsrv-${Date.now()}`;
    const env = await pool.provision({ repoPath: repo, profile: "dev", taskId });
    // 立った直後に控える。畳むのは afterEach（ここで畳むと、下が落ちた回だけ残る）
    cleanup.trackEnv(env.envId, () => pool.teardown(env.envId));

    // 直す前はここが `ok: false`（containers not running: ...=exited）になるか、
    // 落ちる直前の running を掴んで `ok: true` と誤報告するかのどちらかだった
    assert.equal(
      env.healthcheck.ok,
      true,
      `立てた直後に使えなければならない: ${JSON.stringify(env.healthcheck)}`
    );

    // **一瞬ではなく生きていること**を、時間を置いた疎通と実際の run で確かめる
    await new Promise((r) => setTimeout(r, 1_500));
    const later = await pool.healthcheck(env.envId);
    assert.equal(
      later.ok,
      true,
      `起動直後に落ちている（exit 127 の再現）: ${JSON.stringify(later)}`
    );

    const out = await pool.run(env.envId, "cat /work/deps/marker");
    assert.equal(out.exit, 0, `用意の成果が見えなければならない: ${out.logTail}`);
    assert.match(out.logTail, /prepared/);
  });
});

// ── a2: 待つだけのプロファイルは今までどおり ──────────────────────────────────

describe("[task-0089/a2] 待つだけの test プロファイルは従来どおり", () => {
  it("setup なしの test プロファイル（sleep で待つだけ）は今までどおり立って走る", async () => {
    requireDockerCompose();

    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: docker\n" +
        "    config:\n" +
        `      compose: ${WAITING_COMPOSE}\n` +
        "    ttl: 10m\n"
    );
    const pool = makePool();

    const taskId = `t-wait-${Date.now()}`;
    const env = await pool.provision({ repoPath: repo, profile: "test", taskId });
    cleanup.trackEnv(env.envId, () => pool.teardown(env.envId));

    assert.equal(env.healthcheck.ok, true, JSON.stringify(env.healthcheck));
    const out = await pool.run(env.envId, "echo alive");
    assert.equal(out.exit, 0, out.logTail);
    assert.match(out.logTail, /alive/);
  });

  it("setup つきの test プロファイルも従来どおり通る（順序が変わっただけ）", async () => {
    requireDockerCompose();

    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: docker\n" +
        "    config:\n" +
        `      compose: ${WAITING_COMPOSE}\n` +
        '    setup: "true"\n' +
        "    ttl: 10m\n"
    );
    const pool = makePool();

    const taskId = `t-wait-setup-${Date.now()}`;
    const env = await pool.provision({ repoPath: repo, profile: "test", taskId });
    cleanup.trackEnv(env.envId, () => pool.teardown(env.envId));

    assert.equal(env.healthcheck.ok, true, JSON.stringify(env.healthcheck));
    const out = await pool.run(env.envId, "echo alive");
    assert.equal(out.exit, 0, out.logTail);
  });
});
