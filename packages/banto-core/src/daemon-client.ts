/**
 * DaemonClient: fetch-based HTTP client for the banto-daemon REST API.
 *
 * Runtime-neutral (Node.js >= 18 global fetch). Used by banto-cli and future GUIs.
 * BANTO_DAEMON_URL env var sets the base URL (default: http://localhost:3000).
 *
 * D5: no logic here beyond HTTP request construction and response parsing.
 * D6: uses global fetch (Node >=18 built-in); no additional dependencies.
 * I2: network errors and non-2xx responses throw (not swallowed).
 */

import type { TaskRecord } from "./event-log.js";

export interface ProjectEntry {
  id: string;
  repoPath: string;
  profile: string;
  registeredAt: string;
}

export interface HealthResponse {
  status: "ok";
}

/** I2: typed error so callers can distinguish connection failure from API errors */
export class DaemonConnectionError extends Error {
  constructor(url: string, cause: unknown) {
    super(
      `Cannot connect to banto-daemon at ${url}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "DaemonConnectionError";
  }
}

export class DaemonApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`Daemon API error ${status}: ${message}`);
    this.name = "DaemonApiError";
  }
}

export class DaemonClient {
  readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl ??
      process.env["BANTO_DAEMON_URL"] ??
      "http://localhost:3000";
  }

  /** Check daemon health. Throws DaemonConnectionError on connection failure. */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/api/v1/health");
  }

  /** List all registered projects. */
  async listProjects(): Promise<ProjectEntry[]> {
    const body = await this.get<{ projects: ProjectEntry[] }>("/api/v1/projects");
    return body.projects;
  }

  /** List tasks for a project. */
  async listTasks(projectTag: string): Promise<TaskRecord[]> {
    const body = await this.get<{ tasks: TaskRecord[] }>(
      `/api/v1/projects/${encodeURIComponent(projectTag)}/tasks`
    );
    return body.tasks;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new DaemonConnectionError(this.baseUrl, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed["error"] === "string") msg = parsed["error"];
      } catch {
        // use raw text
      }
      throw new DaemonApiError(res.status, msg);
    }
    return res.json() as Promise<T>;
  }
}
