/**
 * Daemon: core orchestration engine.
 *
 * Composes:
 *   - EventLog (append-only JSONL truth)
 *   - StateStore (in-memory derived state, rebuilt on replay)
 *   - EventIndex (in-memory task/project history views)
 *   - ProjectRegistry (project metadata)
 *   - StateMachine (transition rules)
 *   - WsEventServer (real-time event broadcast)
 *
 * D3: state is derived from events, never written directly.
 * D5: all logic lives here; HTTP/WS layers are pure routing/transport.
 * I2: errors propagate; no silent swallowing.
 */

import * as http from "node:http";
import {
  EventLog,
  StateStore,
  EventIndex,
  StateMachine,
} from "@banto/core";
import type { OrchestrationEvent, TaskStatus, TaskRecord, TransitionResult } from "@banto/core";
import { ProjectRegistry } from "./project-registry.js";
import type { ProjectEntry } from "./project-registry.js";
import { WsEventServer } from "./ws-server.js";
import { createHttpServer } from "./http-server.js";

export interface DaemonConfig {
  /** Port to listen on. Default: 3000 */
  port: number;
  /** Root data directory (event log + registry). Default: ./data */
  dataDir: string;
}

export class Daemon {
  private readonly config: DaemonConfig;
  private readonly log: EventLog;
  private store: StateStore;
  private index: EventIndex;
  private readonly registry: ProjectRegistry;
  private readonly httpServer: http.Server;
  private readonly wsServer: WsEventServer;

  private constructor(config: DaemonConfig) {
    this.config = config;
    this.log = EventLog.open(config.dataDir);
    this.store = StateStore.replay(this.log);
    this.index = EventIndex.build(this.log);
    this.registry = ProjectRegistry.open(config.dataDir);

    this.httpServer = createHttpServer(this);
    this.wsServer = new WsEventServer(this.httpServer, (projectTag) =>
      this.log.getEventsByProject(projectTag)
    );
  }

  static create(config: Partial<DaemonConfig> = {}): Daemon {
    const resolved: DaemonConfig = {
      port: config.port ?? parseInt(process.env["BANTO_PORT"] ?? "3000", 10),
      dataDir: config.dataDir ?? process.env["BANTO_DATA_DIR"] ?? "./data",
    };
    return new Daemon(resolved);
  }

  /** Start listening. Returns a promise that resolves when the server is bound. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.config.port, "0.0.0.0", () => {
        process.stdout.write(
          `[banto-daemon] listening on port ${this.config.port} (dataDir=${this.config.dataDir})\n`
        );
        resolve();
      });
    });
  }

  /** Stop the daemon gracefully. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wsServer.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err);
          else {
            this.log.close();
            resolve();
          }
        });
      });
    });
  }

  /** Return the bound port (useful in tests when port=0). */
  get port(): number {
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.config.port;
  }

  // ── Project registry ───────────────────────────────────────────────────────

  listProjects(): ProjectEntry[] {
    return this.registry.list();
  }

  registerProject(id: string, repoPath: string, profile: string = "default"): ProjectEntry {
    return this.registry.register(id, repoPath, profile);
  }

  projectExists(id: string): boolean {
    return this.registry.has(id);
  }

  // ── Task operations ────────────────────────────────────────────────────────

  getTasksByProject(projectTag: string): TaskRecord[] {
    return this.store.getTasksByProject(projectTag);
  }

  /**
   * Get a task by project + taskId.
   * Uses composite key lookup (O(1)) to enforce <project>/<id> namespace
   * isolation (spec-multi-project §2).
   */
  getTask(projectTag: string, taskId: string): TaskRecord | undefined {
    return this.store.getTask(taskId, projectTag);
  }

  /**
   * Get events for a task, scoped to the given project.
   * Passes projectTag to EventIndex to enforce namespace isolation
   * (spec-multi-project §2): two projects may share the same taskId.
   */
  getTaskEvents(projectTag: string, taskId: string): OrchestrationEvent[] {
    return this.index.getTaskHistory(taskId, projectTag);
  }

  /**
   * Create a new task in draft status.
   * Appends task_created event and refreshes in-memory state.
   */
  createTask(
    projectTag: string,
    taskId: string,
    title: string,
    extra: Record<string, unknown> = {}
  ): TaskRecord {
    // Use composite key lookup to check for duplicate within this project only
    const existing = this.store.getTask(taskId, projectTag);
    if (existing) {
      throw new Error(`Task '${taskId}' already exists in project '${projectTag}'`);
    }

    const { id: _id, title: _title, ...rest } = extra; // eslint-disable-line @typescript-eslint/no-unused-vars
    const event = this.log.append({
      type: "task_created",
      projectTag,
      taskId,
      payload: { title, ...rest },
    });

    this.applyAndBroadcast(event);

    const task = this.store.getTask(taskId, projectTag);
    if (!task) throw new Error("Invariant: task not found after creation"); // I2
    return task;
  }

  /**
   * Attempt a state transition for a task.
   * On rejection: appends transition_rejected event (I2) and returns { ok: false }.
   * Refreshes in-memory state and broadcasts on success.
   */
  transition(
    projectTag: string,
    taskId: string,
    to: string,
    reason?: string
  ): TransitionResult {
    const task = this.store.getTask(taskId, projectTag);
    if (!task) return { ok: false, reason: "task_not_found" };

    const fromStatus = task.status as TaskStatus;
    const toStatus = to as TaskStatus;

    const result = StateMachine.transition(
      this.log,
      taskId,
      fromStatus,
      toStatus,
      projectTag,
      reason
    );

    // Refresh state + index regardless of result (rejection events are also appended)
    this.refreshState();
    // Broadcast the last appended event (transition or rejection)
    const allEvents = this.log.readAllEvents();
    if (allEvents.length > 0) {
      const lastEvent = allEvents[allEvents.length - 1];
      this.wsServer.broadcast(lastEvent);
    }

    return result;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Apply a freshly-appended event to in-memory state and broadcast via WS.
   * D3: StateStore and EventIndex are always derived from the log.
   */
  private applyAndBroadcast(event: OrchestrationEvent): void {
    this.refreshState();
    this.wsServer.broadcast(event);
  }

  /**
   * Rebuild in-memory state by replaying the log.
   * Called after every write to keep derived state consistent.
   * D3: no mutable in-place mutation; always a clean replay.
   */
  private refreshState(): void {
    this.store = StateStore.replay(this.log);
    this.index = EventIndex.build(this.log);
  }
}
