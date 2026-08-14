/**
 * SpawnLedger — persistent registry of active child processes (spec daemon-core §3).
 *
 * Records {pid, projectTag, taskId, sessionPath, worktree, driverId, spawnedAt}
 * to <dataDir>/spawn-ledger.json atomically (tmp + rename) so the file is never
 * partially-written. On daemon restart the ledger is read and orphans are recovered.
 *
 * Invariants:
 *   D3: the ledger is NOT the state truth for task status — events are.
 *       The ledger only tracks live OS processes so the daemon can recover them.
 *   I2: ledger corruption → error event emitted, empty ledger used (never crash on startup).
 *   I3: only processes spawned via this daemon are in the ledger.
 *   D6: uses only node:fs + node:path (stdlib).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildProcessRecord } from "./child-pids.js";

// ── Ledger entry ─────────────────────────────────────────────────────────────

export interface LedgerEntry {
  /**
   * OS pid of the child process.
   *
   * **これは node のホストの pid**（実測 190〜215MB）。実処理を抱えるのは、その下で
   * ランタイムが起こす子（Claude Agent SDK なら `claude` CLI）で、そちらは
   * `childProcesses` に載る（inc-0066）。
   */
  pid: number;
  /** Project tag (namespace) */
  projectTag: string;
  /** Banto task ID */
  taskId: string;
  /** Absolute path to the session JSONL file */
  sessionPath: string;
  /** Absolute path to the git worktree */
  worktree: string;
  /** Driver ID used to spawn (e.g. "pi-rpc", "sleep-test") */
  driverId: string;
  /** Session ID assigned by the driver */
  sessionId: string;
  /**
   * 起動元＝報告の宛先（ADR-0010 決定29）。projectTag（作業の名前空間）とは別物で、
   * Kobo は複数の projectTag を持つため宛先にならない。
   * 任意なのは、この項目より前に書かれた台帳を読めなくしないため。
   */
  origin?: string;
  /** ISO-8601 timestamp of spawn */
  spawnedAt: string;
  /**
   * tmux window address (e.g. "banto:<taskId>") if a tmux window was opened
   * for PO observation (spec-ui §1.4: POはtmuxアタッチで対話内容を目視).
   * Optional — set only when tmux session management is active.
   */
  tmux_window?: string;
  /**
   * ホストの下でランタイムが起こした**実プロセス**（inc-0066）。
   *
   * 2026-08-14 の OOM で 11GB を抱えていたのはここに載るプロセスで、当時は pid が
   * どこにも記録されておらず**犯人を同定できなかった**。ダンプの pid から職人を
   * 逆引きできるようにするために置く。
   *
   * 起動直後の走査で埋まるので、起こした瞬間は未定義。見つけられなかったときも
   * `error` 付きで載る（I2：黙って空にしない）。任意なのは、この項目より前に
   * 書かれた台帳を読めなくしないため。
   */
  childProcesses?: ChildProcessRecord;
}

// ── Ledger file format ────────────────────────────────────────────────────────

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

// ── SpawnLedger ───────────────────────────────────────────────────────────────

export class SpawnLedger {
  private readonly ledgerPath: string;
  private entries: Map<string, LedgerEntry>; // key: `${projectTag}/${taskId}`

  /**
   * @param dataDir  Root data directory (same as EventLog's dataDir).
   */
  private constructor(dataDir: string, entries: Map<string, LedgerEntry>) {
    this.ledgerPath = path.join(dataDir, "spawn-ledger.json");
    this.entries = entries;
  }

  /**
   * Open (or create) the ledger at <dataDir>/spawn-ledger.json.
   *
   * I2: If the file exists but is corrupt, returns an empty ledger and
   * provides an error description for the caller to emit as an error event.
   *
   * @returns { ledger, corruptionError } — corruptionError is non-null when
   *   the file existed but could not be parsed.
   */
  static open(dataDir: string): { ledger: SpawnLedger; corruptionError: string | null } {
    const ledgerPath = path.join(dataDir, "spawn-ledger.json");
    let corruptionError: string | null = null;

    if (!fs.existsSync(ledgerPath)) {
      return { ledger: new SpawnLedger(dataDir, new Map()), corruptionError: null };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(ledgerPath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      corruptionError = `spawn-ledger.json read error: ${msg}`;
      return { ledger: new SpawnLedger(dataDir, new Map()), corruptionError };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      corruptionError = `spawn-ledger.json parse error: ${msg}`;
      return { ledger: new SpawnLedger(dataDir, new Map()), corruptionError };
    }

    // Validate structure
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>)["version"] !== 1 ||
      !Array.isArray((parsed as Record<string, unknown>)["entries"])
    ) {
      corruptionError = "spawn-ledger.json has unexpected format (version != 1 or entries not array)";
      return { ledger: new SpawnLedger(dataDir, new Map()), corruptionError };
    }

    const file = parsed as LedgerFile;
    const entries = new Map<string, LedgerEntry>();
    for (const e of file.entries) {
      if (
        typeof e.pid === "number" &&
        typeof e.projectTag === "string" &&
        typeof e.taskId === "string" &&
        typeof e.sessionPath === "string" &&
        typeof e.worktree === "string" &&
        typeof e.driverId === "string" &&
        typeof e.sessionId === "string" &&
        typeof e.spawnedAt === "string"
      ) {
        entries.set(`${e.projectTag}/${e.taskId}`, e);
      } else {
        // Skip malformed entries (individual corruption → skip, not crash)
        corruptionError =
          corruptionError ??
          `spawn-ledger.json contains malformed entry (skipped): ${JSON.stringify(e)}`;
      }
    }

    return { ledger: new SpawnLedger(dataDir, entries), corruptionError };
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Register a newly-spawned session in the ledger.
   * Atomically flushes to disk (I2: no partial write).
   */
  add(entry: LedgerEntry): void {
    this.entries.set(`${entry.projectTag}/${entry.taskId}`, entry);
    this.flush();
  }

  /**
   * 既にある1件を書き足す（起動のあとで分かることを載せるため。例：子プロセスの pid）。
   *
   * **無ければ何もしない。** 起こした職人が走査より先に畳まれることはあり、そのとき
   * 台帳へ書き戻すと死んだ職人が生き返る。載せ先が無かったことは戻り値で伝える
   * （呼び出し側はイベントログの方へ残す）。
   *
   * `pid` / `projectTag` / `taskId` は鍵なので差し替えさせない。
   *
   * @returns 書けたら true、その職人が台帳に居なければ false
   */
  update(
    projectTag: string,
    taskId: string,
    patch: Partial<Omit<LedgerEntry, "projectTag" | "taskId" | "pid">>
  ): boolean {
    const key = `${projectTag}/${taskId}`;
    const current = this.entries.get(key);
    if (!current) return false;
    this.entries.set(key, { ...current, ...patch });
    this.flush();
    return true;
  }

  /**
   * Remove a ledger entry (on exit or after orphan recovery).
   * Atomically flushes to disk.
   */
  remove(projectTag: string, taskId: string): void {
    const key = `${projectTag}/${taskId}`;
    if (!this.entries.has(key)) return;
    this.entries.delete(key);
    this.flush();
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Returns all ledger entries as an array. */
  list(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  /** Returns a single entry by projectTag + taskId, or undefined. */
  get(projectTag: string, taskId: string): LedgerEntry | undefined {
    return this.entries.get(`${projectTag}/${taskId}`);
  }

  /** Number of active entries. */
  get size(): number {
    return this.entries.size;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Atomic write: write to a temp file in the same directory, then rename.
   * I2: throws on write error (caller will log and continue if needed).
   */
  private flush(): void {
    const file: LedgerFile = {
      version: 1,
      entries: [...this.entries.values()],
    };
    const json = JSON.stringify(file, null, 2);

    // Write to a temp file in the same directory (same filesystem), then rename
    // (atomic on POSIX).
    const dir = path.dirname(this.ledgerPath);
    fs.mkdirSync(dir, { recursive: true });

    // Use a temp path in the same directory as the ledger (same filesystem for rename).
    const tmpPath = path.join(dir, `.spawn-ledger.tmp.${process.pid}.${Date.now()}`);
    try {
      fs.writeFileSync(tmpPath, json, { encoding: "utf8", flag: "w" });
      fs.renameSync(tmpPath, this.ledgerPath);
    } catch (err) {
      // Best-effort cleanup of the temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err; // I2: propagate
    }
  }
}

// ── Process liveness check ─────────────────────────────────────────────────

/**
 * Check if a process with the given PID is still running.
 * Uses kill(pid, 0) — no signal sent, just an existence check.
 *
 * Returns true if the process exists and we have permission to signal it.
 * Returns false if the process is gone (ESRCH) or we lack permission (EPERM
 * still means it exists, so EPERM → true).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // success → process exists
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // exists but owned by another user
    return false; // ESRCH → process not found
  }
}

/**
 * Kill a process by PID with SIGTERM, then SIGKILL after a timeout.
 * Returns a Promise that resolves when the process is confirmed gone
 * (or timeout elapses).
 *
 * D6: uses only process.kill + setTimeout (stdlib).
 */
export async function killOrphanProcess(pid: number, timeoutMs = 5000): Promise<void> {
  if (!isProcessAlive(pid)) return; // Already gone

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone between check and kill
    return;
  }

  // Wait for SIGTERM to take effect, polling every 50 ms.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
    if (!isProcessAlive(pid)) return;
  }

  // SIGKILL if still alive
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore — process may have died between last check and SIGKILL
  }

  // Wait another 500 ms for SIGKILL to take effect
  await new Promise<void>((r) => setTimeout(r, 500));
}
