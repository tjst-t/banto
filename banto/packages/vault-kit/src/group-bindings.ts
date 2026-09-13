// Project ↔ backend グループの紐付け（docs/specs/v4-modules.md §2.1
// 「Project ↔ backend グループの紐付け（複数ホスト共有、決定・2026-09-02）」）。
//
// **なぜ Vault が持つか**：紐付けの相手は「その backend のグループ」なので、
// グループを持っている側と同じ管理下に置く（規則3——同じことを core 側にも
// 写すと、いつか食い違う）。VaultUI は admin tool 越しに読み書きする。
//
// **なぜ core の Configuration ではないか**：banto のインストールが複数台
// あっても、同じ backend・同じグループを人が割り当てれば共有が起きる、という
// のが仕様の形。共有の合図はグループ名そのものであって、banto 側の設定では
// ない。banto 側に置くと、ホストごとに別の写しができる。

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class GroupBindings {
  private readonly filePath: string;
  private bindings = new Map<string, string>();
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "group-bindings.json");
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, string>;
    this.bindings = new Map(Object.entries(raw));
  }

  get(projectId: string): string | undefined {
    return this.bindings.get(projectId);
  }

  list(): Array<{ projectId: string; group: string }> {
    return Array.from(this.bindings, ([projectId, group]) => ({ projectId, group }));
  }

  async set(projectId: string, group: string): Promise<void> {
    this.bindings.set(projectId, group);
    await this.save();
  }

  /** aliases.json と同じ書き方——tmp → rename、書き込みは1本に並べる。 */
  private async save(): Promise<void> {
    const write = this.saveChain.then(
      () => this.writeSnapshot(),
      () => this.writeSnapshot(),
    );
    this.saveChain = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  private async writeSnapshot(): Promise<void> {
    await mkdir(join(this.filePath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.bindings)), { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}
