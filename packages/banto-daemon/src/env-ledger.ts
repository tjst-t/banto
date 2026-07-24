/**
 * EnvLedger — persistent registry of provisioned environments (spec-environment §5).
 *
 * Records each provisioned environment with its handle, profile, taskId, etc.
 * Written atomically to <dataDir>/env-ledger.json (same pattern as spawn-ledger.ts).
 *
 * Invariants (mirror spawn-ledger.ts conventions):
 *   D3: the ledger is the single truth for what environments are live.
 *       TTL/quota enforcement is a daemon responsibility (Stories 4/5 — not this story).
 *   I2: ledger corruption → error description returned + empty ledger (never crash).
 *   I3: only environments provisioned via this daemon are in the ledger.
 *   D6: node:fs + node:path only (stdlib).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EnvHandle } from "@banto/core";

// ── Ledger entry ──────────────────────────────────────────────────────────────

export interface EnvLedgerEntry {
  /** Unique environment ID (generated at provision time) */
  envId: string;
  /** Project tag (namespace) */
  projectTag: string;
  /** Banto task ID */
  taskId: string;
  /** Profile name used for provisioning */
  profileName: string;
  /** Driver name or path used to provision ("process", "docker", or absolute path) */
  driver: string;
  /** Opaque handle returned by the driver (D3: daemon does not interpret fields) */
  handle: EnvHandle;
  /** ISO-8601 timestamp of provision (renamed from provisionedAt for Story-4 schema alignment) */
  createdAt: string;
  /** ISO-8601 timestamp when environment was torn down (undefined = still live) */
  tornDownAt?: string;
}

// ── Ledger file format ─────────────────────────────────────────────────────────

interface EnvLedgerFile {
  version: 1;
  entries: EnvLedgerEntry[];
}

// ── EnvLedger ─────────────────────────────────────────────────────────────────

export class EnvLedger {
  private readonly ledgerPath: string;
  private entries: Map<string, EnvLedgerEntry>; // key: envId

  private constructor(dataDir: string, entries: Map<string, EnvLedgerEntry>) {
    this.ledgerPath = path.join(dataDir, "env-ledger.json");
    this.entries = entries;
  }

  /**
   * Open (or create) the ledger at <dataDir>/env-ledger.json.
   *
   * I2: If the file exists but is corrupt, returns an empty ledger and
   * provides an error description for the caller to emit as an error event.
   */
  static open(dataDir: string): { ledger: EnvLedger; corruptionError: string | null } {
    const ledgerPath = path.join(dataDir, "env-ledger.json");
    let corruptionError: string | null = null;

    if (!fs.existsSync(ledgerPath)) {
      return { ledger: new EnvLedger(dataDir, new Map()), corruptionError: null };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(ledgerPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      corruptionError = `env-ledger.json read error: ${msg}`;
      return { ledger: new EnvLedger(dataDir, new Map()), corruptionError };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      corruptionError = `env-ledger.json parse error: ${msg}`;
      return { ledger: new EnvLedger(dataDir, new Map()), corruptionError };
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>)["version"] !== 1 ||
      !Array.isArray((parsed as Record<string, unknown>)["entries"])
    ) {
      corruptionError = "env-ledger.json has unexpected format (version != 1 or entries not array)";
      return { ledger: new EnvLedger(dataDir, new Map()), corruptionError };
    }

    const file = parsed as EnvLedgerFile;
    const entries = new Map<string, EnvLedgerEntry>();
    for (const e of file.entries) {
      if (
        typeof e.envId === "string" &&
        typeof e.projectTag === "string" &&
        typeof e.taskId === "string" &&
        typeof e.profileName === "string" &&
        typeof e.driver === "string" &&
        typeof e.handle === "object" && e.handle !== null &&
        typeof e.createdAt === "string"
      ) {
        entries.set(e.envId, e);
      } else {
        corruptionError =
          corruptionError ??
          `env-ledger.json contains malformed entry (skipped): ${JSON.stringify(e)}`;
      }
    }

    return { ledger: new EnvLedger(dataDir, entries), corruptionError };
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /** Add a newly-provisioned environment. Atomically flushes to disk. */
  add(entry: EnvLedgerEntry): void {
    this.entries.set(entry.envId, entry);
    this.flush();
  }

  /**
   * Mark an environment as torn down (record tornDownAt timestamp).
   * The entry is kept in the ledger for audit trail (D3).
   */
  markTornDown(envId: string): void {
    const entry = this.entries.get(envId);
    if (!entry) return; // already removed or never existed — idempotent
    this.entries.set(envId, { ...entry, tornDownAt: new Date().toISOString() });
    this.flush();
  }

  /** Remove an entry from the ledger (hard delete). */
  remove(envId: string): void {
    if (!this.entries.has(envId)) return;
    this.entries.delete(envId);
    this.flush();
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** All entries (including torn-down ones). */
  list(): EnvLedgerEntry[] {
    return [...this.entries.values()];
  }

  /** Only live (not torn down) entries. */
  listLive(): EnvLedgerEntry[] {
    return [...this.entries.values()].filter((e) => !e.tornDownAt);
  }

  /** Live entries for a specific task. */
  listByTask(projectTag: string, taskId: string): EnvLedgerEntry[] {
    return this.listLive().filter(
      (e) => e.projectTag === projectTag && e.taskId === taskId
    );
  }

  /** Get a single entry by envId. */
  get(envId: string): EnvLedgerEntry | undefined {
    return this.entries.get(envId);
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private flush(): void {
    const file: EnvLedgerFile = {
      version: 1,
      entries: [...this.entries.values()],
    };
    const json = JSON.stringify(file, null, 2);

    const dir = path.dirname(this.ledgerPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = path.join(dir, `.env-ledger.tmp.${process.pid}.${Date.now()}`);
    try {
      fs.writeFileSync(tmpPath, json, { encoding: "utf8", flag: "w" });
      fs.renameSync(tmpPath, this.ledgerPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err; // I2: propagate
    }
  }
}
