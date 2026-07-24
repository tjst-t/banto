/**
 * Scheduler: periodic job runner for banto-daemon.
 *
 * Drives all tick-based processing (spec §5):
 *   - TTL enforcement / quota checks
 *   - Reconciliation loop (spawn/env)
 *   - Dependency gate re-evaluation (queued → ready promotion)
 *   - Cadence / meta-cadence / evaluation card synthesis
 *   - Snapshot / rotation / rollup
 *   - Task definition watcher (via registered jobs)
 *
 * Design rules:
 *   D6: uses only node:setInterval — no external scheduler library.
 *   I2: job failures are caught, recorded as tick_job_failed events, and the
 *       scheduler continues. A failing job does NOT crash the daemon.
 *
 * Usage:
 *   const sched = new Scheduler(log, intervalMs);
 *   sched.registerJob("rotation-check", () => { ... });
 *   sched.start();
 *   // ...
 *   sched.stop();
 */

import type { EventLog } from "@banto/core";

/** A named periodic job function */
export type TickJob = () => void | Promise<void>;

export class Scheduler {
  private readonly jobs: Map<string, TickJob> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Promise for the currently-executing runAllJobs() call, or null when idle.
   * Used by stop() to await in-flight job completion before the caller closes
   * the event log (D3/I2: no events must be dropped after log.close()).
   */
  private _inFlightRun: Promise<void> | null = null;

  constructor(
    private readonly log: EventLog,
    private readonly intervalMs: number
  ) {}

  /**
   * Register a named periodic job.
   * Duplicate names overwrite the previous registration.
   */
  registerJob(name: string, fn: TickJob): void {
    this.jobs.set(name, fn);
  }

  /**
   * Start the periodic ticker.
   * Calling start() on an already-running scheduler is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      // Track the in-flight run so stop() can await it.
      this._inFlightRun = this.runAllJobs().finally(() => {
        this._inFlightRun = null;
      });
    }, this.intervalMs);
    // Allow the Node.js event loop to exit if the timer is the only pending work.
    // Tests rely on unref() so that the process doesn't hang after daemon.stop().
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Stop the periodic ticker and await any in-flight runAllJobs() completion.
   *
   * Drain guarantee: clears the interval first (no new ticks), then awaits the
   * currently-running job batch (if any). This ensures the EventLog is never
   * closed while a job is still mid-execution and trying to append events.
   *
   * D3/I2: the event log is the single runtime truth — no writes must be lost.
   * Daemon.stop() must await this before calling log.close().
   *
   * Calling stop() on an already-stopped scheduler is a no-op.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Await any in-flight runAllJobs() that fired before we cleared the interval.
    if (this._inFlightRun !== null) {
      await this._inFlightRun;
    }
  }

  /** Whether the scheduler is currently running */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Run all registered jobs sequentially, catching per-job errors (I2). */
  async runAllJobs(): Promise<void> {
    for (const [name, fn] of this.jobs) {
      try {
        await fn();
      } catch (err: unknown) {
        // I2: do NOT swallow — record as tick_job_failed event and continue.
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
          this.log.append({
            type: "tick_job_failed",
            // "daemon" is a sentinel projectTag for daemon-internal events.
            projectTag: "daemon",
            jobName: name,
            error: errorMsg,
          });
        } catch (appendErr: unknown) {
          // Last-resort stderr output if even the event log append fails.
          process.stderr.write(
            `[banto-scheduler] CRITICAL: could not record tick_job_failed for job "${name}": ` +
              `${String(appendErr)}. Original error: ${errorMsg}\n`
          );
        }
      }
    }
  }
}
