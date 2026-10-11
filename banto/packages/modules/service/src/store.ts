// 登録（マスター）の置き場。Module のデータ置き場（host のディスク、Project ごと）の `services.json`。
// **秘密の値は置かない**——envSecrets は alias 名だけ（docs/specs/v4-modules.md §4.2）。

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceRecord } from "./spec.js";

/** 移した印の名前（core の `runtime/project-move.ts` と同じ） */
export const MOVED_MARKER = ".banto-moved.json";

interface StoreFile {
  version: 1;
  services: Record<string, ServiceRecord>;
}

export class ServiceStore {
  private readonly path: string;
  constructor(private readonly dataDir: string) {
    this.path = join(dataDir, "services.json");
  }

  async all(): Promise<Record<string, ServiceRecord>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoreFile;
      if (parsed.version !== 1 || typeof parsed.services !== "object") {
        throw new Error(`登録の形が読めません（${this.path}）`);
      }
      return parsed.services;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async get(name: string): Promise<ServiceRecord | undefined> {
    return (await this.all())[name];
  }

  async put(name: string, record: ServiceRecord): Promise<void> {
    const services = await this.all();
    services[name] = record;
    await this.write(services);
  }

  async delete(name: string): Promise<void> {
    const services = await this.all();
    delete services[name];
    await this.write(services);
  }

  /**
   * **Project を別の実行場所へ移した印**（`.banto-moved.json`、v4-security.md §1「Service を止めたまま写す」）。core が
   * 写した置き場の直下に置く。あれば、登録を全件「止めておきたい」にしてから印を消す（移した先で勝手に起こさない）。
   * 印を消すのは書き換えのあと——途中で落ちても、次に起きたときにもう一度やる。印があって何かを変えたなら true
   */
  async applyMovedMarker(): Promise<boolean> {
    const marker = join(this.dataDir, MOVED_MARKER);
    try {
      await stat(marker);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    const services = await this.all();
    for (const rec of Object.values(services)) rec.desired = "stopped";
    await this.write(services);
    await rm(marker, { force: true });
    return true;
  }

  /** 書きかけで落ちても壊れた登録が残らないよう、別名に書いてから置き換える */
  private async write(services: Record<string, ServiceRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    const body: StoreFile = { version: 1, services };
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
