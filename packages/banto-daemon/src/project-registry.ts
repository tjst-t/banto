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

/**
 * 制御の弁ひとつ分（PO 裁定 2026-08-13・inc-0063）。
 *
 * **省略は「回っている」**——既にある projects.json（この項目を持たない）を読んでも
 * 振る舞いが変わらないようにするため。止めたときだけ `{ enabled: false }` が書かれる。
 *
 * 理由と時刻を持つのは、**黙って止まっているのが一番困る**から。読み口
 * （`kobo.projects`）はここをそのまま出す。
 */
export interface ProjectControl {
  enabled: boolean;
  /** なぜ止めた（動かした）のか。 */
  reason?: string;
  /** いつ切り替えたか（ISO-8601）。 */
  changedAt: string;
}

export interface ProjectEntry {
  id: string;
  repoPath: string;
  profile: string;
  registeredAt: string;
  /** watcher が work/tasks/*.md を取り込むか。省略＝取り込む。 */
  watch?: ProjectControl;
  /** マージキュー（rebase・自動起票・状態遷移）を回すか。省略＝回す。 */
  mergeQueue?: ProjectControl;
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

  /**
   * 受け持ちを外す（PO 裁定 2026-08-13）。
   *
   * **帳簿は消さない。** 消えるのはこのファイルの1行だけで、イベントログもタスクの記録も
   * そのまま残る——だから同じ id で登録し直せば、経緯はそのまま繋がる。
   *
   * I2: 知らない id は `undefined` を返す。呼び出し側（Daemon）が理由を付けて断る。
   */
  unregister(id: string): ProjectEntry | undefined {
    const entry = this.projects.get(id);
    if (!entry) return undefined;
    this.projects.delete(id);
    this.persist();
    return entry;
  }

  /**
   * 制御の弁を切り替える（`watch` / `mergeQueue`）。
   *
   * **必ず書き切ってから返る**（`persist` は同期）。再起動で消える設定では止血にならない。
   */
  setControl(
    id: string,
    which: "watch" | "mergeQueue",
    enabled: boolean,
    reason: string | undefined,
    now: string = new Date().toISOString()
  ): ProjectEntry | undefined {
    const entry = this.projects.get(id);
    if (!entry) return undefined;
    const control: ProjectControl = {
      enabled,
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
      changedAt: now,
    };
    const next: ProjectEntry = { ...entry, [which]: control };
    this.projects.set(id, next);
    this.persist();
    return next;
  }

  /** 弁がいま開いているか。登録が無ければ false（外れているものは回さない）。 */
  isEnabled(id: string, which: "watch" | "mergeQueue"): boolean {
    const entry = this.projects.get(id);
    if (!entry) return false;
    // 省略＝開いている（この項目を持たない古い projects.json との互換）
    return entry[which]?.enabled ?? true;
  }
}
