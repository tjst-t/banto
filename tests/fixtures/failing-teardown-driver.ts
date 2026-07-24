#!/usr/bin/env node
/**
 * Test fixture: a driver whose teardown ALWAYS fails with exit 1.
 *
 * Used by AC-S9d7fdb-5-2 to verify that:
 *   - teardown failures are retried (bounded)
 *   - after retry exhaustion, a cadence card is filed and the ledger entry
 *     is marked teardownFailed (not silently removed)
 *
 * Other verbs are functional so that provision/healthcheck/list work
 * normally (the test can set up the environment, then let TTL expiry
 * trigger the forced teardown which will fail).
 *
 * Verb routing:
 *   provision   → success: returns a handle with a sentinel pid (-1) and a name
 *   healthcheck → success: { ok: true }
 *   teardown    → ALWAYS exits 1 ("simulated teardown failure")
 *   list        → returns the current state file entries
 *   run/deploy/collect → success (no-op)
 *
 * State file: uses the same banto-process-driver-state.json as the real process
 * driver to allow interop (tests may need to plant entries for orphan detection).
 *
 * D6: node:fs, node:path, node:os — no npm deps.
 * I2: teardown failure is explicit (exit 1), never swallowed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── State file (same as process-driver for interop) ───────────────────────────

const STATE_FILE_ENV = process.env["BANTO_FAILING_DRIVER_STATE_FILE"];
const STATE_FILE = STATE_FILE_ENV ?? path.join(os.tmpdir(), "banto-failing-teardown-driver-state.json");

interface DriverEntry {
  name: string;
  taskId: string;
  created: string;
}

function readState(): DriverEntry[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as DriverEntry[];
  } catch {
    return [];
  }
}

function writeState(entries: DriverEntry[]): void {
  const tmpPath = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), { encoding: "utf8" });
    fs.renameSync(tmpPath, STATE_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

// ── stdin reader ──────────────────────────────────────────────────────────────

async function readStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => {
      if (!data.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new Error(`failing-teardown-driver: invalid JSON on stdin: ${String(err)}`)); }
    });
    process.stdin.on("error", reject);
  });
}

// ── Verb handlers ─────────────────────────────────────────────────────────────

async function handleProvision(input: Record<string, unknown>): Promise<void> {
  const taskId = input["taskId"] as string | undefined;
  if (!taskId) {
    process.stderr.write("failing-teardown-driver provision: missing taskId\n");
    process.exit(1);
  }

  const name = `${taskId}-failing-env`;
  const entry: DriverEntry = { name, taskId, created: new Date().toISOString() };
  const entries = readState().filter((e) => e.name !== name);
  entries.push(entry);
  writeState(entries);

  // Use pid -1 as a sentinel (no real OS process)
  const handle = { pid: -1, name, taskId };
  process.stdout.write(JSON.stringify({ handle }) + "\n");
}

async function handleHealthcheck(_input: Record<string, unknown>): Promise<void> {
  // Always reports healthy so provisioning succeeds
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

async function handleTeardown(_input: Record<string, unknown>): Promise<void> {
  // ALWAYS FAILS — this is the point of this fixture
  process.stderr.write("failing-teardown-driver: simulated teardown failure\n");
  process.exit(1);
}

async function handleList(_input: Record<string, unknown>): Promise<void> {
  const entries = readState();
  const items = entries.map((e) => ({
    handle: { pid: -1, name: e.name, taskId: e.taskId },
    name: e.name,
    created: e.created,
  }));
  process.stdout.write(JSON.stringify(items) + "\n");
}

async function handleNoOp(_input: Record<string, unknown>): Promise<void> {
  process.stdout.write(JSON.stringify({}) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verb = process.argv[2];
  if (!verb) {
    process.stderr.write("failing-teardown-driver: verb argument required\n");
    process.exit(1);
  }

  let input: Record<string, unknown>;
  try {
    const raw = await readStdin();
    input = (typeof raw === "object" && raw !== null && !Array.isArray(raw))
      ? (raw as Record<string, unknown>)
      : {};
  } catch (err) {
    process.stderr.write(`failing-teardown-driver: stdin read error: ${String(err)}\n`);
    process.exit(1);
  }

  try {
    switch (verb) {
      case "provision":   await handleProvision(input); break;
      case "healthcheck": await handleHealthcheck(input); break;
      case "teardown":    await handleTeardown(input); break;
      case "list":        await handleList(input); break;
      case "deploy":
      case "run":
      case "collect":
        await handleNoOp(input);
        break;
      default:
        process.stderr.write(`failing-teardown-driver: unknown verb: ${verb}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`failing-teardown-driver ${verb} error: ${String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`failing-teardown-driver fatal: ${String(err)}\n`);
  process.exit(1);
});
