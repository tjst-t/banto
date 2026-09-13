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
//
// **共通グループも紐付けにする**（追加・2026-09-13、ユーザー指摘）。以前は
// `const INSTANCE_GROUP = "instance"` というリテラルの決め打ちで、**そこだけ
// 選ぶ口が無かった**。その結果、同じ backend を指した2台目の banto が現れると
// **人が何も割り当てていないのに共通の秘密が共有される**——仕様が唯一避けたかった
// 「自動的に共有が起きる」形が、ここにだけ残っていた。Project 側と対称にする。

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 何も決めていないときの共通グループ名。**変えられる**（以前は決め打ちだった）。 */
export const DEFAULT_SHARED_GROUP = "instance";

export class GroupBindings {
  private readonly filePath: string;
  private bindings = new Map<string, string>();
  private shared: string = DEFAULT_SHARED_GROUP;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "group-bindings.json");
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    const raw = JSON.parse(await readFile(this.filePath, "utf8")) as
      | Record<string, string>
      | { shared?: string; projects?: Record<string, string> };
    // **古い形（projectId → group の平たい表）もそのまま読む**（規則2——
    // 推測で書き換えない。次に書くときに新しい形になる）
    if (raw && typeof raw === "object" && ("projects" in raw || "shared" in raw)) {
      const next = raw as { shared?: string; projects?: Record<string, string> };
      this.bindings = new Map(Object.entries(next.projects ?? {}));
      this.shared = next.shared ?? DEFAULT_SHARED_GROUP;
      return;
    }
    this.bindings = new Map(Object.entries(raw as Record<string, string>));
  }

  /** この backend の共通グループ（どの Project からでも使える置き場）。 */
  sharedGroup(): string {
    return this.shared;
  }

  async setSharedGroup(group: string): Promise<void> {
    this.shared = group;
    await this.save();
  }

  /**
   * そのグループに紐付いている Project（**複数あり得る**）。
   * 同じグループを2つの Project に割り当てるのが「共有する」という人の意思表示。
   */
  projectsFor(group: string): string[] {
    return Array.from(this.bindings)
      .filter(([, g]) => g === group)
      .map(([projectId]) => projectId);
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
    await writeFile(
      tmp,
      JSON.stringify({ shared: this.shared, projects: Object.fromEntries(this.bindings) }),
      { mode: 0o600 },
    );
    await rename(tmp, this.filePath);
  }
}
