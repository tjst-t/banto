// **Module の置き場に残す状態**：設定（使われなければ止めるまでの時間）と「AI に触らせない」。
// プロファイルと同じく、止めても起こし直しても残る（v4-modules.md §4.1「人と AI の同時操作」）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BrowserState {
  /** AI の呼び出しが無いままこれだけたったら止める（分。30 は仮——v4-modules.md §4.1） */
  idleMinutes: number;
  /** 人が「AI に触らせない」を入れている */
  aiBlocked: boolean;
}

export const DEFAULT_STATE: BrowserState = { idleMinutes: 30, aiBlocked: false };

export class StateFile {
  private state: BrowserState;

  constructor(private readonly path: string) {
    this.state = { ...DEFAULT_STATE };
    if (existsSync(path)) {
      // 壊れていたら止める（規則2）——黙って既定に戻すと「AI に触らせない」が切れる
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BrowserState>;
      if (raw.idleMinutes !== undefined) {
        if (typeof raw.idleMinutes !== "number" || raw.idleMinutes <= 0) throw new Error(`${path}: idleMinutes が正の数ではありません`);
        this.state.idleMinutes = raw.idleMinutes;
      }
      if (raw.aiBlocked !== undefined) {
        if (typeof raw.aiBlocked !== "boolean") throw new Error(`${path}: aiBlocked が true / false ではありません`);
        this.state.aiBlocked = raw.aiBlocked;
      }
    }
  }

  get(): BrowserState {
    return { ...this.state };
  }

  set(patch: Partial<BrowserState>): BrowserState {
    this.state = { ...this.state, ...patch };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
    return this.get();
  }
}
