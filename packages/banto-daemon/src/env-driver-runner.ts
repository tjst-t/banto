/**
 * Environment driver runner — daemon-side subprocess invocation.
 *
 * Spawns a driver executable as a subprocess, passing the verb's input JSON
 * on stdin and reading the JSON output from stdout.
 *
 * Contract (spec-environment §2):
 *   - argv[0] = driver path, argv[1] = verb
 *   - stdin = input JSON (verb-specific per spec §2 table)
 *   - stdout = output JSON (verb-specific per spec §2 table)
 *   - exit 0 = success; any other exit code = failure (I2: not swallowed)
 *
 * D6: node:child_process only (no npm deps).
 * I2: non-zero exit is an Error; never returned as a successful response.
 * I4: TypeScript strict; no 'any' without reason comment.
 */

import * as childProcess from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Default driver timeout ────────────────────────────────────────────────────
//
// Spec §8 open item: "run のタイムアウト規約（daemon側で一律か、プロファイルごとか）"
// Decision for Story 2 (planning note, binding): daemon-side uniform configurable default.
// Default = 30 seconds. Callers (daemon) may pass a custom value.

export const DEFAULT_DRIVER_TIMEOUT_MS = 30_000;

// ── Driver runner result ───────────────────────────────────────────────────────

export type DriverRunResult<T> =
  | { ok: true; output: T }
  | { ok: false; error: string; exitCode: number };

// ── Resolve builtin driver path ───────────────────────────────────────────────
//
// The builtin `process` driver lives at
//   packages/banto-daemon/src/process-driver.ts
// relative to this file (env-driver-runner.ts is in the same directory).
// We invoke it via `node --import tsx <path>`.

const _thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute path to a driver executable.
 *
 * For builtin names ("process", "docker"), returns the path to the bundled
 * driver script in this package's src/ directory.
 * For any other value, treats it as an absolute or project-relative path.
 *
 * D1: builtins defined so far: "process" (Story 2), "docker" (Story 3).
 */
export function resolveDriverPath(driver: string): string {
  if (driver === "process") {
    return path.join(_thisDir, "process-driver.ts");
  }
  if (driver === "docker") {
    // S9d7fdb-3: builtin docker compose driver (compose CLI shell-out, D6: no SDK dep).
    return path.join(_thisDir, "docker-driver.ts");
  }
  // External or project-local driver — path as-is
  return driver;
}

// ── Main runner function ───────────────────────────────────────────────────────

/**
 * Invoke a driver executable for a given verb.
 *
 * @param driverPath   Absolute path to the driver executable.
 * @param verb         One of the 7 spec §2 verbs.
 * @param input        Input object for this verb (field names per spec §2 — D1).
 * @param timeoutMs    Maximum milliseconds to wait for the driver (default 30s).
 * @param extraEnv     Additional environment variables injected into the driver's
 *                     spawn env (ONLY — never stdin/argv/logs). Used for credentials
 *                     (spec-environment §4, S9d7fdb-6). Caller must never log these.
 *
 * @returns DriverRunResult<unknown> — callers narrow the output type.
 *
 * D6: uses node:child_process.spawn only.
 * I2: non-zero exit → ok: false (never swallowed).
 */
export async function runDriverVerb(
  driverPath: string,
  verb: string,
  input: Record<string, unknown>,
  timeoutMs: number = DEFAULT_DRIVER_TIMEOUT_MS,
  extraEnv?: Record<string, string>
): Promise<DriverRunResult<unknown>> {
  // Determine if we're running a .ts file (builtin) or a compiled JS / executable
  const isTsFile = driverPath.endsWith(".ts");

  // argv / command construction
  // D6: use tsx for TypeScript driver files (tsx is a dev-dependency already in
  // the monorepo — see package.json devDependencies). For non-ts drivers, run directly.
  let spawnCmd: string;
  let spawnArgs: string[];

  if (isTsFile) {
    // Run TypeScript driver via `node --import tsx <path>`
    // tsx is already in devDependencies (D6: no new dep added for this).
    spawnCmd = process.execPath; // same node binary
    spawnArgs = ["--import", "tsx", driverPath, verb];
  } else {
    spawnCmd = driverPath;
    spawnArgs = [verb];
  }

  const inputJson = JSON.stringify(input);

  return new Promise<DriverRunResult<unknown>>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    // Build spawn env: inherit process.env, then overlay extraEnv (credentials).
    // SECURITY (S9d7fdb-6 / spec-environment §4): extraEnv values are ONLY injected here
    // into the driver subprocess env. They are never written to logs, stdout, stdin, or argv.
    let spawnEnv: Record<string, string> | undefined;
    if (extraEnv && Object.keys(extraEnv).length > 0) {
      spawnEnv = { ...process.env as Record<string, string | undefined> } as Record<string, string>;
      for (const [k, v] of Object.entries(extraEnv)) {
        spawnEnv[k] = v;
      }
    }

    const child = childProcess.spawn(spawnCmd, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });

    child.stdout.on("data", (chunk: Buffer) => { stdoutBuf += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString("utf8"); });

    // Write input JSON to stdin then close it
    child.stdin.write(inputJson, "utf8", (writeErr) => {
      if (writeErr) {
        // Best-effort: stdin write failed (process may have died already)
        process.stderr.write(`[env-driver-runner] stdin write error: ${String(writeErr)}\n`);
      }
      child.stdin.end();
    });

    // Timeout guard
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        error: `driver timeout after ${timeoutMs}ms (verb=${verb})`,
        exitCode: -1,
      });
    }, timeoutMs);

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        // I2: non-zero exit is always a failure — never swallowed
        const detail = stderrBuf.trim() || `signal=${signal ?? "none"}`;
        resolve({
          ok: false,
          error: `driver exited with code ${exitCode}: ${detail}`,
          exitCode,
        });
        return;
      }

      // Parse stdout as JSON
      const raw = stdoutBuf.trim();
      if (!raw) {
        // Verbs with no output (deploy, collect, teardown) may emit empty stdout
        resolve({ ok: true, output: {} });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        resolve({
          ok: false,
          error: `driver stdout is not valid JSON: ${String(err)} (raw: ${raw.slice(0, 200)})`,
          exitCode: 0,
        });
        return;
      }

      resolve({ ok: true, output: parsed });
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        error: `driver spawn error: ${err.message}`,
        exitCode: -1,
      });
    });
  });
}
