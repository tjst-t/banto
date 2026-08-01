/**
 * EnvLedger — persistent registry of provisioned environments (spec-environment §5).
 *
 * Records each provisioned environment with its handle, profile, taskId, etc.
 * Written atomically to <dataDir>/env-ledger.json (same pattern as spawn-ledger.ts).
 *
 * Invariants (mirror spawn-ledger.ts conventions):
 *   D3: the ledger is the single truth for what environments are live.
 *       Quota counts are DERIVED from ledger (countLiveByProfile) — no separate counter.
 *       TTL enforcement tick is Story-5's job; we only persist ttlDeadline here.
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
  /** ISO-8601 timestamp of provision */
  createdAt: string;
  /**
   * どこで動かしたか（ADR-0010 決定34d・task-0034）。
   *
   * D3 の例外ではない——これは**導出できない入力**。プロセスが落ちて起き直しても、
   * 後続の `run` に provision と同じ場所を渡せるように残す。
   */
  workdir?: string;
  /** 外から見られるURL（決定39）。導出できない事実なので持つ。 */
  url?: string;
  /** 公開しているポート。 */
  exposedPort?: number;
  /**
   * ISO-8601 deadline for TTL enforcement (computed from profile.ttlMs at provision time).
   * Story-5 reads this to force-teardown expired environments.
   * D3: stored in the ledger (single truth for live resources) — no re-read of profile needed.
   * Note: Story-4 persists this field; Story-5 implements the TTL enforcement tick.
   */
  ttlDeadline: string;
  /** ISO-8601 timestamp when environment was torn down (undefined = still live) */
  tornDownAt?: string;
  /**
   * Set to true when the TTL teardown tick gave up after retry exhaustion (Story-5).
   * The entry is kept in the ledger (not removed) so the PO can see it via GET /environments
   * and a cadence card is filed. I2: never silently dropped.
   */
  teardownFailed?: boolean;
}

// ── Quota helpers ─────────────────────────────────────────────────────────────

/**
 * Count live (not torn-down) ledger entries for a given profile name.
 * D3: quota count is DERIVED from ledger — no separate counter persisted.
 * Used by daemon.provisionEnv() to enforce quota.max_instances (spec-environment §5).
 */
export function countLiveByProfile(entries: EnvLedgerEntry[], profileName: string): number {
  return entries.filter((e) => !e.tornDownAt && e.profileName === profileName).length;
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
        // Backward-compat: if ttlDeadline is missing (pre-S9d7fdb-4 entries),
        // assign a sentinel far-future value so Story-5 TTL tick ignores them.
        // This avoids a schema migration and keeps open() non-destructive (I2).
        const entry: EnvLedgerEntry = {
          ...e,
          ttlDeadline: typeof e.ttlDeadline === "string" ? e.ttlDeadline : "9999-12-31T23:59:59.999Z",
        };
        entries.set(entry.envId, entry);
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
  /** 公開先を記録する。プロセスが起き直しても、どのURLを取り下げるか分かる。 */
  setExposure(envId: string, url: string, port: number): void {
    const entry = this.entries.get(envId);
    if (!entry) return;
    entry.url = url;
    entry.exposedPort = port;
    this.flush();
  }

  markTornDown(envId: string): void {
    const entry = this.entries.get(envId);
    if (!entry) return; // already removed or never existed — idempotent
    this.entries.set(envId, { ...entry, tornDownAt: new Date().toISOString() });
    this.flush();
  }

  /**
   * Mark an entry as teardown_failed (retry exhausted, escalation filed).
   * The entry is NOT removed — it stays for audit and cadence escalation (I2, AC-S9d7fdb-5-2).
   */
  markTeardownFailed(envId: string): void {
    const entry = this.entries.get(envId);
    if (!entry) return; // already removed or never existed — idempotent
    this.entries.set(envId, { ...entry, teardownFailed: true });
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
