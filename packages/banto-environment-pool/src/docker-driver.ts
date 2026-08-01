#!/usr/bin/env node
/**
 * Builtin `docker` environment driver — spec-environment §2, §3.
 *
 * Invoked as a subprocess by the daemon:
 *   node --import tsx docker-driver.ts <verb>
 *
 * Input:  stdin JSON per spec §2 (field names FIXED per D1)
 * Output: stdout JSON per spec §2
 * Exit:   0 = success, 1 = failure (I2: failures are never swallowed as exit 0)
 *
 * Handle shape: { project: string, composeFile: string, name: string, taskId: string, created: string }
 *   - project:     docker compose project name (taskID-prefixed, I3)
 *   - composeFile: absolute path to the compose YAML file
 *   - name:        same as project (taskID-prefixed resource name — I3)
 *   - taskId:      the task this environment belongs to
 *   - created:     ISO-8601 timestamp of provision
 *
 * D6: node:child_process, node:fs, node:path only (no npm deps). docker CLI is
 *     already on the host (same host-tool assumption as the process driver's node/shell).
 *     Reason: D6 "no SDK dep" — shell-out to `docker compose` CLI uses the
 *     installed CLI, inherits compose file compatibility, and avoids the dockerode npm dep.
 * I3: all managed resources carry a `<taskId>-docker` project name prefix.
 * I2: teardown is idempotent — already-gone project is a success (exit 0).
 * I2: a failed compose command is always surfaced as a non-zero exit (never silent skip).
 *
 * HOST CONSTRAINT: This VM cannot load the docker-default AppArmor profile
 * (/sys/kernel/security unmounted). Containers MUST include security_opt:
 * [apparmor=unconfined] in their compose service definition (supplied by the
 * compose file — the driver passes the file as-is). The run verb uses
 * `docker compose run --rm` (spawns a one-shot container) rather than
 * `docker compose exec` (which fails with AppArmor on this host regardless of
 * the container's security_opt setting).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import * as os from "node:os";

// ── Handle shape ──────────────────────────────────────────────────────────────

interface DockerHandle {
  project: string;      // docker compose project name (taskID-prefixed)
  composeFile: string;  // absolute path to compose YAML
  name: string;         // same as project (I3: named resource identifier)
  taskId: string;
  created: string;      // ISO-8601
  /** どこで動かすか（決定34d）。compose の相対パス解決と run の cwd に使う */
  workdir?: string;
}

// ── Docker compose project naming (I3) ────────────────────────────────────────
//
// The compose project name is: `<taskId>-docker`
// This gives us the taskID prefix required by I3, and a stable name for list/teardown.

function projectName(taskId: string): string {
  return `${taskId}-docker`;
}

// ── Shell-out helper (sync) ───────────────────────────────────────────────────
//
// All compose commands are synchronous — the driver is a one-shot subprocess.
// D6: stdlib child_process.spawnSync only.

interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCmd(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): CmdResult {
  const result = childProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 120_000, // compose pulls can take time
    maxBuffer: 10 * 1024 * 1024,
    env: opts.env ?? { ...process.env },
  });

  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

// ── compose command builder ───────────────────────────────────────────────────

/** ログを残す期間。過ぎたものは自分で捨てる（放っておくと際限なく溜まる）。 */
const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000;

/**
 * 自分が書いたログのうち、保存期間を過ぎたものを捨てる。
 *
 * **ここでやるのが自然。** ログを置いた場所を知っているのはドライバだけで、
 * 呼び出し側はパスを受け取るだけ（`run` の `log_path`）。以前は「掃除は別ストーリー」と
 * 書かれたまま実装されず、1,600ファイル以上溜まっていた。
 */
function pruneOldLogs(dir: string): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > LOG_RETENTION_MS) fs.rmSync(file, { force: true });
      } catch { /* 消せなくても検証は続ける（best-effort） */ }
    }
  } catch { /* ディレクトリがまだ無い */ }
}

/**
 * Build args for `docker compose -p <project> [-f <file>] <subcommand...>`.
 * Pass composeFile as undefined to omit -f (e.g. for teardown when file may be gone).
 */
function composeArgs(
  project: string,
  composeFile: string | undefined,
  subcommand: string[]
): string[] {
  const args = ["compose", "-p", project];
  if (composeFile) {
    args.push("-f", composeFile);
  }
  args.push(...subcommand);
  return args;
}

// ── stdin reader ──────────────────────────────────────────────────────────────

function readStdinSync(): unknown {
  try {
    const raw = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`docker-driver: failed to read stdin: ${String(err)}\n`);
    process.exit(1);
  }
}

// ── Verb handlers ─────────────────────────────────────────────────────────────

function handleProvision(input: Record<string, unknown>): void {
  const config = input["config"] as Record<string, unknown> | undefined;
  const taskId = input["taskId"] as string | undefined;
  if (!config || !taskId) {
    process.stderr.write("docker-driver provision: missing config or taskId\n");
    process.exit(1);
  }

  const composePath = config["compose"] as string | undefined;
  if (!composePath) {
    process.stderr.write("docker-driver provision: config.compose (path to compose YAML) is required\n");
    process.exit(1);
  }

  // 決定34d: 相対 compose パスは workdir から解決する。省略時は従来どおり自分の cwd
  // ——ここが Environment Pool の cwd 固定だったせいで、番頭は「職人が作った worktree で
  // 検証して」を頼めなかった
  const workdir = input["workdir"] as string | undefined;
  const composeFile = path.isAbsolute(composePath)
    ? composePath
    : path.resolve(workdir ?? process.cwd(), composePath);

  if (!fs.existsSync(composeFile)) {
    process.stderr.write(`docker-driver provision: compose file not found: ${composeFile}\n`);
    process.exit(1);
  }

  const project = projectName(taskId);

  // `docker compose up -d` — starts all services in the background
  const r = runCmd("docker", composeArgs(project, composeFile, ["up", "-d"]), workdir ? { cwd: workdir } : {});
  if (r.exitCode !== 0) {
    process.stderr.write(
      `docker-driver provision: docker compose up failed (exit ${r.exitCode}):\n${r.stderr}\n`
    );
    process.exit(1);
  }

  const created = new Date().toISOString();
  const handle: DockerHandle = {
    project,
    composeFile,
    name: project,
    taskId,
    created,
    ...(workdir ? { workdir } : {}),
  };

  process.stdout.write(JSON.stringify({ handle }) + "\n");
}

function handleDeploy(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  if (!handle) {
    process.stderr.write("docker-driver deploy: missing handle\n");
    process.exit(1);
  }
  // Deploy is a no-op for the docker driver.
  // The compose environment is already running from provision.
  // artifact_path is accepted but not used.
  process.stdout.write(JSON.stringify({}) + "\n");
}

function handleHealthcheck(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  if (!handle) {
    process.stderr.write("docker-driver healthcheck: missing handle\n");
    process.exit(1);
  }

  const { project, composeFile } = handle;

  // Use `docker compose ps --format json` to check container states.
  // If all containers are in a running/healthy state → ok: true.
  // If no containers or any is not running → ok: false.
  const r = runCmd("docker", composeArgs(project, composeFile, ["ps", "--format", "json"]));
  if (r.exitCode !== 0) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        detail: `docker compose ps failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
      }) + "\n"
    );
    return;
  }

  const raw = r.stdout.trim();
  if (!raw) {
    // No containers running
    process.stdout.write(
      JSON.stringify({ ok: false, detail: "no containers found for project" }) + "\n"
    );
    return;
  }

  // docker compose ps --format json outputs one JSON object per line (NDJSON) or a JSON array.
  // Normalize to an array.
  let containers: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      containers = parsed as Array<Record<string, unknown>>;
    } else {
      // Single object
      containers = [parsed as Record<string, unknown>];
    }
  } catch {
    // May be NDJSON (one object per line)
    try {
      containers = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch (err2) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          detail: `could not parse docker compose ps output: ${String(err2)}`,
        }) + "\n"
      );
      return;
    }
  }

  if (containers.length === 0) {
    process.stdout.write(
      JSON.stringify({ ok: false, detail: "no containers found for project" }) + "\n"
    );
    return;
  }

  // Check all containers are in "running" state
  const notRunning = containers.filter((c) => {
    const state = (c["State"] as string | undefined)?.toLowerCase();
    return state !== "running";
  });

  if (notRunning.length > 0) {
    const detail = notRunning
      .map((c) => `${String(c["Name"] ?? "?")}=${String(c["State"] ?? "?")}`)
      .join(", ");
    process.stdout.write(
      JSON.stringify({ ok: false, detail: `containers not running: ${detail}` }) + "\n"
    );
    return;
  }

  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

function handleRun(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  const cmd = input["cmd"] as string | undefined;
  if (!handle || !cmd) {
    process.stderr.write("docker-driver run: missing handle or cmd\n");
    process.exit(1);
  }

  const { project, composeFile } = handle;

  // Before running, verify the compose project has at least one running container.
  // I2: if the project is torn down (no running containers), run must fail with
  // a non-zero exit — not silently succeed by spinning up new containers.
  // This mirrors the process driver's liveness check (isAlive(pid)) before run.
  const psCheck = runCmd("docker", composeArgs(project, composeFile, ["ps", "--format", "json"]));
  if (psCheck.exitCode !== 0) {
    process.stderr.write(
      `docker-driver run: compose project "${project}" not accessible ` +
        `(exit ${psCheck.exitCode}): ${psCheck.stderr}\n`
    );
    process.exit(1);
  }

  // Check if there are running containers
  const psRaw = psCheck.stdout.trim();
  let runningCount = 0;
  if (psRaw) {
    try {
      const parsed = JSON.parse(psRaw);
      const containers = Array.isArray(parsed) ? parsed : [parsed];
      runningCount = containers.filter((c: Record<string, unknown>) => {
        const state = (c["State"] as string | undefined)?.toLowerCase();
        return state === "running";
      }).length;
    } catch {
      // NDJSON format
      try {
        const lines = psRaw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        for (const line of lines) {
          const c = JSON.parse(line) as Record<string, unknown>;
          const state = (c["State"] as string | undefined)?.toLowerCase();
          if (state === "running") runningCount++;
        }
      } catch { /* no running containers parseable */ }
    }
  }

  if (runningCount === 0) {
    // I2: environment not alive → fail with non-zero exit
    process.stderr.write(
      `docker-driver run: no running containers found for project "${project}" ` +
        `(environment may have been torn down or not yet provisioned)\n`
    );
    process.exit(1);
  }

  // First determine the service name from the compose file to use with compose run.
  // We pick the first service in the compose file.
  // D1: the compose file is the user's source of truth for what's in the environment.
  let serviceName: string | undefined;
  try {
    const raw = fs.readFileSync(composeFile, "utf8");
    // Simple YAML service extraction — find the first key under "services:"
    // D6: avoid adding a YAML parser dep; regex is sufficient for this well-structured case.
    // The compose file has known shape: `services:\n  <service>:\n`
    const match = raw.match(/^services:\s*\n\s+([a-zA-Z0-9_-]+)\s*:/m);
    if (match) {
      serviceName = match[1];
    }
  } catch {
    // If we can't read the compose file, fall back to getting from docker ps
  }

  if (!serviceName) {
    // Fall back: query running containers and pick the first service name from labels
    const psResult = runCmd("docker", [
      "ps",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--format", "{{.Label \"com.docker.compose.service\"}}",
    ]);
    if (psResult.exitCode === 0 && psResult.stdout.trim()) {
      serviceName = psResult.stdout.trim().split("\n")[0]?.trim();
    }
  }

  if (!serviceName) {
    process.stderr.write(`docker-driver run: could not determine service name for project ${project}\n`);
    process.exit(1);
  }

  // Write output to a taskId-scoped temp log file so concurrent tasks do not
  // cross-contaminate each other's collected logs.
  // Log file cleanup is deferred to Story S9d7fdb-5 (reconcile/TTL wave).
  const logDir = path.join(os.tmpdir(), "banto-docker-driver-logs");
  fs.mkdirSync(logDir, { recursive: true });
  pruneOldLogs(logDir);
  const logPath = path.join(
    logDir,
    `${handle.taskId}-run-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
  );

  // Use `docker compose run --rm <service> sh -c <cmd>` to execute a command
  // inside a fresh one-shot container that shares the compose environment.
  //
  // NOTE: `docker compose exec` is NOT used here because on this host the
  // docker daemon fails to run exec with the AppArmor check even when
  // the container has security_opt: [apparmor=unconfined]. `compose run --rm`
  // spawns a one-shot sibling container from the service definition (which
  // inherits the security_opt) and exits with the command's exit code.
  //
  // SEMANTIC CONSEQUENCE: a one-shot sibling shares volumes+network but NOT the
  // running container's writable layer, so `run` does not observe in-container
  // filesystem state written after `provision`; revisit (use `compose exec`)
  // when the host can load AppArmor profiles. Tracked as a backlog item by the
  // sprint. (I2: non-zero exit is not swallowed — it is returned faithfully in
  // the response body.)
  // 決定34d: compose を解決した場所で回す。handle に残した workdir を既定にするので、
  // 後続の run が毎回 workdir を渡さなくても provision と同じ場所で動く
  const runWorkdir = (input["workdir"] as string | undefined) ?? handle.workdir;
  const r = runCmd(
    "docker",
    composeArgs(project, composeFile, ["run", "--rm", "--no-TTY", serviceName, "sh", "-c", cmd]),
    runWorkdir ? { cwd: runWorkdir } : {}
  );

  // Capture combined stdout+stderr as the log
  const output = (r.stdout) + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
  fs.writeFileSync(logPath, output, "utf8");

  // I2: exit code is reported as-is, never normalized to 0 on failure
  process.stdout.write(JSON.stringify({ exit: r.exitCode, log_path: logPath }) + "\n");
}

function handleCollect(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  const dest = input["dest"] as string | undefined;
  if (!handle || !dest) {
    process.stderr.write("docker-driver collect: missing handle or dest\n");
    process.exit(1);
  }

  // D3: daemon decides the dest path; driver writes to it.
  fs.mkdirSync(dest, { recursive: true });

  // Collect only run log files belonging to this task (taskId-prefixed filenames).
  // Log files are named `${taskId}-run-<timestamp>-<random>.log` (written in
  // handleRun). The taskId prefix ensures two concurrent tasks do not
  // cross-contaminate each other's collected logs.
  // Log file cleanup is deferred (Story S9d7fdb-5).
  const { taskId } = handle;
  const taskLogPrefix = `${taskId}-run-`;
  const logDir = path.join(os.tmpdir(), "banto-docker-driver-logs");
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith(taskLogPrefix));
    for (const file of files) {
      fs.copyFileSync(path.join(logDir, file), path.join(dest, file));
    }
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

function handleTeardown(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  if (!handle) {
    process.stderr.write("docker-driver teardown: missing handle\n");
    process.exit(1);
  }

  const { project, composeFile } = handle;

  // `docker compose down -v` stops and removes containers, networks, and volumes.
  // Idempotent: exits 0 even if the project no longer exists (I3).
  // We first try with the compose file; if that's gone, fall back to project-only.
  let r: CmdResult;
  if (composeFile && fs.existsSync(composeFile)) {
    r = runCmd("docker", composeArgs(project, composeFile, ["down", "-v"]));
  } else {
    // Compose file may be gone or was never known — use project name only.
    // `docker compose -p <proj> down -v` without -f still works for teardown.
    r = runCmd("docker", composeArgs(project, undefined, ["down", "-v"]));
  }

  if (r.exitCode !== 0) {
    // I2: teardown failure is always surfaced as a non-zero exit
    process.stderr.write(
      `docker-driver teardown: docker compose down failed (exit ${r.exitCode}):\n${r.stderr}\n`
    );
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

function handleList(_input: Record<string, unknown>): void {
  // Use `docker compose ls --format json` to enumerate all compose projects.
  // Then filter to only those whose name starts with a taskID prefix pattern.
  // Per spec §2 and I3: list returns all driver-managed resources (taskID-prefixed).
  // The naming pattern for this driver is: <taskId>-docker (see projectName()).
  // We cannot filter by a specific taskId since list has no taskId input (spec §2).
  // Instead, we return ALL `<*>-docker` projects — the daemon reconciles against
  // its ledger to identify which belong to which task.

  const r = runCmd("docker", ["compose", "ls", "--format", "json"]);
  if (r.exitCode !== 0) {
    process.stderr.write(
      `docker-driver list: docker compose ls failed (exit ${r.exitCode}):\n${r.stderr}\n`
    );
    process.exit(1);
  }

  const raw = r.stdout.trim();
  let projects: Array<Record<string, unknown>> = [];

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        projects = parsed as Array<Record<string, unknown>>;
      } else if (typeof parsed === "object" && parsed !== null) {
        projects = [parsed as Record<string, unknown>];
      }
    } catch {
      // Empty or malformed output → empty list (idempotent)
    }
  }

  // Filter: only projects whose name ends with `-docker` (driver-managed)
  // This is our naming convention (I3): projectName(taskId) = `${taskId}-docker`
  const managed = projects.filter((p) => {
    const name = p["Name"] as string | undefined;
    return typeof name === "string" && name.endsWith("-docker");
  });

  // Build the list output shape per spec §2: [{handle, name, created}]
  // D3: handle is opaque to daemon; we return the project name as the lookup key.
  // Since `docker compose ls` does not return creation timestamps, we use a sentinel
  // ISO-8601 string derived from when the container was started.
  // To get creation time, we query docker ps for the project.
  const items = managed.map((p) => {
    const name = p["Name"] as string;

    // Try to get the creation time from docker ps
    const psResult = runCmd("docker", [
      "ps", "-a",
      "--filter", `label=com.docker.compose.project=${name}`,
      "--format", "{{.CreatedAt}}",
      "--no-trunc",
    ]);

    let created = new Date().toISOString(); // fallback
    if (psResult.exitCode === 0 && psResult.stdout.trim()) {
      const firstLine = psResult.stdout.trim().split("\n")[0]?.trim();
      if (firstLine) {
        // Docker CreatedAt format: "2026-07-24 14:00:00 +0000 UTC"
        // Parse and convert to ISO-8601
        const parsed = new Date(firstLine);
        if (!isNaN(parsed.getTime())) {
          created = parsed.toISOString();
        }
      }
    }

    // The handle for list items: minimal shape that allows teardown if needed
    const handle: Record<string, unknown> = {
      project: name,
      composeFile: (p["ConfigFiles"] as string | undefined) ?? "",
      name,
      taskId: name.replace(/-docker$/, ""), // reverse-engineer taskId from project name
      created,
    };

    return { handle, name, created };
  });

  process.stdout.write(JSON.stringify(items) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const verb = process.argv[2];
  if (!verb) {
    process.stderr.write("docker-driver: verb argument required\n");
    process.exit(1);
  }

  // Read stdin (synchronous — this is a one-shot subprocess)
  const raw = readStdinSync();
  const input: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  try {
    switch (verb) {
      case "provision":
        handleProvision(input);
        break;
      case "deploy":
        handleDeploy(input);
        break;
      case "healthcheck":
        handleHealthcheck(input);
        break;
      case "run":
        handleRun(input);
        break;
      case "collect":
        handleCollect(input);
        break;
      case "teardown":
        handleTeardown(input);
        break;
      case "list":
        handleList(input);
        break;
      default:
        process.stderr.write(`docker-driver: unknown verb: ${verb}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`docker-driver ${verb} error: ${String(err)}\n`);
    process.exit(1);
  }
}

main();
