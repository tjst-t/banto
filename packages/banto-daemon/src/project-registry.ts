/**
 * ProjectRegistry: persistent store for registered projects.
 *
 * D3: registry is the canonical source for project metadata.
 * Multi-project ID namespace: <project>/<id> (spec-multi-project §2).
 * I2: errors thrown to caller.
 *
 * Persistence: JSON file at <dataDir>/projects.json
 * Written synchronously on every mutation (small file, write-on-change is safe).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectEntry {
  id: string;
  repoPath: string;
  profile: string;
  registeredAt: string;
}

interface RegistryFile {
  projects: ProjectEntry[];
}

export class ProjectRegistry {
  private readonly filePath: string;
  private projects: Map<string, ProjectEntry> = new Map();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Open (or create) a project registry at the given data directory. */
  static open(dataDir: string): ProjectRegistry {
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, "projects.json");
    const registry = new ProjectRegistry(filePath);
    registry.load();
    return registry;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.projects = new Map();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as RegistryFile;
      this.projects = new Map(data.projects.map((p) => [p.id, p]));
    } catch (err) {
      // I2: corrupt registry is a serious condition — re-throw to surface it
      throw new Error(
        `ProjectRegistry: failed to load registry from ${this.filePath}: ${String(err)}`
      );
    }
  }

  private persist(): void {
    const data: RegistryFile = {
      projects: Array.from(this.projects.values()),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * Register a new project. Returns the entry.
   * Throws if the project ID is already registered.
   */
  register(id: string, repoPath: string, profile: string = "default"): ProjectEntry {
    if (this.projects.has(id)) {
      throw new Error(`Project '${id}' is already registered`);
    }
    const entry: ProjectEntry = {
      id,
      repoPath,
      profile,
      registeredAt: new Date().toISOString(),
    };
    this.projects.set(id, entry);
    this.persist();
    return entry;
  }

  /** List all registered projects. */
  list(): ProjectEntry[] {
    return Array.from(this.projects.values());
  }

  /** Get a single project by ID. Returns undefined if not found. */
  get(id: string): ProjectEntry | undefined {
    return this.projects.get(id);
  }

  /** Check if a project is registered. */
  has(id: string): boolean {
    return this.projects.has(id);
  }
}
