/**
 * Environment profile parser for meta/environments.yaml.
 *
 * Parses and validates profile definitions per spec-environment §1.
 * Each profile carries: driver, config, ttl, quota.max_instances, credentials (reference name only).
 *
 * D3: profiles are file-intent; re-read from disk. Not stored as derived state.
 * D6: no third-party YAML library. Uses the existing minimal YAML parser from task-frontmatter.ts.
 * I2: validation errors → { ok: false, reason } — never swallowed.
 * I4: TypeScript strict; no 'any' without reason comment.
 */

import { parseYamlFrontmatter } from "./task-frontmatter.js";

/**
 * A parsed and validated environment profile.
 * credentials carries only the reference name, never a secret value (spec §4).
 */
export interface EnvProfile {
  /** Profile name (the key in environments.yaml) */
  name: string;
  /** Driver: built-in name ("process" | "docker") or path to executable */
  driver: string;
  /** Driver-specific configuration block (opaque for this layer) */
  config?: Record<string, unknown>;
  /** TTL in milliseconds (normalized from "8h", "30m", "90s", or plain numbers) */
  ttlMs: number;
  /** Concurrent instance limit (optional, per-profile quota) */
  quota?: { max_instances: number };
  /** Credentials reference name only (never the secret value) — spec §4 */
  credentials?: string;
}

/** Validation result for a single profile entry */
export type ProfileValidation =
  | { ok: true; profile: EnvProfile }
  | { ok: false; name: string; reason: string };

/**
 * Parse a TTL string/number into milliseconds.
 * Supports: "8h" → 28800000, "30m" → 1800000, "90s" → 90000, "24h" → 86400000.
 * Also accepts bare numbers (treated as ms for testability — decided in planning notes).
 *
 * Returns null if the format is unrecognised.
 */
export function parseTtl(raw: unknown): number | null {
  if (typeof raw === "number") {
    // Bare number interpreted as milliseconds (useful for tests with small values)
    if (!Number.isFinite(raw) || raw < 0) return null;
    return raw;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Match <digits><unit> where unit ∈ {h, m, s}
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(h|m|s)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value < 0) return null;
  switch (unit) {
    case "h": return value * 3600 * 1000;
    case "m": return value * 60 * 1000;
    case "s": return value * 1000;
    default: return null;
  }
}

/**
 * Validate a single raw profile entry from parsed YAML.
 *
 * @param name    - Profile key in environments.yaml
 * @param raw     - Parsed YAML value for this profile key (unknown shape)
 * @returns       ProfileValidation
 */
export function validateProfile(name: string, raw: unknown): ProfileValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, name, reason: `profile "${name}": must be an object` };
  }
  // Use a typed record for field access; cast is safe because we just checked typeof === "object"
  const obj = raw as Record<string, unknown>; // the shape is unknown, type-narrowing applied per field below

  // driver is required
  if (typeof obj["driver"] !== "string" || !obj["driver"].trim()) {
    return {
      ok: false,
      name,
      reason: `profile "${name}": driver missing or not a string`,
    };
  }
  const driver = obj["driver"].trim();

  // ttl is required and must be parseable
  if (obj["ttl"] === undefined || obj["ttl"] === null) {
    return {
      ok: false,
      name,
      reason: `profile "${name}": ttl missing`,
    };
  }
  const ttlMs = parseTtl(obj["ttl"]);
  if (ttlMs === null) {
    return {
      ok: false,
      name,
      reason: `profile "${name}": ttl format invalid — expected <number>(h|m|s) or bare millisecond number, got "${String(obj["ttl"])}"`,
    };
  }

  // config is optional (may be absent for driver-defined defaults); must be an object if present
  let config: Record<string, unknown> | undefined;
  if (obj["config"] !== undefined && obj["config"] !== null) {
    if (typeof obj["config"] !== "object" || Array.isArray(obj["config"])) {
      return {
        ok: false,
        name,
        reason: `profile "${name}": config must be an object`,
      };
    }
    config = obj["config"] as Record<string, unknown>;
  }

  // quota is optional; if present must have max_instances as a positive integer.
  // The minimal YAML parser (D6: no third-party lib) returns all scalars as strings,
  // so we accept numeric strings and coerce them (e.g. "2" → 2).
  // Non-numeric strings (e.g. "two") must be rejected.
  let quota: { max_instances: number } | undefined;
  if (obj["quota"] !== undefined && obj["quota"] !== null) {
    if (typeof obj["quota"] !== "object" || Array.isArray(obj["quota"])) {
      return {
        ok: false,
        name,
        reason: `profile "${name}": quota must be an object`,
      };
    }
    const quotaObj = obj["quota"] as Record<string, unknown>;
    const maxInstRaw = quotaObj["max_instances"];
    // Coerce numeric string to number (the minimal YAML parser returns scalars as strings)
    const maxInst =
      typeof maxInstRaw === "number"
        ? maxInstRaw
        : typeof maxInstRaw === "string" && /^\d+$/.test(maxInstRaw.trim())
        ? parseInt(maxInstRaw.trim(), 10)
        : NaN;
    if (!Number.isInteger(maxInst) || maxInst < 1) {
      return {
        ok: false,
        name,
        reason: `profile "${name}": quota.max_instances must be a positive integer, got "${String(maxInstRaw)}"`,
      };
    }
    quota = { max_instances: maxInst };
  }

  // credentials: reference name only (string), optional
  let credentials: string | undefined;
  if (obj["credentials"] !== undefined && obj["credentials"] !== null) {
    if (typeof obj["credentials"] !== "string") {
      return {
        ok: false,
        name,
        reason: `profile "${name}": credentials must be a string reference name`,
      };
    }
    credentials = obj["credentials"];
  }

  const profile: EnvProfile = {
    name,
    driver,
    ttlMs,
    ...(config !== undefined ? { config } : {}),
    ...(quota !== undefined ? { quota } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
  };
  return { ok: true, profile };
}

/**
 * Result of parsing the entire environments.yaml file.
 */
export interface ParseEnvProfilesResult {
  /** Successfully validated profiles (in YAML key order) */
  valid: EnvProfile[];
  /** Per-profile failures for invalid entries */
  failures: Array<{ name: string; reason: string }>;
}

/**
 * Parse and validate a meta/environments.yaml file content string.
 *
 * The YAML format is (per spec §1):
 * ```yaml
 * profiles:
 *   dev:
 *     driver: process
 *     config: { cmd: "npm run dev", port: 5173 }
 *     ttl: 8h
 *   ...
 * ```
 *
 * D6: uses the existing parseYamlFrontmatter from task-frontmatter.ts (no new YAML dep).
 * I2: parse errors → returned in failures (never thrown/swallowed).
 *
 * Note: parseYamlFrontmatter was designed for task frontmatter (shallow objects),
 * but its block-mapping support handles the nested `profiles:` structure.
 * Inline scalars inside config blocks (e.g. config: { cmd: ..., port: 5173 }) may
 * be preserved as string values. The config block is treated as opaque (spec §2:
 * "daemonは中身を解釈しない").
 *
 * @param content   Full text of meta/environments.yaml
 */
export function parseEnvProfiles(content: string): ParseEnvProfilesResult {
  // The file is not frontmatter (no --- delimiters); parse the entire content directly.
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlFrontmatter(content);
  } catch (err) {
    // Top-level parse error — no valid profiles
    return {
      valid: [],
      failures: [{ name: "<root>", reason: `YAML parse error: ${String(err)}` }],
    };
  }

  // Extract the top-level "profiles" key
  const profilesRaw = parsed["profiles"];
  if (profilesRaw === undefined || profilesRaw === null) {
    // No profiles key — treat as empty
    return { valid: [], failures: [] };
  }
  if (typeof profilesRaw !== "object" || Array.isArray(profilesRaw)) {
    return {
      valid: [],
      failures: [{ name: "<profiles>", reason: "profiles must be a mapping (object)" }],
    };
  }

  const profilesMap = profilesRaw as Record<string, unknown>;
  const valid: EnvProfile[] = [];
  const failures: Array<{ name: string; reason: string }> = [];

  for (const [name, rawValue] of Object.entries(profilesMap)) {
    const result = validateProfile(name, rawValue);
    if (result.ok) {
      valid.push(result.profile);
    } else {
      failures.push({ name, reason: result.reason });
    }
  }

  return { valid, failures };
}
