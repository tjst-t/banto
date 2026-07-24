/**
 * Environment driver contract — spec-environment §2.
 *
 * A driver is a subprocess-based executable invoked as:
 *   <driver-path> <verb>
 * with the verb's input JSON on stdin and its output JSON on stdout.
 * exit 0 = success; any other exit code = failure.
 *
 * This file defines ONLY types and the verb constant set.
 * The actual runner (subprocess spawn + timeout) lives in banto-daemon.
 *
 * D1: field names in input/output shapes are FIXED to spec §2 table exactly.
 *     Do NOT rename them without an ADR.
 * D3: handle is opaque JSON — daemon never interprets fields inside a handle.
 * D6: stdlib-only (no imports beyond TypeScript type machinery).
 * I4: TypeScript strict; no 'any' without reason comment.
 */

// ── Verb set ─────────────────────────────────────────────────────────────────

/** All 7 verbs defined in spec-environment §2. */
export type EnvDriverVerb =
  | "provision"
  | "deploy"
  | "healthcheck"
  | "run"
  | "collect"
  | "teardown"
  | "list";

export const ENV_DRIVER_VERBS: readonly EnvDriverVerb[] = [
  "provision",
  "deploy",
  "healthcheck",
  "run",
  "collect",
  "teardown",
  "list",
] as const;

// ── Handle ────────────────────────────────────────────────────────────────────

/**
 * Opaque handle returned by `provision` and round-tripped to all subsequent verbs.
 * daemon never interprets the fields inside a handle (D1, D3).
 * Typed as Record<string, unknown> so TypeScript can serialize/deserialize it as JSON.
 */
export type EnvHandle = Record<string, unknown>;

// ── Stdin input shapes (spec §2 table, column "入力") ─────────────────────────
// Field names are FIXED to spec §2. Do NOT rename (D1).

/** stdin for `provision`: driver-specific configuration block */
export interface ProvisionInput {
  /** Driver-specific configuration (from the profile's `config` block). */
  config: Record<string, unknown>;
  /**
   * taskID used for prefixed resource naming (I3: all managed resources carry
   * the taskID prefix so they can be identified and cleaned up later).
   */
  taskId: string;
}

/** stdin for `deploy`: handle + artifact path */
export interface DeployInput {
  handle: EnvHandle;
  /** Absolute path to the artifact to deploy. */
  artifact_path: string;
}

/** stdin for `healthcheck`: handle only */
export interface HealthcheckInput {
  handle: EnvHandle;
}

/** stdin for `run`: handle + command to execute */
export interface RunInput {
  handle: EnvHandle;
  /** The command to run inside the environment (shell string). */
  cmd: string;
}

/** stdin for `collect`: handle + destination directory */
export interface CollectInput {
  handle: EnvHandle;
  /** Absolute path to the destination directory where artifacts are collected. */
  dest: string;
}

/** stdin for `teardown`: handle */
export interface TeardownInput {
  handle: EnvHandle;
}

/** stdin for `list`: (empty — no required fields) */
export type ListInput = Record<string, never>;

// ── Stdout output shapes (spec §2 table, column "出力") ──────────────────────
// Field names are FIXED to spec §2. Do NOT rename (D1).

/** stdout for `provision` */
export interface ProvisionOutput {
  handle: EnvHandle;
}

/**
 * stdout for `deploy`: no required output fields.
 * Driver may emit any fields; daemon ignores them (D3: handle is the single truth).
 */
export type DeployOutput = Record<string, unknown>;

/** stdout for `healthcheck` */
export interface HealthcheckOutput {
  /** true if the environment is reachable and ready; false otherwise. */
  ok: boolean;
  /** Optional human-readable detail (spec §2 "detail?" column). */
  detail?: string;
}

/** stdout for `run` */
export interface RunOutput {
  /** Exit code of the command that was run inside the environment. */
  exit: number;
  /** Absolute path to the log file containing command output. */
  log_path: string;
}

/**
 * stdout for `collect`: no required output fields.
 * Files are written to the `dest` directory, not to stdout.
 */
export type CollectOutput = Record<string, unknown>;

/**
 * stdout for `teardown`: no required output fields.
 * exit 0 = success (idempotent — already-gone is success per spec §2).
 */
export type TeardownOutput = Record<string, unknown>;

/** One item in the `list` output array. */
export interface ListItem {
  handle: EnvHandle;
  /** Human-readable resource name, prefixed with the taskID (I3). */
  name: string;
  /** ISO-8601 timestamp when the resource was created. */
  created: string;
}

/** stdout for `list` */
export type ListOutput = ListItem[];

// ── Discriminated union of all verb inputs (for the runner) ──────────────────

export type EnvDriverInput =
  | ({ verb: "provision" } & ProvisionInput)
  | ({ verb: "deploy" } & DeployInput)
  | ({ verb: "healthcheck" } & HealthcheckInput)
  | ({ verb: "run" } & RunInput)
  | ({ verb: "collect" } & CollectInput)
  | ({ verb: "teardown" } & TeardownInput)
  | { verb: "list" };
