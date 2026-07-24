/**
 * EventLog: append-only JSONL segment writer/reader.
 *
 * Segments: events/YYYY-MM.jsonl
 * Active segment: always one file path tracked for appending.
 * Transcripts are NOT recorded — only path references (spec §2.1).
 * eventId is monotonically increasing across all segments.
 *
 * Write strategy: synchronous appendFileSync per event.
 * This is simpler than a WriteStream and avoids async teardown issues.
 * Durability is guaranteed before append() returns (I2).
 *
 * D3: derived state (task status etc.) is NOT stored here.
 * I2: errors are not swallowed; thrown to caller.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OrchestrationEvent } from "./events.js";

/**
 * Payload for appending (eventId and timestamp are assigned by EventLog).
 * Distributes Omit over the discriminated union so each member remains valid.
 */
export type EventPayload = {
  [K in OrchestrationEvent["type"]]: Omit<Extract<OrchestrationEvent, { type: K }>, "eventId" | "timestamp">;
}[OrchestrationEvent["type"]];

export interface ReplayStats {
  snapshotUsed: boolean;
  eventsReplayed: number;
}

/** Snapshot persisted to disk on rotation */
export interface Snapshot {
  /** Segment filename that was active when the snapshot was taken */
  segmentFile: string;
  /** eventId of the last event included in the snapshot */
  lastEventId: number;
  /** ISO-8601 timestamp of snapshot creation */
  createdAt: string;
  /** Serialized state store content */
  state: SnapshotState;
}

export interface SnapshotState {
  tasks: Record<string, TaskRecord>;
}

export interface TaskRecord {
  id: string;
  status: string;
  projectTag: string;
  title: string;
  [key: string]: unknown;
}

/** Default segment size threshold: 10 MB */
const DEFAULT_SEGMENT_SIZE_BYTES = 10 * 1024 * 1024;

export class EventLog {
  private readonly eventsDir: string;
  private readonly snapshotPath: string;
  private activeSegmentPath: string | null = null;
  private nextEventId: number = 1;
  private closed: boolean = false;

  private constructor(private readonly baseDir: string) {
    this.eventsDir = path.join(baseDir, "events");
    this.snapshotPath = path.join(baseDir, "snapshot.json");
  }

  /**
   * Open (or create) the event log in the given directory.
   * Determines the next eventId from existing segments.
   */
  static open(baseDir: string): EventLog {
    fs.mkdirSync(path.join(baseDir, "events"), { recursive: true });
    const log = new EventLog(baseDir);
    log.initialize();
    return log;
  }

  private initialize(): void {
    // Determine nextEventId from existing segments
    const segments = this.listSegments();
    if (segments.length === 0) {
      this.nextEventId = 1;
      this.activeSegmentPath = path.join(this.eventsDir, this.currentSegmentName());
      return;
    }

    // Find highest eventId across all segments
    let maxEventId = 0;
    for (const seg of segments) {
      const segPath = path.join(this.eventsDir, seg);
      const raw = fs.readFileSync(segPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line) as OrchestrationEvent;
          if (evt.eventId > maxEventId) maxEventId = evt.eventId;
        } catch {
          // Tolerate partial writes from kill -9 — skip malformed lines (I2: don't swallow, just skip)
        }
      }
    }
    this.nextEventId = maxEventId + 1;

    // Set the most recent segment as active
    const lastSeg = segments[segments.length - 1];
    this.activeSegmentPath = path.join(this.eventsDir, lastSeg);
  }

  private currentSegmentName(): string {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${yyyy}-${mm}.jsonl`;
  }

  /** List all segment filenames in chronological order */
  listSegments(): string[] {
    const files = fs.readdirSync(this.eventsDir);
    const segFiles = files.filter((f) => /^\d{4}-\d{2}(-\d+)?\.jsonl$/.test(f));
    // Sort by (YYYY-MM, numeric suffix): "2026-07" < "2026-07-2" < "2026-07-3" < "2026-08"
    return segFiles.sort((a, b) => {
      const parseSegName = (name: string): [string, number] => {
        const m = name.match(/^(\d{4}-\d{2})(?:-(\d+))?\.jsonl$/);
        if (!m) return [name, 1];
        return [m[1], m[2] ? parseInt(m[2], 10) : 1];
      };
      const [aBase, aN] = parseSegName(a);
      const [bBase, bN] = parseSegName(b);
      if (aBase !== bBase) return aBase < bBase ? -1 : 1;
      return aN - bN;
    });
  }

  /**
   * Append an event to the active segment.
   * Assigns eventId and timestamp automatically.
   * Returns the complete stored event.
   *
   * Uses appendFileSync: each write is atomic at the OS level for small payloads
   * (single syscall), ensuring durability before returning (I2).
   */
  append(payload: EventPayload): OrchestrationEvent {
    if (this.closed) {
      // Daemon is shutting down: in-flight scheduler tick or async job tried to
      // append after the log was closed. Drop the write silently (log to stderr
      // so it's visible in test output but don't throw, which would cause an
      // unhandled rejection from a background timer).
      //
      // I2 note: this is intentional at daemon shutdown, not an error swallow.
      // The event cannot be persisted (log is closed) but the caller's work
      // (recordTaskFailed, state transition) has already completed in-memory.
      // The omission will be recovered on next daemon start via orphan handling.
      process.stderr.write(
        `[banto-daemon] EventLog: drop post-close append (type=${String((payload as Record<string, unknown>)["type"])})\n`
      );
      // Return a minimal event so callers that use the return value don't crash.
      return {
        ...(payload as Record<string, unknown>),
        eventId: -1,
        timestamp: new Date().toISOString(),
      } as unknown as OrchestrationEvent;
    }
    if (!this.activeSegmentPath) {
      throw new Error("EventLog not initialized");
    }

    const event: OrchestrationEvent = {
      ...payload,
      eventId: this.nextEventId++,
      timestamp: new Date().toISOString(),
    } as OrchestrationEvent;

    const line = JSON.stringify(event) + "\n";
    // Synchronous write ensures durability before returning (I2)
    fs.appendFileSync(this.activeSegmentPath, line, "utf-8");

    return event;
  }

  /**
   * Rotate the active segment:
   * 1. Archive the current segment
   * 2. Write snapshot with the provided state
   * 3. Open a new active segment (next month or same month with suffix)
   *
   * The caller must build a StateStore and call toSnapshotState() to pass in.
   * Returns the archived segment filename.
   */
  rotate(snapshotState: SnapshotState): string {
    if (this.closed) throw new Error("EventLog is closed");
    if (!this.activeSegmentPath) throw new Error("EventLog not initialized");

    const archivedSegment = path.basename(this.activeSegmentPath);
    const lastEventId = this.nextEventId - 1;

    // Write snapshot
    const snapshot: Snapshot = {
      segmentFile: archivedSegment,
      lastEventId,
      createdAt: new Date().toISOString(),
      state: snapshotState,
    };
    fs.writeFileSync(this.snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

    // Set new active segment
    const newSegName = this.nextNewSegmentName(archivedSegment);
    this.activeSegmentPath = path.join(this.eventsDir, newSegName);

    return archivedSegment;
  }

  private nextNewSegmentName(archivedName: string): string {
    // Try current month first
    const current = this.currentSegmentName();

    // If the current month name doesn't exist on disk, it is safe to use
    if (!fs.existsSync(path.join(this.eventsDir, current))) return current;

    // The file already exists on disk (either it is the archived segment or a
    // previously archived segment with the same month name).  Find the next
    // available suffixed name: YYYY-MM-2.jsonl, -3, … until one is absent.
    const base = current.replace(/\.jsonl$/, "");
    let n = 2;
    while (fs.existsSync(path.join(this.eventsDir, `${base}-${n}.jsonl`))) n++;
    return `${base}-${n}.jsonl`;
  }

  /** Read the persisted snapshot (if any) */
  readSnapshot(): Snapshot | null {
    if (!fs.existsSync(this.snapshotPath)) return null;
    try {
      const raw = fs.readFileSync(this.snapshotPath, "utf-8");
      return JSON.parse(raw) as Snapshot;
    } catch (err) {
      // I2: warn on stderr — corrupt snapshot is an abnormal condition.
      // Falling back to full replay is safe but callers must know this happened.
      process.stderr.write(
        `[banto-core] WARNING: snapshot at ${this.snapshotPath} is corrupt and will be ignored; ` +
          `falling back to full replay. Error: ${String(err)}\n`
      );
      return null;
    }
  }

  /**
   * Read events from a segment file, skipping malformed lines.
   * Tolerates partial final line from kill -9.
   */
  readSegment(segName: string): OrchestrationEvent[] {
    const segPath = path.join(this.eventsDir, segName);
    if (!fs.existsSync(segPath)) return [];
    const raw = fs.readFileSync(segPath, "utf-8");
    const events: OrchestrationEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as OrchestrationEvent);
      } catch {
        // Partial write from kill -9 — tolerate and continue
      }
    }
    return events;
  }

  /**
   * Read events from the active segment only (used during replay with snapshot).
   */
  readActiveSegment(): OrchestrationEvent[] {
    if (!this.activeSegmentPath) return [];
    return this.readSegment(path.basename(this.activeSegmentPath));
  }

  /**
   * Return events for a specific taskId (scans all segments).
   * Uses in-memory scan — D3: no persistent index.
   */
  getEventsByTask(taskId: string): OrchestrationEvent[] {
    const all = this.readAllEvents();
    return all.filter((e) => "taskId" in e && (e as { taskId: string }).taskId === taskId);
  }

  /**
   * Return events for a specific projectTag (scans all segments).
   */
  getEventsByProject(projectTag: string): OrchestrationEvent[] {
    const all = this.readAllEvents();
    return all.filter((e) => e.projectTag === projectTag);
  }

  /** Read ALL events from all segments in eventId order */
  readAllEvents(): OrchestrationEvent[] {
    if (this.closed) {
      // Log is closed (daemon shutting down). Return empty array rather than
      // throwing or reading a deleted directory. In-flight ticks see an empty
      // log and do nothing useful — which is correct during shutdown.
      return [];
    }
    const segments = this.listSegments();
    const all: OrchestrationEvent[] = [];
    for (const seg of segments) {
      all.push(...this.readSegment(seg));
    }
    return all.sort((a, b) => a.eventId - b.eventId);
  }

  /**
   * Close the event log (no-op now since we use appendFileSync).
   * Kept for API symmetry and forward compatibility.
   */
  close(): void {
    this.closed = true;
  }

  /** The directory where events are stored */
  get eventsDirPath(): string {
    return this.eventsDir;
  }

  /** Current active segment filename (for debugging) */
  get activeSegmentName(): string | null {
    return this.activeSegmentPath ? path.basename(this.activeSegmentPath) : null;
  }

  /** Check segment size to decide if rotation is needed */
  shouldRotate(thresholdBytes: number = DEFAULT_SEGMENT_SIZE_BYTES): boolean {
    if (!this.activeSegmentPath) return false;
    try {
      const stat = fs.statSync(this.activeSegmentPath);
      return stat.size >= thresholdBytes;
    } catch {
      return false;
    }
  }
}
