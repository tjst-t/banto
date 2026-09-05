// alias のメタデータ（kind/scope/note/expiresAt/lastUsedAt）は値と分離して持つ
// ——値を復号せずに読める必要がある（docs/specs/v4-modules.md §2.1 D節）。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AliasKind } from "./backend.js";

export interface AliasMeta {
  name: string;
  kind: AliasKind;
  scope: "instance" | "project";
  note?: string;
  /** backend内のパス（"group/key"）。値そのものではない。 */
  backendPath: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export class AliasRegistry {
  private readonly filePath: string;
  private aliases = new Map<string, AliasMeta>();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "aliases.json");
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(await readFile(this.filePath, "utf8")) as AliasMeta[];
    this.aliases = new Map(raw.map((a) => [a.name, a]));
  }

  private async save(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(this.filePath, JSON.stringify(Array.from(this.aliases.values())), {
      mode: 0o600,
    });
  }

  list(): AliasMeta[] {
    return Array.from(this.aliases.values());
  }

  get(name: string): AliasMeta | undefined {
    return this.aliases.get(name);
  }

  async create(meta: AliasMeta): Promise<void> {
    if (this.aliases.has(meta.name)) throw new Error(`alias "${meta.name}" already exists`);
    this.aliases.set(meta.name, meta);
    await this.save();
  }

  async update(name: string, patch: Partial<Omit<AliasMeta, "name">>): Promise<void> {
    const existing = this.aliases.get(name);
    if (!existing) throw new Error(`alias "${name}" not found`);
    this.aliases.set(name, { ...existing, ...patch });
    await this.save();
  }

  async delete(name: string): Promise<void> {
    this.aliases.delete(name);
    await this.save();
  }

  async markUsed(name: string): Promise<void> {
    const existing = this.aliases.get(name);
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
      await this.save();
    }
  }
}
