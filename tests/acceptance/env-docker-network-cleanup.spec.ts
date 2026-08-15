/**
 * [inc-0053] docker ドライバの teardown はプロジェクトのネットワークを確実に消す。
 *
 * 過去のテスト実行が `banto-env-task-{oneoff,wt}-*_default` ネットワークを27個
 * leak させていた。`docker compose down -v` はネットワークも畳むはずだが、
 * one-off コンテナ（`compose run --rm`）が制限時間で殺されるとクライアント側の
 * `--rm` が効かずコンテナが残り、その後の `down` がネットワークを「使用中」で
 * 畳み切れないことがある。teardown 側に、ラベルで自分のプロジェクトのものだけを
 * 拾って消す安全網を足した（`removeLeftoverNetworks`、docker-driver.ts）。
 *
 * Entry point (test-discipline rule 2, mixed story — Block A):
 *   Block A — subprocess: the docker driver is invoked as a subprocess for provision/run/teardown.
 *   Real docker daemon is observed independently via `docker network ls`.
 *
 * Real docker required — test FAILS (not skips) if docker is unavailable.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProvisionOutput } from "../../packages/banto-core/src/index.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const DOCKER_DRIVER_PATH = path.join(
  _repoRoot,
  "packages",
  "banto-environment-pool",
  "src",
  "docker-driver.ts"
);
const COMPOSE_FIXTURE = path.join(_repoRoot, "tests", "fixtures", "docker", "test-compose.yaml");
const NODE = process.execPath;

// ── Driver invocation helper (mirrors env-docker-teardown-list.spec.ts) ────────

function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  timeoutMs = 60_000
): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(
    NODE,
    ["--import", "tsx", DOCKER_DRIVER_PATH, verb],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env },
    }
  );
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function runShell(cmd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function assertDockerAvailable(): void {
  const r = runShell("docker", ["compose", "version"]);
  assert.equal(
    r.exitCode,
    0,
    `docker compose is not available on this host — test FAILS as required (I1: no skips). Error: ${r.stderr}`
  );
}

/** 指定プロジェクトのラベルが付いたネットワークの ID 一覧（残っていれば非空）。 */
function networksForProject(project: string): string[] {
  const r = runShell("docker", [
    "network", "ls",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--format", "{{.ID}}",
  ]);
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("[inc-0053] docker driver teardown cleans up leaked networks", () => {
  it("provision → run → teardown のあと、プロジェクトのネットワークが残らない", () => {
    assertDockerAvailable();
    const taskId = `task-net-clean-${Date.now()}`;

    const prov = invokeDriver("provision", { config: { compose: COMPOSE_FIXTURE }, taskId, envId: taskId }, 120_000);
    assert.equal(prov.exitCode, 0, `provision failed: ${prov.stderr}`);
    const handle = (parseOutput(prov.stdout) as ProvisionOutput).handle as { project: string };

    try {
      // provision 直後は、compose のデフォルトネットワークが立っているはず（前提の確認）
      assert.ok(
        networksForProject(handle.project).length > 0,
        `provision 直後にネットワークが見当たらない（前提が崩れている）: project=${handle.project}`
      );

      const run = invokeDriver("run", { handle, cmd: "echo network-cleanup-test" });
      assert.equal(run.exitCode, 0, `run failed: ${run.stderr}`);
    } finally {
      const td = invokeDriver("teardown", { handle }, 60_000);
      assert.equal(td.exitCode, 0, `teardown failed: ${td.stderr}`);
    }

    const left = networksForProject(handle.project);
    assert.deepEqual(
      left,
      [],
      `teardown 後にプロジェクトのネットワークが残っている（inc-0053）: project=${handle.project}, ids=${left.join(",")}`
    );
  });

  it("run が制限時間で殺されたあとも、teardown でネットワークが残らない", () => {
    assertDockerAvailable();
    const taskId = `task-net-clean-killed-${Date.now()}`;

    const prov = invokeDriver("provision", { config: { compose: COMPOSE_FIXTURE }, taskId, envId: taskId }, 120_000);
    assert.equal(prov.exitCode, 0, `provision failed: ${prov.stderr}`);
    const handle = (parseOutput(prov.stdout) as ProvisionOutput).handle as { project: string };

    try {
      // 制限時間より長いコマンドを短いタイムアウトで起こし、one-off ごと殺す
      // （env-docker-teardown-list.spec.ts の「teardown は one-off コンテナも消す」と同じ形）
      invokeDriver("run", { handle, cmd: "sleep 120" }, 4000);
    } finally {
      const td = invokeDriver("teardown", { handle }, 60_000);
      assert.equal(td.exitCode, 0, `teardown failed: ${td.stderr}`);
    }

    const left = networksForProject(handle.project);
    assert.deepEqual(
      left,
      [],
      `run を殺したあと teardown してもネットワークが残っている（inc-0053）: project=${handle.project}, ids=${left.join(",")}`
    );
  });
});
