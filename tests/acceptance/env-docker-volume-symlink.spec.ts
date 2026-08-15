/**
 * ボリュームの載り先が symlink なら、環境を立てない（imp-0043・a）。
 *
 * ## 何が起きたか（dentaku・2026-08-15）
 *
 * 職人が作業ツリーの `node_modules` を本体チェックアウトへ symlink していた。
 * docker は**マウント先のパスを解決してから**載せるので、名前つきボリュームは
 * `/app/node_modules` ではなく**symlink の指す先**に載る（mountinfo で実測）:
 *
 *   /var/lib/docker/volumes/<proj>_dentaku_test_node_modules/_data
 *     → /home/ubuntu/ghq/.../dentaku/node_modules      ← /app/node_modules ではない
 *
 * そこで `npm ci` を打つと、npm は `/app/node_modules`（＝symlink 自身。unlink は
 * EBUSY にならない）を消して同じ場所に実体ディレクトリを作る。用意の成果は
 * bind mount＝ホストの作業ツリーへ落ち、ボリュームは空のまま。**setup は exit 0**。
 * 次に立つ検証コンテナでは空のボリュームが被さり `vitest: not found`（exit 127）。
 * マージ前ゲートが3タスク連続で落ちた（task-0020・0021・0023）。
 *
 * **1回目だけ落ちて再試行では通る**（1回目の setup が symlink を実体に化けさせるため）
 * ので間欠に見えるが、機構としては決定的——symlink 有りで 6/6・無しで 12/12。
 *
 * ## なぜ別ファイルなのか
 *
 * ホストの docker を要るので `npm test`（器の中）から外し、`npm run test:docker` へ寄せる。
 * ファイル名の `env-docker-` が `npm test` 側の除外に効き、package.json の `test:docker`
 * に列挙することで実際に回る——**2つを足して初めて全部が回る**
 * （`env-docker-provision-setup-order.spec.ts` の注記と同じ）。
 *
 * I1: 直しを戻すと a1 が落ちることを確認済み。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { EnvironmentPool } from "@banto/environment-pool";

let dir: string;
let dataDir: string;
let repo: string;
let composeFile: string;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-volume-symlink-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });

  /**
   * dentaku の `docker/test.yaml` と同じ形：**作業ツリーを丸ごと bind mount し、その下の
   * `node_modules` だけ名前つきボリュームで隔離する**。これが壊れ方の前提条件そのもの。
   *
   * bind の元は絶対パスで書く（検体を固定ファイルに置くと `../` の指す先がずれる）。
   */
  composeFile = path.join(repo, "test-compose.yaml");
  fs.writeFileSync(
    composeFile,
    "services:\n" +
      "  app:\n" +
      "    image: busybox:latest\n" +
      "    working_dir: /app\n" +
      '    command: ["sh", "-c", "while true; do sleep 1; done"]\n' +
      "    security_opt:\n" +
      "      - apparmor=unconfined\n" +
      "    volumes:\n" +
      `      - ${repo}:/app\n` +
      "      - deps:/app/node_modules\n" +
      "volumes:\n" +
      "  deps:\n",
    "utf-8"
  );
});

afterEach(() => {
  for (const p of pools.splice(0)) p.stopMaintenance();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(setup: string): void {
  fs.writeFileSync(
    path.join(repo, "meta", "environments.yaml"),
    "profiles:\n" +
      "  test:\n" +
      "    driver: docker\n" +
      "    config:\n" +
      `      compose: ${composeFile}\n` +
      `    setup: ${JSON.stringify(setup)}\n` +
      "    ttl: 10m\n",
    "utf-8"
  );
}

function makePool(): EnvironmentPool {
  const p = new EnvironmentPool({ dataDir, driverTimeoutMs: 60_000 });
  pools.push(p);
  return p;
}

/** docker が使えることは前提（I1: 使えないなら skip せずに落とす）。 */
function requireDockerCompose(): void {
  const v = childProcess.spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(v.status, 0, "docker compose が使えない（I1: skip しない）");
}

/** 用意の成果を、検証コンテナから見える形で置くコマンド。 */
const SETUP = "mkdir -p /app/node_modules && echo prepared > /app/node_modules/marker";

// ── a1: symlink なら立てない ──────────────────────────────────────────────────

describe("[imp-0043/a1] ボリュームの載り先が symlink なら provision を断る", () => {
  it("**用意できていない環境を「立った」と言わない**（I2）", async () => {
    requireDockerCompose();

    // 職人が張った凌ぎと同じ形：作業ツリーの node_modules が、別の場所への symlink
    const elsewhere = path.join(dir, "shared-node-modules");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(repo, "node_modules"));

    writeProfiles(SETUP);
    const pool = makePool();

    const taskId = `t-symlink-${Date.now()}`;

    // I3: **立ってしまったら畳んでから落ちる。** 直しが外れているときこそ環境が立つので、
    // 畳むのを assert のあとに置くと「直しを外して確かめる」たびに器が外に残る（実際に残した）
    let env: { envId: string } | undefined;
    let raised: unknown;
    try {
      env = await pool.provision({ repoPath: repo, workdir: repo, profile: "test", taskId });
    } catch (err) {
      raised = err;
    } finally {
      if (env) await pool.teardown(env.envId).catch(() => undefined);
    }

    assert.ok(raised, "symlink の載り先なのに provision が通ってしまった");
    const msg = raised instanceof Error ? raised.message : String(raised);
    // **理由が読めること**まで見る。断るだけで理由が無いと、踏んだ側は直せない
    assert.match(msg, /symlink/, `symlink だと言っていない: ${msg}`);
    assert.match(msg, /node_modules/, `どのパスが悪いのか名指ししていない: ${msg}`);
  });
});

// ── a2: 実体ディレクトリなら今までどおり通る ─────────────────────────────────

describe("[imp-0043/a2] 実体のディレクトリなら今までどおり立って走る", () => {
  it("node_modules が無い（これから作られる）ときは通り、用意の成果が run から見える", async () => {
    requireDockerCompose();

    writeProfiles(SETUP);
    const pool = makePool();

    const taskId = `t-nosymlink-${Date.now()}`;
    const env = await pool.provision({ repoPath: repo, workdir: repo, profile: "test", taskId });
    try {
      assert.equal(env.healthcheck.ok, true, JSON.stringify(env.healthcheck));
      const out = await pool.run(env.envId, "cat /app/node_modules/marker");
      assert.equal(out.exit, 0, `用意の成果が検証コンテナから見えなければならない: ${out.logTail}`);
      assert.match(out.logTail, /prepared/);
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("node_modules が実体のディレクトリとして既に在るときも通る", async () => {
    requireDockerCompose();

    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });

    writeProfiles(SETUP);
    const pool = makePool();

    const taskId = `t-realdir-${Date.now()}`;
    const env = await pool.provision({ repoPath: repo, workdir: repo, profile: "test", taskId });
    try {
      const out = await pool.run(env.envId, "cat /app/node_modules/marker");
      assert.equal(out.exit, 0, out.logTail);
      assert.match(out.logTail, /prepared/);
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });
});

// ── a3: 通った用意のログが残る ────────────────────────────────────────────────

describe("[imp-0043/a3] 通った setup の出力もファイルに残る", () => {
  it("**「あの回、setup は本当に走ったのか」を後から追える**", async () => {
    requireDockerCompose();

    writeProfiles(`${SETUP} && echo 用意しました`);
    const pool = makePool();

    const taskId = `t-setuplog-${Date.now()}`;
    const env = await pool.provision({ repoPath: repo, workdir: repo, profile: "test", taskId });
    try {
      const logDir = path.join(os.tmpdir(), "banto-docker-driver-logs");
      const mine = fs
        .readdirSync(logDir)
        .filter((f) => f.startsWith(`${taskId}-setup-`))
        .map((f) => path.join(logDir, f));

      assert.equal(mine.length, 1, `通った setup のログが1本残っていない: ${mine.join(", ")}`);
      const body = fs.readFileSync(mine[0]!, "utf8");
      assert.match(body, /用意しました/, `setup の出力が残っていない: ${body}`);
      assert.match(body, /exit 0/, `終わり方が残っていない: ${body}`);
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });
});
