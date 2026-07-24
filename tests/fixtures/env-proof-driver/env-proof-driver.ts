#!/usr/bin/env node
/**
 * env-proof-driver — test fixture driver for S9d7fdb-6 credentials injection test.
 *
 * This driver verifies that the daemon injects credentials via spawn env (NOT stdin/argv/logs).
 *
 * Security proof mechanism:
 *   - The daemon injects TEST_SECRET into this driver's environment.
 *   - The driver computes sha256(TEST_SECRET) and returns it in healthcheck.detail.
 *   - The test asserts that healthcheck.detail === sha256(knownSecret), proving injection.
 *   - The plaintext TEST_SECRET never appears in the driver's stdout (only its hash does).
 *
 * Driver contract (spec-environment §2):
 *   - argv[1] = verb (provision | healthcheck | run | collect | teardown | list)
 *   - stdin = JSON input
 *   - stdout = JSON output
 *   - exit 0 = success
 *
 * D6: node:crypto only (stdlib). No npm deps.
 * I4: TypeScript strict.
 */

import * as crypto from "node:crypto";
import * as readline from "node:readline";

const verb = process.argv[2];
if (!verb) {
  process.stderr.write("env-proof-driver: missing verb argument\n");
  process.exit(1);
}

async function readStdin(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin });
    let buf = "";
    rl.on("line", (line) => { buf += line; });
    rl.on("close", () => {
      if (!buf.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buf) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`env-proof-driver: invalid stdin JSON: ${String(err)}`));
      }
    });
    rl.on("error", reject);
  });
}

/**
 * Compute sha256 of the given string and return it as a lowercase hex string.
 * Used to prove the secret reached the driver WITHOUT logging the plaintext.
 */
function sha256(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const input = await readStdin();

  if (verb === "provision") {
    // Return a handle that records what env var was present (via sha256).
    // The handle is opaque to the daemon and stored in the ledger.
    // IMPORTANT: the handle must NOT contain the plaintext secret — only a sha256 proof.
    const secretValue = process.env["TEST_SECRET"] ?? "";
    const secretHash = sha256(secretValue);
    const handle = {
      type: "env-proof",
      secretPresent: secretValue.length > 0,
      secretHash,
      taskId: typeof input["taskId"] === "string" ? input["taskId"] : "unknown",
    };
    process.stdout.write(JSON.stringify({ handle }) + "\n");
    return;
  }

  if (verb === "healthcheck") {
    // Healthcheck: re-read the env var and return sha256 in detail.
    // This is the primary proof surface: the test checks that detail === sha256(knownSecret).
    // CRITICAL: detail contains only the HASH, never the plaintext.
    const secretValue = process.env["TEST_SECRET"] ?? "";
    const secretHash = sha256(secretValue);
    const detail = `sha256:${secretHash}`;
    process.stdout.write(JSON.stringify({ ok: true, detail }) + "\n");
    return;
  }

  if (verb === "run") {
    // Simulate running a command. Return exit 0 and a log_path.
    // The run output must NOT contain the secret value.
    // We write a minimal log file to confirm the run happened.
    const cmd = typeof input["cmd"] === "string" ? input["cmd"] : "(none)";
    process.stdout.write(JSON.stringify({
      exit: 0,
      log_path: `/tmp/env-proof-run-${Date.now()}.log`,
    }) + "\n");
    // Log to a temp file (not stdout): only cmd echo, never the secret.
    process.stderr.write(`[env-proof-driver] run: cmd=${cmd}\n`);
    return;
  }

  if (verb === "collect") {
    // No-op collect — dest is passed in input.
    // Do not write secrets to the dest directory.
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  if (verb === "teardown") {
    // Idempotent teardown — always succeeds.
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }

  if (verb === "list") {
    // No managed resources (test fixture, stateless).
    process.stdout.write(JSON.stringify([]) + "\n");
    return;
  }

  process.stderr.write(`env-proof-driver: unknown verb "${verb}"\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`env-proof-driver: fatal error: ${String(err)}\n`);
  process.exit(1);
});
