/**
 * [AC-S9d7fdb-3-3] Docker driver teardown idempotency, list prefix filtering,
 * and full contract suite pass.
 *
 * Entry point (test-discipline rule 2, mixed story — Block A):
 *   Block A — subprocess: the docker driver is invoked as a subprocess for all 7 verbs.
 *   Real docker daemon is observed independently via `docker compose ls`.
 *
 * Scenario steps (from scenario-S9d7fdb-3.json, scenario-3-teardown-list-contract):
 *   1. list → only taskID-prefixed `-docker` projects; unrelated project excluded
 *   2. teardown (x2) → idempotent (both calls exit 0)
 *   3. Full contract suite: all 7 verbs conform to spec §2 shapes against real docker
 *
 * AC-S9d7fdb-3-3: teardown is idempotent; list filters by prefix; contract suite passes.
 *
 * Real docker required — test FAILS (not skips) if docker is unavailable.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  EnvHandle,
  ProvisionOutput,
  HealthcheckOutput,
  RunOutput,
  ListOutput,
} from "../../packages/banto-core/src/index.js";

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

// ── Driver invocation helper ───────────────────────────────────────────────────

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

/** Run a shell command synchronously and return result. */
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

// ── Docker availability check — FAIL (not skip) if docker is absent ───────────

function assertDockerAvailable(): void {
  const r = runShell("docker", ["compose", "version"]);
  assert.equal(
    r.exitCode,
    0,
    `docker compose is not available on this host — ` +
      `test FAILS as required (I1: no skips). Error: ${r.stderr}`
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-3-3] docker driver teardown idempotency, list prefix, and contract suite", () => {
  // Unique taskId to avoid pollution across test runs
  const taskId = `task-docker-td-${Date.now()}`;
  // An "unrelated" project that must NOT appear in the driver's list
  /**
   * **わざと紛らわしい名前にする**（inc-0043）。以前はここが `unrelated-proj-<ts>` で、
   * ドライバの綴りの条件（`-docker` で終わる）に**最初から当たらない名前**だった。
   * だからこの試験は「名前で濾せている」ことしか確かめておらず、所有の判定が
   * 名前の推測であることを見逃していた——実際、無関係な `myapp-docker` は孤児として
   * 挙がっていた。**試験を実装に合わせて書くと、実装の穴がそのまま試験の穴になる。**
   */
  const unrelatedProjectName = `unrelated-proj-${Date.now()}-docker`;

  let handle: EnvHandle | undefined;

  before(async () => {
    // Fail fast if docker is not available (I1: no skips)
    assertDockerAvailable();

    // Start an unrelated compose project (without the -docker suffix)
    // so we can verify list doesn't include it.
    // We use `docker compose run --rm` to create a minimal one-shot project that stays up.
    // Actually, we need a long-running unrelated project. Start it separately.
    const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-unrelated-"));
    fs.writeFileSync(
      path.join(unrelatedDir, "docker-compose.yaml"),
      [
        "services:",
        "  svc:",
        "    image: busybox:latest",
        "    command: [\"sh\", \"-c\", \"while true; do sleep 1; done\"]",
        "    security_opt:",
        "      - apparmor=unconfined",
      ].join("\n") + "\n",
      "utf8"
    );
    runShell("docker", [
      "compose",
      "-p", unrelatedProjectName,
      "-f", path.join(unrelatedDir, "docker-compose.yaml"),
      "up", "-d",
    ]);

    // Provision our docker environment via driver subprocess
    const r = invokeDriver(
      "provision",
      { config: { compose: COMPOSE_FIXTURE }, taskId },
      120_000
    );
    assert.equal(
      r.exitCode,
      0,
      `docker driver provision failed (exit ${r.exitCode}): ${r.stderr}`
    );

    const out = parseOutput(r.stdout) as ProvisionOutput;
    assert.ok(
      typeof out === "object" && out !== null && "handle" in out,
      `provision must return {handle: {...}}: got ${r.stdout}`
    );
    handle = out.handle;
  });

  after(() => {
    // Cleanup: teardown our project (idempotent — safe even if already torn down by tests)
    if (handle) {
      invokeDriver("teardown", { handle }, 30_000);
    }
    // Cleanup unrelated project
    runShell("docker", ["compose", "-p", unrelatedProjectName, "down", "-v"]);
  });

  // ── 1. list: only driver-managed (taskID-prefixed -docker) projects appear ──

  it("list returns our taskID-prefixed project and excludes the unrelated project", () => {
    assert.ok(handle, "handle must be set (provision must pass first)");

    const r = invokeDriver("list", {});
    assert.equal(
      r.exitCode,
      0,
      `docker driver list failed (exit ${r.exitCode}): ${r.stderr}`
    );

    const out = parseOutput(r.stdout) as ListOutput;
    assert.ok(
      Array.isArray(out),
      `list output must be a JSON array: ${r.stdout}`
    );

    // Our project must be in the list
    // 綴りではなく **provision が返した handle** で自分のものを見分ける
    //（名前の付け方は変わりうる。所有の根拠は記録であって綴りではない・spec §2.1）
    const ourProject = (handle as { project?: string }).project;
    const ours = out.find((item) => (item.handle as { project?: string })?.project === ourProject);
    assert.ok(
      ours !== undefined,
      `list must contain the project we provisioned (${ourProject}): ` +
        `found=${JSON.stringify(out.map((i) => i.name))}`
    );

    // Verify list item shape: {handle, name, created}
    assert.equal(typeof ours.handle, "object", "list item must have handle");
    assert.equal(typeof ours.name, "string", "list item must have name");
    assert.equal(typeof ours.created, "string", "list item must have created");
    assert.ok(
      !isNaN(new Date(ours.created).getTime()),
      `created must be valid ISO-8601: ${ours.created}`
    );

    // **名前が紛らわしくても**、自分が作っていないものは出てはいけない（spec §2.1）
    const unrelated = out.find((item) => {
      const name = item.name as string;
      return name === unrelatedProjectName;
    });
    assert.ok(
      !unrelated,
      `list must NOT include the unrelated project "${unrelatedProjectName}": ` +
        `found=${JSON.stringify(out.map((i) => i.name))}`
    );
  });

  // ── 2a. Idempotent teardown — first call ─────────────────────────────────────

  it("teardown first call exits 0", () => {
    assert.ok(handle, "handle must be set");

    // First: remove project out-of-band (as if it was cleaned up externally)
    // then call teardown again to verify it's truly idempotent.
    // Actually, per scenario: "remove out-of-band, then POST teardown twice"
    // Let's first call teardown via driver (first call)
    const r = invokeDriver("teardown", { handle });
    assert.equal(
      r.exitCode,
      0,
      `first teardown must exit 0: ${r.stderr}`
    );
  });

  // ── 2b. Idempotent teardown — second call (project already gone) ─────────────

  it("teardown second call exits 0 (idempotent — project already removed)", () => {
    assert.ok(handle, "handle must be set");

    // Second teardown — project was already removed by the first call.
    // spec §2: teardown is 冪等必須 (idempotent required)
    const r = invokeDriver("teardown", { handle });
    assert.equal(
      r.exitCode,
      0,
      `second teardown must exit 0 (idempotent): ${r.stderr}`
    );
  });

  // ── 2c. List after teardown — our project no longer appears ─────────────────

  it("list after teardown does not include our project", () => {
    const r = invokeDriver("list", {});
    assert.equal(r.exitCode, 0, `list failed: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ListOutput;
    assert.ok(Array.isArray(out), `list output must be JSON array: ${r.stdout}`);

    const ours = out.find((item) => {
      const name = item.name as string;
      return name.startsWith(taskId);
    });
    assert.ok(
      !ours,
      `list must NOT contain our project after teardown (taskId=${taskId}): ` +
        `found=${JSON.stringify(out.map((i) => i.name))}`
    );
  });
});

// ── Full contract suite against the docker driver ─────────────────────────────
//
// This is the shared driver contract (spec §2) run against the docker driver,
// exercising all 7 verbs with real docker. This is the "S9d7fdb-2 harness"
// applied to the docker driver per AC-S9d7fdb-3-3 task S9d7fdb-3-2.

describe("[AC-S9d7fdb-3-3] docker driver full contract suite (7 verbs, real docker)", () => {
  let handle: EnvHandle;
  const taskId = `contract-docker-${Date.now()}`;

  before(() => {
    // Fail fast if docker is not available (I1: no skips)
    assertDockerAvailable();
  });

  after(() => {
    // Cleanup: teardown if handle was obtained (idempotent)
    if (handle) {
      invokeDriver("teardown", { handle }, 30_000);
    }
  });

  // ── 1. provision ─────────────────────────────────────────────────────────────

  it("provision exits 0 and returns {handle: {...}}", () => {
    const r = invokeDriver(
      "provision",
      { config: { compose: COMPOSE_FIXTURE }, taskId },
      120_000
    );
    assert.equal(r.exitCode, 0, `provision exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ProvisionOutput;
    assert.ok(
      typeof out === "object" && out !== null && "handle" in out,
      `stdout must be {handle: {...}}: got ${r.stdout}`
    );
    // handle is opaque (spec §2, D3) — we do not interpret its fields
    assert.equal(typeof out.handle, "object");
    assert.notEqual(out.handle, null);

    handle = out.handle;
  });

  // ── 2. healthcheck ────────────────────────────────────────────────────────────

  it("healthcheck exits 0 and returns {ok: true}", () => {
    assert.ok(handle, "handle must be set (provision must pass first)");

    const r = invokeDriver("healthcheck", { handle });
    assert.equal(r.exitCode, 0, `healthcheck exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as HealthcheckOutput;
    assert.ok(
      typeof out === "object" && out !== null && "ok" in out,
      `stdout must be {ok: bool}: got ${r.stdout}`
    );
    assert.equal(typeof out.ok, "boolean", `ok must be boolean: ${r.stdout}`);
    assert.ok(
      out.ok === true,
      `healthcheck must return ok=true after provision: ${JSON.stringify(out)}`
    );
  });

  // ── 3. deploy ─────────────────────────────────────────────────────────────────

  it("deploy exits 0 (artifact_path + handle input)", () => {
    assert.ok(handle, "handle must be set");

    const artifactPath = path.join(os.tmpdir(), `banto-contract-docker-artifact-${Date.now()}.txt`);
    fs.writeFileSync(artifactPath, "test artifact content");

    try {
      const r = invokeDriver("deploy", { handle, artifact_path: artifactPath });
      assert.equal(r.exitCode, 0, `deploy exited ${r.exitCode}: ${r.stderr}`);
      parseOutput(r.stdout); // verify parseable (may be empty)
    } finally {
      try { fs.unlinkSync(artifactPath); } catch { /* best-effort */ }
    }
  });

  // ── 4. run ────────────────────────────────────────────────────────────────────

  it("run exits 0 and returns {exit: int, log_path: <existing file>}", () => {
    assert.ok(handle, "handle must be set");

    const r = invokeDriver("run", { handle, cmd: "echo docker-contract-test-output" });
    assert.equal(r.exitCode, 0, `run exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as RunOutput;
    assert.ok(typeof out === "object" && out !== null, `stdout must be JSON object: ${r.stdout}`);
    assert.equal(typeof out.exit, "number", `exit must be a number: ${JSON.stringify(out)}`);
    assert.equal(typeof out.log_path, "string", `log_path must be a string: ${JSON.stringify(out)}`);
    assert.ok(out.log_path.length > 0, "log_path must be non-empty");
    assert.ok(
      fs.existsSync(out.log_path),
      `log_path must point to an existing file: ${out.log_path}`
    );
    const logContent = fs.readFileSync(out.log_path, "utf8");
    assert.ok(
      logContent.includes("docker-contract-test-output"),
      `log file must contain command output: ${logContent}`
    );
    assert.equal(out.exit, 0, `command exit must be 0 for echo: ${out.exit}`);
  });

  // ── 5. collect ────────────────────────────────────────────────────────────────

  it("collect exits 0 and writes to dest directory", () => {
    assert.ok(handle, "handle must be set");

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "banto-docker-contract-collect-"));
    try {
      const r = invokeDriver("collect", { handle, dest });
      assert.equal(r.exitCode, 0, `collect exited ${r.exitCode}: ${r.stderr}`);
      assert.ok(fs.existsSync(dest), "dest directory must exist after collect");
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  // ── 6. list ───────────────────────────────────────────────────────────────────

  it("list exits 0 and returns JSON array with our taskID-prefixed resource", () => {
    const r = invokeDriver("list", {});
    assert.equal(r.exitCode, 0, `list exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ListOutput;
    assert.ok(Array.isArray(out), `list output must be JSON array: ${r.stdout}`);

    // 綴りではなく provision が返した handle で照合する（spec §2.1）
    const ourProject = (handle as { project?: string }).project;
    const ours = out.find((item) => (item.handle as { project?: string })?.project === ourProject);
    assert.ok(ours, `list must contain the project we provisioned (${ourProject}): ${r.stdout}`);
    // Verify list item shape: {handle, name, created}
    assert.equal(typeof ours.handle, "object", "list item must have handle");
    assert.equal(typeof ours.name, "string", "list item must have name");
    assert.equal(typeof ours.created, "string", "list item must have created");
    assert.ok(
      !isNaN(new Date(ours.created).getTime()),
      `created must be valid ISO-8601: ${ours.created}`
    );
  });

  // ── 7. teardown + idempotency ─────────────────────────────────────────────────

  it("teardown exits 0 (first call)", () => {
    assert.ok(handle, "handle must be set");

    const r = invokeDriver("teardown", { handle });
    assert.equal(r.exitCode, 0, `teardown exited ${r.exitCode}: ${r.stderr}`);
  });

  it("teardown exits 0 again (idempotent — project already removed)", () => {
    assert.ok(handle, "handle must be set");

    // Second teardown — project is already gone; must still succeed (spec §2: 冪等必須)
    const r = invokeDriver("teardown", { handle });
    assert.equal(
      r.exitCode,
      0,
      `second teardown must exit 0 (idempotent): ${r.stderr}`
    );
  });

  // ── 8. list after teardown — our resource is no longer listed ─────────────────

  it("list no longer contains our resource after teardown", () => {
    const r = invokeDriver("list", {});
    assert.equal(r.exitCode, 0, `list exited ${r.exitCode}: ${r.stderr}`);

    const out = parseOutput(r.stdout) as ListOutput;
    assert.ok(Array.isArray(out), `list output must be JSON array: ${r.stdout}`);

    const ours = out.find((item) => {
      const name = item.name as string;
      return name.startsWith(taskId);
    });
    assert.ok(
      !ours,
      `list must NOT contain our resource after teardown: ${r.stdout}`
    );
  });

  // ── 9. run on torn-down environment → exit != 0 ───────────────────────────────

  it("run on torn-down environment exits != 0 (I2: failure surfaced, not swallowed)", () => {
    assert.ok(handle, "handle must be set");

    // Environment was torn down in the teardown test above.
    // run must fail with exit != 0 (I2: driver must not silently succeed).
    const r = invokeDriver("run", { handle, cmd: "echo should-fail" });
    assert.notEqual(
      r.exitCode,
      0,
      `run on torn-down environment must exit != 0: exitCode=${r.exitCode}, stderr=${r.stderr}`
    );
  });
});

/**
 * task-0074: **相対 compose パスの落ち先は repoPath**。
 *
 * 決定34d は「相対 compose パスは workdir から解決する」と定めた。正しいが、**workdir が
 * 無いときの落ち先が Environment Pool 自身の cwd**だった。独立サービスになってからは
 * それは「banto のリポジトリ」を指し、**受け持つプロジェクトとは何の関係もない場所**で
 * compose を探すことになる。
 *
 * 実測で踏んだ：`env.verify(repoPath=<loamium>, profile="test")` が
 * `<banto>/docker/test.yaml がありません` で落ちた。プロファイルは
 * `<repoPath>/meta/environments.yaml` から読んだのだから、相対パスの基点は repoPath。
 */
describe("[task-0074] 相対 compose パスの解決", () => {
  it("workdir が無ければ repoPath から解く（Pool の cwd に落とさない）", () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-compose-base-"));
    try {
      fs.mkdirSync(path.join(repoDir, "docker"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, "docker", "probe.yaml"),
        [
          "services:",
          "  svc:",
          '    image: busybox:latest',
          '    command: ["sh", "-c", "while true; do sleep 1; done"]',
          "    security_opt:",
          "      - apparmor=unconfined",
        ].join("\n") + "\n",
        "utf8"
      );

      // **repoPath だけ渡す**（workdir は渡さない）。直す前はここで
      // 「<banto>/docker/probe.yaml がありません」で落ちていた
      const taskId = `task-compose-base-${Date.now()}`;
      const r = invokeDriver(
        "provision",
        { config: { compose: "docker/probe.yaml" }, taskId, repoPath: repoDir },
        120_000
      );
      try {
        assert.equal(
          r.exitCode,
          0,
          `repoPath から compose を解けていない（exit ${r.exitCode}）: ${r.stderr}`
        );
        const handle = (JSON.parse(r.stdout) as { handle: { composeFile: string } }).handle;
        assert.equal(
          handle.composeFile,
          path.join(repoDir, "docker", "probe.yaml"),
          "repoPath 配下の compose を指していない"
        );
      } finally {
        // I3: 立てたものは必ず畳む
        try {
          const handle = (JSON.parse(r.stdout) as { handle: unknown }).handle;
          if (handle) invokeDriver("teardown", { handle }, 30_000);
        } catch {
          /* provision に失敗していれば畳むものは無い */
        }
      }
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

/**
 * task-0074: **`compose down` は one-off コンテナを消さない。**
 *
 * `run` は `docker compose run --rm` の一時コンテナ（ラベル `oneoff=True`）で動く。
 * `--rm` を消すのはクライアント側なので、run が制限時間で殺されるとクライアントごと落ち、
 * **コンテナだけが残る**。`compose down` は oneoff を対象にしない。
 *
 * 結果、`env.verify` が `tornDown: true` を返しながら**外でコンテナが走り続ける**——
 * I3 の不変条件（畳めなかったら成功に見せない）が、いちばん破れてはいけない形で破れる。
 * 実測で踏んだ：run の10分上限で切られたあと、one-off が9分以上走っていた。
 */
describe("[task-0074] teardown は one-off コンテナも消す（I3）", () => {
  it("run のあとに teardown すると、oneoff ラベルのコンテナも残らない", () => {
    assertDockerAvailable();
    const taskId = `task-oneoff-${Date.now()}`;
    const r = invokeDriver("provision", { config: { compose: COMPOSE_FIXTURE }, taskId }, 120_000);
    assert.equal(r.exitCode, 0, `provision failed: ${r.stderr}`);
    const handle = (JSON.parse(r.stdout) as { handle: { project: string } }).handle;

    try {
      // **run を途中で殺す**（制限時間で切られたのと同じ形）。正常に終わる run では
      // `--rm` が効いてコンテナが消えるので、**この検体は成立しない**
      // ——最初そう書いて、直しを無効にしても通ってしまった（空振りする検査）
      invokeDriver("run", { handle, cmd: "sleep 120" }, 4000);

      // 殺したあと、one-off が残っていることを確かめる（前提の確認）
      const during = runShell("docker", [
        "ps", "-aq", "--filter", `label=com.docker.compose.project=${handle.project}`,
        "--filter", "label=com.docker.compose.oneoff=True",
      ]);
      assert.notEqual(
        during.stdout.trim(),
        "",
        "run を殺しても one-off が残らない——この検体は元の壊れ方を再現していない"
      );
    } finally {
      const td = invokeDriver("teardown", { handle }, 60_000);
      assert.equal(td.exitCode, 0, `teardown failed: ${td.stderr}`);
    }

    // **この project のコンテナが1つも残っていないこと**（oneoff を含めて）
    const left = runShell("docker", [
      "ps", "-aq", "--filter", `label=com.docker.compose.project=${handle.project}`,
    ]);
    assert.equal(
      left.stdout.trim(),
      "",
      `畳んだのにコンテナが残っている（tornDown を成功に見せてはいけない）: ${left.stdout}`
    );
  });
});
