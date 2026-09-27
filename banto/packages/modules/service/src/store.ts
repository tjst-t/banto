// 登録（マスター）の置き場。Module のデータ置き場（host のディスク、Project ごと）の `services.json`。
// **秘密の値は置かない**——envSecrets は alias 名だけ（docs/specs/v4-modules.md §4.2）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServiceRecord } from "./spec.js";

interface StoreFile {
  version: 1;
  services: Record<string, ServiceRecord>;
}

export class ServiceStore {
  private readonly path: string;
  constructor(dataDir: string) {
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

  /** 書きかけで落ちても壊れた登録が残らないよう、別名に書いてから置き換える */
  private async write(services: Record<string, ServiceRecord>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    const body: StoreFile = { version: 1, services };
    await writeFile(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
