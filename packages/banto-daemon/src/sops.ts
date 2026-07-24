/**
 * sops decryption wrapper — S9d7fdb-6.
 *
 * Shells out to the `sops` binary (D6: shell-out, no npm crypto/sops dep).
 * Decrypts a sops-encrypted YAML or JSON file and returns the key-value pairs
 * as a flat string record suitable for injection into a subprocess environment.
 *
 * Security contract (spec-environment §4):
 *   - Decrypted values are returned only as a plain record.
 *   - The caller is responsible for passing them ONLY to spawn() env options.
 *   - The caller MUST NOT log, persist, or echo decrypted values.
 *   - This module never logs or writes decrypted values itself.
 *
 * D6: sops + age are pre-installed infrastructure tools (not npm deps).
 * I2: sops failure → returned as { ok: false, error } (never swallowed).
 * I4: TypeScript strict; no 'any' without reason comment.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SopsDecryptResult =
  | { ok: true; secrets: Record<string, string> }
  | { ok: false; error: string };

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Decrypt a sops-encrypted file and return key→value pairs.
 *
 * The file must be sops-encrypted YAML or JSON (sops supports both).
 * The output format from `sops -d --output-type json` is a flat or nested JSON;
 * we flatten one level: top-level string-valued keys become env vars.
 * Nested objects are skipped (not a valid env var shape).
 *
 * @param filePath       Absolute path to the sops-encrypted credentials file.
 * @param sopsAgeKeyFile Path to the age private key file (SOPS_AGE_KEY_FILE).
 *                       If undefined, the current process's SOPS_AGE_KEY_FILE env is used.
 * @param timeoutMs      Max time to wait for `sops -d` (default 10s).
 */
export function decryptSops(
  filePath: string,
  sopsAgeKeyFile?: string,
  timeoutMs = 10_000
): Promise<SopsDecryptResult> {
  return new Promise<SopsDecryptResult>((resolve) => {
    // Validate that the path is absolute (I2: fail fast if caller passes a bad path).
    if (!path.isAbsolute(filePath)) {
      resolve({
        ok: false,
        error: `sops_decrypt_failed: file path must be absolute, got "${filePath}"`,
      });
      return;
    }

    // Build the child env: inherit current process env, overlay SOPS_AGE_KEY_FILE.
    // SECURITY: we do NOT log this env block; it contains the key file path, not the key itself.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") childEnv[k] = v;
    }
    if (sopsAgeKeyFile) {
      childEnv["SOPS_AGE_KEY_FILE"] = sopsAgeKeyFile;
    }

    // Shell out: `sops -d --output-type json <filePath>`
    // D6: sops binary is assumed to be in PATH (pre-installed infrastructure tool).
    const child = childProcess.spawn(
      "sops",
      ["-d", "--output-type", "json", filePath],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      }
    );

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        error: `sops_decrypt_failed: sops timed out after ${timeoutMs}ms for "${filePath}"`,
      });
    }, timeoutMs);

    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        // I2: sops non-zero exit is always a failure.
        // SECURITY: stderrBuf may contain key-related diagnostics but NOT the secret values.
        const detail = stderrBuf.trim().slice(0, 500) || `exit code ${code}`;
        resolve({
          ok: false,
          error: `sops_decrypt_failed: sops exited with code ${code}: ${detail}`,
        });
        return;
      }

      // Parse the decrypted JSON output.
      const raw = stdoutBuf.trim();
      if (!raw) {
        resolve({
          ok: false,
          error: `sops_decrypt_failed: sops produced empty output for "${filePath}"`,
        });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        resolve({
          ok: false,
          error: `sops_decrypt_failed: sops output is not valid JSON: ${String(err)}`,
        });
        return;
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        resolve({
          ok: false,
          error: `sops_decrypt_failed: sops output must be a JSON object, got ${typeof parsed}`,
        });
        return;
      }

      // Flatten to string record: only top-level string/number/boolean values become env vars.
      // We MUST NOT log the resulting values (security contract above).
      const secrets: Record<string, string> = {};
      const obj = parsed as Record<string, unknown>; // safe: checked typeof === "object"
      for (const [key, value] of Object.entries(obj)) {
        // Skip the sops metadata key that sops injects into the output
        if (key === "sops") continue;
        if (typeof value === "string") {
          secrets[key] = value;
        } else if (typeof value === "number" || typeof value === "boolean") {
          secrets[key] = String(value);
        }
        // Skip nested objects / arrays — they are not env-var-compatible without further processing.
      }

      resolve({ ok: true, secrets });
    });

    child.once("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        error: `sops_decrypt_failed: failed to spawn sops: ${err.message}`,
      });
    });
  });
}

/**
 * Resolve the absolute path to a credentials file for a given reference name.
 *
 * Convention (spec-environment §4): credentials files live under
 *   <projectRoot>/meta/credentials/<refName>.yaml
 * or
 *   <projectRoot>/meta/credentials/<refName>.yml
 * or
 *   <projectRoot>/meta/credentials/<refName>.json
 *
 * Returns the first existing path, or an error if none exists.
 *
 * @param projectRoot   Absolute path to the project root.
 * @param refName       The credentials reference name from environments.yaml.
 */
export function resolveCredentialsPath(
  projectRoot: string,
  refName: string
): { ok: true; filePath: string } | { ok: false; error: string } {
  // Reject any path traversal in the reference name (I2: early failure).
  if (refName.includes("/") || refName.includes("..") || refName.includes("\\")) {
    return {
      ok: false,
      error: `credentials_resolve_failed: invalid reference name "${refName}" (must not contain path separators)`,
    };
  }

  const credDir = path.join(projectRoot, "meta", "credentials");
  const candidates = [
    path.join(credDir, `${refName}.yaml`),
    path.join(credDir, `${refName}.yml`),
    path.join(credDir, `${refName}.json`),
  ];

  // D6: use node:fs.existsSync (stdlib, no dep).
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { ok: true, filePath: candidate };
    }
  }

  return {
    ok: false,
    error: `credentials_resolve_failed: credentials file for "${refName}" not found in "${credDir}" (tried .yaml/.yml/.json)`,
  };
}
