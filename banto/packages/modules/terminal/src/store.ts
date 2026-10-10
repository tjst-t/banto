// **前にあったセッションの控え**（v4-modules.md §4.6「コンテナを起こし直すと消える」）。
//
// tmux のセッションはコンテナの中にだけあり、コンテナを起こし直すと消える。消えたことを人に見せ、同じ名前と
// 作業ディレクトリで作り直せるように、名前と最後に見た作業ディレクトリだけを Module の置き場（host のディスク）に控える。
// **生きているかどうかの真実は tmux**——控えは「前にあった」ことだけを言う（規則3）。中身・打った文字は控えない。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface KnownSession {
  name: string;
  cwd: string;
}

interface StoreFile {
  version: 1;
  sessions: KnownSession[];
}

export class SessionStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "sessions.json");
  }

  read(): KnownSession[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (!Array.isArray(parsed.sessions)) throw new Error(`${this.path} の形が違います（sessions がありません）`);
    return parsed.sessions.filter(
      (s): s is KnownSession => typeof s === "object" && s !== null && typeof s.name === "string" && typeof s.cwd === "string",
    );
  }

  private write(sessions: KnownSession[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, sessions } satisfies StoreFile, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** 生きているものの名前と作業ディレクトリを控えに足す・直す（控えにしか無いものはそのまま残す） */
  remember(live: KnownSession[]): void {
    const current = this.read();
    const next = current.map((s) => live.find((l) => l.name === s.name) ?? s);
    for (const l of live) if (!next.some((s) => s.name === l.name)) next.push(l);
    if (JSON.stringify(next) !== JSON.stringify(current)) this.write(next);
  }

  rename(from: string, to: string): void {
    // 同じ名前の古い控え（消えたセッション）は、新しい名前のものに譲る
    this.write(this.read().filter((s) => s.name !== to).map((s) => (s.name === from ? { ...s, name: to } : s)));
  }

  forget(name: string): void {
    const current = this.read();
    const next = current.filter((s) => s.name !== name);
    if (next.length !== current.length) this.write(next);
  }
}
