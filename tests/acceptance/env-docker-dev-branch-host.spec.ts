/**
 * [task-0301] `dev` プロファイルを実際に立て、**映っているのが本当にブランチのホストか**
 * を機械で確かめる（生きた検証）。
 *
 * 構造だけを読む `review-env-shows-branch-host.spec.ts`（docker 不要・`npm test`）は
 * 「web がブランチのホストを指す形になっているか」までしか見られない。ここでは
 * **本物の `docker/dev.yaml` を実際に立てて**、
 *
 *   1. compose 内の `host` サービスが自分で名乗る `instanceId`（`/api/instance` を
 *      コンテナの中から直接叩いて取る）と、
 *   2. 公開された web のポート越しに `/api/instance` を取った `instanceId`
 *
 * が一致することを確かめる。一致しなければ、web は別のホスト（＝本番）を映している
 * ——`instanceId` は起動ごとに変わる（`packages/banto-host/src/server.ts`）ので、
 * 取り違えていれば必ず値がずれる。
 *
 * **このリポジトリ自身を repoPath にする**（fixture へ写さない）。写しを作ると
 * 「写しの compose」を検証することになり、この試験が守りたい「本物の
 * `docker/dev.yaml` が実際にこの形で立つこと」を確かめられない
 * （`env-docker-git-in-worktree.spec.ts` の注記と同じ考え方）。
 *
 * docker を実際に叩くので `npm run test:docker` 側（`npm test` の除外に載る
 * `env-docker-` 始まりの名前）。docker が無ければ skip せず**落ちる**（I1）。
 * 立ち上げに要る `npm ci` は `EnvironmentPool.provision` が
 * `meta/environments.yaml` の `dev` プロファイルの `setup` を読んで面倒を見る
 * （task-0089・自分では `npm ci` しない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import { EnvironmentPool } from "@banto/environment-pool";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..");
const composeFile = path.join(repoRoot, "docker", "dev.yaml");

/** docker-driver.ts の `projectName()` と同じ決め方（imp-0033）。envId から compose プロジェクト名を作る。 */
function projectNameFor(envId: string): string {
  return `banto-env-${envId}`;
}

function requireDockerCompose(): void {
  const v = childProcess.spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(v.status, 0, `docker compose が使えません（I1: skip しない）: ${v.stderr}`);
}

function composeArgs(project: string, verb: string[]): string[] {
  return ["compose", "-p", project, "-f", composeFile, ...verb];
}

interface InstanceInfo {
  instanceId: string;
  dataDir: string;
  startedAt: string;
}

/** 期限つきで、成功するまで繰り返す（起動直後はまだ聞けないことがあるため）。 */
async function retryUntil<T>(fn: () => Promise<T>, deadlineMs: number, what: string): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  let lastErr: unknown;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (Date.now() > deadline) {
        throw new Error(`${what} が ${deadlineMs}ms 内に応えませんでした: ${String(lastErr)}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** 公開された web のポート越しに `/api/instance` を取る。 */
async function fetchInstanceViaPublishedPort(project: string): Promise<InstanceInfo> {
  const portResult = childProcess.spawnSync(
    "docker",
    composeArgs(project, ["port", "web", "4200"]),
    { encoding: "utf8", timeout: 30_000 }
  );
  if (portResult.status !== 0 || !portResult.stdout.trim()) {
    throw new Error(`web の公開ポートを引けません: ${portResult.stderr}`);
  }
  const publishedPort = Number(portResult.stdout.trim().split(":").pop());
  assert.ok(Number.isFinite(publishedPort) && publishedPort > 0, `公開ポートの形が想定と違う: ${portResult.stdout}`);

  const res = await fetch(`http://127.0.0.1:${publishedPort}/api/instance`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`公開URL越しの /api/instance が ${res.status} を返した`);
  return (await res.json()) as InstanceInfo;
}

/** compose 内の `host` サービス自身に、直接（web を経由せず）自分の同一性を聞く。 */
async function fetchInstanceFromHostContainer(project: string): Promise<InstanceInfo> {
  const exec = childProcess.spawnSync(
    "docker",
    composeArgs(project, [
      "exec",
      "-T",
      "host",
      "node",
      "-e",
      "fetch('http://127.0.0.1:4100/api/instance').then(r=>r.text()).then(t=>process.stdout.write(t))",
    ]),
    { encoding: "utf8", timeout: 30_000 }
  );
  if (exec.status !== 0 || !exec.stdout.trim()) {
    throw new Error(`host コンテナの中から /api/instance が取れません（exit ${exec.status}）: ${exec.stderr}`);
  }
  return JSON.parse(exec.stdout) as InstanceInfo;
}

describe("[task-0301] dev で立つのは本物の banto-host（本番ではない）", () => {
  let pool: EnvironmentPool | undefined;
  // `ProvisionResult` は `@banto/environment-pool` から公開されていないので、
  // ここで使うぶんだけの形で受ける（`pool.provision()` の実際の返り値は構造的にこれを満たす）
  let env: { envId: string; healthcheck: { ok: boolean; detail?: string } } | undefined;
  let dataDir: string;
  let project: string;

  before(async () => {
    requireDockerCompose();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-devbranchhost-pool-"));
    // 2サービス（web・host）分の立ち上げ・畳みを持つので、単一サービスの docker 試験より
    // 長めに取る
    pool = new EnvironmentPool({ dataDir, driverTimeoutMs: 120_000 });
    env = await pool.provision({
      repoPath: repoRoot,
      profile: "dev",
      taskId: `t-devbranchhost-${Date.now()}`,
    });
    project = projectNameFor(env.envId);
  });

  after(async () => {
    // I3: 作った者が片付ける。畳み損ねても pool 側の後始末は試みる
    try {
      if (pool && env) await pool.teardown(env.envId);
    } finally {
      pool?.stopMaintenance();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("立った直後に使える", () => {
    assert.ok(env, "provision が結果を返していない");
    assert.equal(env!.healthcheck.ok, true, `立てた直後に使えなければならない: ${JSON.stringify(env!.healthcheck)}`);
  });

  it("公開URL越しの instanceId と、host コンテナが自分で名乗る instanceId が一致する", async () => {
    const viaWeb = await retryUntil(
      () => fetchInstanceViaPublishedPort(project),
      120_000,
      "公開URL越しの /api/instance"
    );
    const direct = await retryUntil(
      () => fetchInstanceFromHostContainer(project),
      120_000,
      "host コンテナ直接の /api/instance"
    );

    assert.ok(viaWeb.instanceId, "公開URL越しの instanceId が空");
    assert.ok(direct.instanceId, "host コンテナの instanceId が空");
    assert.equal(
      viaWeb.instanceId,
      direct.instanceId,
      "web の公開URL越しに映っているホストと、compose 内の host サービスの instanceId が違う" +
        "——web は別のホスト（本番など）を映している可能性がある"
    );
  });
});
