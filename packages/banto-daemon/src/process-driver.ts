#!/usr/bin/env node
/**
 * Builtin `process` environment driver — spec-environment §2, §3.
 *
 * Invoked as a subprocess by the daemon:
 *   node --import tsx process-driver.ts <verb>
 *
 * Input:  stdin JSON per spec §2 (field names FIXED per D1)
 * Output: stdout JSON per spec §2
 * Exit:   0 = success, 1 = failure (I2: failures are never swallowed as exit 0)
 *
 * Handle shape: { pid: number, name: string, taskId: string }
 *   - pid: OS pid of the launched process
 *   - name: taskID-prefixed resource name (I3: mandatory prefix for list/cleanup)
 *   - taskId: the task this environment belongs to
 *
 * D6: node:child_process, node:net, node:fs, node:path only (no npm deps).
 * I3: all managed resources carry a `<taskId>-env` naming prefix.
 * I2: teardown is idempotent — already-gone process is a success (exit 0).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as childProcess from "node:child_process";
import * as os from "node:os";

// ── Process state file (for list/idempotent teardown) ────────────────────────
//
// All managed processes are tracked in a JSON file under the system temp dir.
// This allows `list` to enumerate them across separate driver invocations.
// D3: the state file is the single truth for what the process driver manages.

const STATE_FILE = path.join(os.tmpdir(), "banto-process-driver-state.json");

interface ProcessEntry {
  pid: number;
  name: string;
  taskId: string;
  cmd: string;
  port?: number;
  created: string;
}

function readState(): ProcessEntry[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ProcessEntry[];
  } catch {
    return [];
  }
}

function writeState(entries: ProcessEntry[]): void {
  // Atomic write: tmp + rename (same pattern as spawn-ledger.ts)
  const tmpPath = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), { encoding: "utf8" });
    fs.renameSync(tmpPath, STATE_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

function addEntry(entry: ProcessEntry): void {
  const entries = readState().filter((e) => e.name !== entry.name);
  entries.push(entry);
  writeState(entries);
}

function removeEntry(name: string): void {
  const entries = readState().filter((e) => e.name !== name);
  writeState(entries);
}

// ── Process liveness (mirrors spawn-ledger's isProcessAlive) ─────────────────

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // exists, different owner
    return false; // ESRCH → gone
  }
}

// ── SIGTERM → SIGKILL idempotent teardown (mirrors killOrphanProcess) ────────

async function killProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return; // already gone → idempotent success
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // gone between check and kill
  }
  // Wait up to 3 s for SIGTERM, then SIGKILL
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
    if (!isAlive(pid)) return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch { /* already gone */ }
  await new Promise<void>((r) => setTimeout(r, 200));
}

// ── Port reachability check ───────────────────────────────────────────────────

function checkPortOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (val: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(val);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}

// ── stdin reader ──────────────────────────────────────────────────────────────

async function readStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`process-driver: invalid JSON on stdin: ${String(err)}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// ── Verb handlers ─────────────────────────────────────────────────────────────

async function handleProvision(input: Record<string, unknown>): Promise<void> {
  const config = input["config"] as Record<string, unknown> | undefined;
  const taskId = input["taskId"] as string | undefined;
  if (!config || !taskId) {
    process.stderr.write("process-driver provision: missing config or taskId\n");
    process.exit(1);
  }

  const cmd = config["cmd"] as string | undefined;
  const port = config["port"] as number | undefined;
  if (!cmd) {
    process.stderr.write("process-driver provision: config.cmd is required\n");
    process.exit(1);
  }

  // Resource name carries the taskID prefix (I3)
  const name = `${taskId}-env`;

  // Spawn the process. Use shell=true to handle compound commands.
  // D6: node:child_process stdlib.
  const child = childProcess.spawn(cmd, [], {
    shell: true,
    detached: true,  // detach so it outlives this driver invocation
    stdio: ["ignore", "ignore", "ignore"],
  });

  // Wait briefly for the process to start and check it hasn't crashed immediately
  await new Promise<void>((r) => setTimeout(r, 200));

  // Check if the child is still alive
  if (child.pid === undefined || !isAlive(child.pid)) {
    process.stderr.write(`process-driver provision: command failed to start: ${cmd}\n`);
    process.exit(1);
  }

  child.unref(); // let it run independently

  const entry: ProcessEntry = {
    pid: child.pid,
    name,
    taskId,
    cmd,
    port,
    created: new Date().toISOString(),
  };
  addEntry(entry);

  const handle: Record<string, unknown> = { pid: child.pid, name, taskId };
  if (port !== undefined) handle["port"] = port;

  process.stdout.write(JSON.stringify({ handle }) + "\n");
}

async function handleDeploy(input: Record<string, unknown>): Promise<void> {
  // Deploy: for the process driver, deploy is a no-op.
  // The process is already running from provision.
  // artifact_path is accepted but not used (process driver runs in-place).
  const handle = input["handle"] as Record<string, unknown> | undefined;
  if (!handle) {
    process.stderr.write("process-driver deploy: missing handle\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({}) + "\n");
}

async function handleHealthcheck(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  if (!handle) {
    process.stderr.write("process-driver healthcheck: missing handle\n");
    process.exit(1);
  }

  const pid = handle["pid"] as number | undefined;
  const port = handle["port"] as number | undefined;

  if (pid === undefined) {
    process.stdout.write(JSON.stringify({ ok: false, detail: "handle missing pid" }) + "\n");
    return;
  }

  // Check process is alive
  if (!isAlive(pid)) {
    process.stdout.write(JSON.stringify({ ok: false, detail: `pid ${pid} not alive` }) + "\n");
    return;
  }

  // If a port is declared, also check TCP reachability
  if (port !== undefined) {
    const open = await checkPortOpen(port);
    if (!open) {
      process.stdout.write(
        JSON.stringify({ ok: false, detail: `port ${port} not reachable` }) + "\n"
      );
      return;
    }
  }

  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

async function handleRun(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  const cmd = input["cmd"] as string | undefined;
  if (!handle || !cmd) {
    process.stderr.write("process-driver run: missing handle or cmd\n");
    process.exit(1);
  }

  const pid = handle["pid"] as number | undefined;
  if (pid === undefined || !isAlive(pid)) {
    // I2: non-zero exit when the environment is gone (scenario-1 step 4)
    process.stderr.write("process-driver run: environment not alive\n");
    process.exit(1);
  }

  // Write output to a temp log file
  const logDir = path.join(os.tmpdir(), "banto-process-driver-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);

  // Run the command and capture stdout+stderr
  const result = childProcess.spawnSync(cmd, [], {
    shell: true,
    encoding: "utf8",
    // Large buffer to capture all output
    maxBuffer: 10 * 1024 * 1024,
  });

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  fs.writeFileSync(logPath, output, "utf8");

  const exitCode = result.status ?? 1;
  process.stdout.write(JSON.stringify({ exit: exitCode, log_path: logPath }) + "\n");
}

async function handleCollect(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  const dest = input["dest"] as string | undefined;
  if (!handle || !dest) {
    process.stderr.write("process-driver collect: missing handle or dest\n");
    process.exit(1);
  }

  // For the process driver, collect copies any available log files to dest.
  // D3: the driver writes to the dest directory provided; daemon decides the path.
  fs.mkdirSync(dest, { recursive: true });

  const logDir = path.join(os.tmpdir(), "banto-process-driver-logs");
  if (fs.existsSync(logDir)) {
    const taskId = handle["taskId"] as string | undefined;
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith("run-"));
    for (const file of files) {
      // Copy relevant log files to dest
      if (taskId) {
        // Copy all run logs (dest is already task-scoped by daemon)
        fs.copyFileSync(path.join(logDir, file), path.join(dest, file));
      }
    }
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

async function handleTeardown(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  if (!handle) {
    process.stderr.write("process-driver teardown: missing handle\n");
    process.exit(1);
  }

  const pid = handle["pid"] as number | undefined;
  const name = handle["name"] as string | undefined;

  // Idempotent: if pid is undefined or process is already gone, still succeed (I3)
  if (pid !== undefined) {
    await killProcess(pid);
  }

  // Remove from state file (idempotent — removeEntry handles missing entries)
  if (name) {
    removeEntry(name);
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

async function handleList(_input: Record<string, unknown>): Promise<void> {
  const entries = readState();

  // Filter to only entries for alive processes (prune stale ones)
  // Note: we do NOT prune here — list returns ALL tracked entries, alive or not.
  // Reconciliation is daemon's responsibility (spec §5).
  // However, we do annotate each entry with its handle shape.
  const items = entries.map((e) => {
    const handle: Record<string, unknown> = { pid: e.pid, name: e.name, taskId: e.taskId };
    if (e.port !== undefined) handle["port"] = e.port;
    return {
      handle,
      name: e.name,
      created: e.created,
    };
  });

  process.stdout.write(JSON.stringify(items) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verb = process.argv[2];
  if (!verb) {
    process.stderr.write("process-driver: verb argument required\n");
    process.exit(1);
  }

  // Read stdin once for all verbs
  let input: Record<string, unknown>;
  try {
    const raw = await readStdin();
    input = (typeof raw === "object" && raw !== null && !Array.isArray(raw))
      ? (raw as Record<string, unknown>)
      : {};
  } catch (err) {
    process.stderr.write(`process-driver: stdin read error: ${String(err)}\n`);
    process.exit(1);
  }

  try {
    switch (verb) {
      case "provision":
        await handleProvision(input);
        break;
      case "deploy":
        await handleDeploy(input);
        break;
      case "healthcheck":
        await handleHealthcheck(input);
        break;
      case "run":
        await handleRun(input);
        break;
      case "collect":
        await handleCollect(input);
        break;
      case "teardown":
        await handleTeardown(input);
        break;
      case "list":
        await handleList(input);
        break;
      default:
        process.stderr.write(`process-driver: unknown verb: ${verb}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`process-driver ${verb} error: ${String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`process-driver fatal: ${String(err)}\n`);
  process.exit(1);
});
