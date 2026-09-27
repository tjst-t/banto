// Service の本体（docs/specs/v4-modules.md §4.2）。
//
// **マスターは登録（services.json）、systemd の unit・起動役のコマンド・鍵のファイルはその写し**。
// 写しが消されたり書き換えられたりしたら、登録に合わせて作り直す（読み戻して正にはしない）。
// ただし「動かすか止めるか」は、人が中で止めたものは止めたまま受け入れる（決定・2026-09-27）。

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExitRecord } from "./log-wrapper.js";
import {
  assertName,
  definitionOf,
  normalizeDefinition,
  sameDefinition,
  ServiceError,
  type ServiceDefinition,
  type ServiceRecord,
} from "./spec.js";
import { decideState, parseShow, STATE_LABELS, type ServiceState } from "./state.js";
import type { ServiceStore } from "./store.js";
import type { Systemctl } from "./systemd.js";
import { renderEnvFile, renderUnit, serviceDir, unitName, unitPath, type ServicePaths } from "./unit.js";

export interface ManagerDeps {
  projectRoot: string;
  store: ServiceStore;
  systemctl: Systemctl;
  paths: ServicePaths;
  nodePath: string;
  wrapperPath: string;
  /** alias を値にする（Vault。値は返り値にもログにも出さない） */
  resolveSecret(envName: string, alias: string, onProgress?: (note: string) => void): Promise<string>;
  /** 定義に写す、Module の環境から継ぐもの（Claude のログインの住所と合言葉など） */
  inheritedEnv: Record<string, string>;
  /** 起動を頼んでから状態を見るまで待つ時間（既定 1500ms）。すぐ落ちるものを「動いている」と返さないため */
  settleMs?: number;
}

export interface ServiceStatus {
  name: string;
  command: string;
  cwd: string;
  ports: number[];
  /** 環境変数名 → alias 名（値ではない） */
  envSecrets: Record<string, string>;
  desired: "running" | "stopped";
  state: ServiceState;
  stateLabel: string;
  /** 登録したポートのうち、いま待ち受けているもの・いないもの */
  listening: number[];
  notListening: number[];
  restarts: number;
  startedAt?: string;
  lastExit?: ExitRecord;
  logFile: string;
  note?: string;
}

const UNIT_HEADER = "# banto の Service Module が作った写し";

export class ServiceManager {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly notes = new Map<string, string>();

  constructor(private readonly deps: ManagerDeps) {}

  /** **1本ずつ通す**——同じ Project の別の Thread が同時に頼んでも、登録の読みと書きが交ざらない */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- 写しを作る ------------------------------------------------------------

  private async writeIfChanged(path: string, content: string, mode: number): Promise<boolean> {
    let current: string | undefined;
    try {
      current = await readFile(path, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) return false;
    await writeFile(path, content, { mode });
    return true;
  }

  private unitContent(name: string, rec: ServiceDefinition): string {
    return renderUnit({
      name,
      workingDirectory: resolve(this.deps.projectRoot, rec.cwd),
      nodePath: this.deps.nodePath,
      wrapperPath: this.deps.wrapperPath,
      dir: serviceDir(this.deps.paths, name),
    });
  }

  /** unit と起動役のコマンドを登録に合わせる。unit が無かった（作り直した）なら true */
  private async syncCopies(name: string, rec: ServiceRecord): Promise<{ changed: boolean; recreated: boolean }> {
    const dir = serviceDir(this.deps.paths, name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await this.writeIfChanged(join(dir, "command.sh"), `${rec.command}\n`, 0o600);
    const path = unitPath(this.deps.paths, name);
    const existed = await exists(path);
    const changed = await this.writeIfChanged(path, this.unitContent(name, rec), 0o644);
    return { changed, recreated: !existed };
  }

  /** 鍵のファイル（0600、コンテナの中）。**Vault から引き直す**——起動・起こし直しのたびに最新の値にする */
  private async writeEnv(name: string, rec: ServiceRecord, onProgress?: (n: string) => void): Promise<void> {
    const env: Record<string, string> = { ...this.deps.inheritedEnv };
    for (const [envName, alias] of Object.entries(rec.envSecrets)) {
      env[envName] = await this.deps.resolveSecret(envName, alias, onProgress);
    }
    await writeFile(join(serviceDir(this.deps.paths, name), "env"), renderEnvFile(env), { mode: 0o600 });
  }

  private async sc(args: string[], what: string): Promise<void> {
    const r = await this.deps.systemctl.run(args);
    if (r.code !== 0) throw new ServiceError(`${what}できませんでした（systemctl --user ${args.join(" ")}）: ${(r.stderr || r.stdout).trim()}`);
  }

  /**
   * **写しを登録に合わせる**（Module が起きたとき・各 tool の前）。
   * - unit・コマンドが消されていたり書き換えられていたら作り直す
   * - enable/disable を desired に合わせる（コンテナの起動で起きるかどうか）
   * - **unit が無かったもの**で desired が running なら起こす（定義が消されたままコンテナが起き直した場合、
   *   Module が繋がった時点で戻る——決定・2026-09-27）。unit があって止まっているもの（人が止めた）は起こさない
   * - 登録に無い `banto-*.service`（この Module が作った印のあるもの）は片付ける
   */
  private async reconcile(): Promise<void> {
    await mkdir(this.deps.paths.unitDir, { recursive: true });
    await mkdir(this.deps.paths.stateDir, { recursive: true, mode: 0o700 });
    const records = await this.deps.store.all();
    let reload = false;
    const recreated: string[] = [];
    for (const [name, rec] of Object.entries(records)) {
      const r = await this.syncCopies(name, rec);
      reload ||= r.changed;
      if (r.recreated) recreated.push(name);
    }
    const orphans = await this.orphanUnits(records);
    for (const file of orphans) {
      await this.deps.systemctl.run(["disable", "--now", file]);
      await rm(join(this.deps.paths.unitDir, file), { force: true });
      reload = true;
    }
    if (reload) await this.sc(["daemon-reload"], "systemd に定義を読み直させ");

    for (const [name, rec] of Object.entries(records)) {
      const enabled = (await this.deps.systemctl.run(["is-enabled", unitName(name)])).stdout.trim() === "enabled";
      if (rec.desired === "running" && !enabled) await this.sc(["enable", unitName(name)], `${name} を自動起動に入れ`);
      if (rec.desired === "stopped" && enabled) await this.sc(["disable", unitName(name)], `${name} を自動起動から外し`);
      if (rec.desired === "running" && recreated.includes(name)) {
        if (!(await exists(join(serviceDir(this.deps.paths, name), "env")))) {
          if (Object.keys(rec.envSecrets).length > 0) {
            this.notes.set(name, "鍵のファイルが無いので起こしていません。startService か restartService で起こしてください");
            continue;
          }
          await this.writeEnv(name, rec);
        }
        await this.deps.systemctl.run(["reset-failed", unitName(name)]);
        await this.deps.systemctl.run(["start", unitName(name)]);
      }
    }
  }

  private async orphanUnits(records: Record<string, ServiceRecord>): Promise<string[]> {
    let files: string[];
    try {
      files = await readdir(this.deps.paths.unitDir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const f of files) {
      const m = /^banto-(.+)\.service$/.exec(f);
      if (!m || records[m[1]!]) continue;
      const text = await readFile(join(this.deps.paths.unitDir, f), "utf8").catch(() => "");
      if (text.startsWith(UNIT_HEADER)) out.push(f);
    }
    return out;
  }

  // ---- 状態 --------------------------------------------------------------------

  private async status(name: string, rec: ServiceRecord, listening?: Set<number>): Promise<ServiceStatus> {
    const dir = serviceDir(this.deps.paths, name);
    const show = parseShow(
      (await this.deps.systemctl.run(["show", unitName(name), "-p", "ActiveState,SubState,Result,NRestarts,UnitFileState"])).stdout,
    );
    const lastExit = await readJson<ExitRecord>(join(dir, "exit.json"));
    const started = await readJson<{ at: string }>(join(dir, "started.json"));
    const state = decideState({ show, desired: rec.desired, lastExit, startedAt: started?.at });
    const ports = listening ?? (await this.deps.systemctl.listeningPorts());
    const status: ServiceStatus = {
      name,
      command: rec.command,
      cwd: rec.cwd,
      ports: rec.ports,
      envSecrets: rec.envSecrets,
      desired: rec.desired,
      state,
      stateLabel: STATE_LABELS[state],
      listening: rec.ports.filter((p) => ports.has(p)),
      notListening: rec.ports.filter((p) => !ports.has(p)),
      restarts: Number(show["NRestarts"] ?? 0) || 0,
      logFile: join(dir, "log"),
    };
    if (started?.at) status.startedAt = started.at;
    if (lastExit) status.lastExit = lastExit;
    const note = this.notes.get(name);
    if (note) status.note = note;
    return status;
  }

  private async settle(): Promise<void> {
    await new Promise((res) => setTimeout(res, this.deps.settleMs ?? 1500));
  }

  private async mustGet(name: string): Promise<ServiceRecord> {
    const rec = await this.deps.store.get(name);
    if (!rec) throw new ServiceError(`"${name}" は登録されていません。listServices で一覧を見られます`);
    return rec;
  }

  // ---- tool --------------------------------------------------------------------

  /** Module が起きたときに1回 */
  prepare(): Promise<void> {
    return this.serialize(() => this.reconcile());
  }

  start(input: Record<string, unknown>, onProgress?: (n: string) => void): Promise<ServiceStatus> {
    return this.serialize(async () => {
      const name = assertName(input.name);
      const def = normalizeDefinition(input, this.deps.projectRoot);
      await this.reconcile();
      const all = await this.deps.store.all();
      const existing = all[name];
      if (existing && !sameDefinition(existing, def)) {
        // **上書きしない**（決定・2026-09-27）——同じ Project の別の Thread が同じ名前を使いうる
        throw new ServiceError(
          `"${name}" はすでに別の中身で登録されています: ${JSON.stringify(definitionOf(existing))}。` +
            "変えるなら removeService してから登録し直すか、別の名前にしてください",
        );
      }
      for (const [other, rec] of Object.entries(all)) {
        if (other === name) continue;
        const shared = rec.ports.filter((p) => def.ports.includes(p));
        if (shared.length > 0) throw new ServiceError(`ポート ${shared.join(", ")} は "${other}" が登録済みです`);
      }
      const rec: ServiceRecord = existing
        ? { ...existing, desired: "running" }
        : { ...def, desired: "running", createdAt: new Date().toISOString() };

      const copies = await this.syncCopies(name, rec);
      try {
        if (copies.changed) await this.sc(["daemon-reload"], "systemd に定義を読み直させ");
        const active = parseShow((await this.deps.systemctl.run(["show", unitName(name), "-p", "ActiveState"])).stdout)["ActiveState"];
        if (active === "active" || active === "activating") {
          // 登録済みで動いている——起動するだけ（何もしない）
          await this.deps.store.put(name, rec);
          await this.sc(["enable", unitName(name)], `${name} を自動起動に入れ`);
          return this.status(name, rec);
        }
        await this.writeEnv(name, rec, onProgress);
      } catch (err) {
        // 初めての登録で鍵が引けなかったら、登録も写しも残さない
        if (!existing) await this.cleanup(name);
        throw err;
      }
      await this.deps.store.put(name, rec);
      this.notes.delete(name);
      await this.deps.systemctl.run(["reset-failed", unitName(name)]);
      await this.sc(["enable", unitName(name)], `${name} を自動起動に入れ`);
      const r = await this.deps.systemctl.run(["start", unitName(name)]);
      await this.settle();
      const status = await this.status(name, rec);
      if (r.code !== 0) status.note = `起動を頼んだとき systemd が断りました: ${(r.stderr || r.stdout).trim()}`;
      return status;
    });
  }

  stop(nameInput: unknown): Promise<ServiceStatus> {
    return this.serialize(async () => {
      const name = assertName(nameInput);
      await this.reconcile();
      const rec = { ...(await this.mustGet(name)), desired: "stopped" as const };
      await this.deps.store.put(name, rec);
      await this.sc(["disable", unitName(name)], `${name} を自動起動から外し`);
      await this.sc(["stop", unitName(name)], `${name} を止め`);
      return this.status(name, rec);
    });
  }

  restart(nameInput: unknown, onProgress?: (n: string) => void): Promise<ServiceStatus> {
    return this.serialize(async () => {
      const name = assertName(nameInput);
      await this.reconcile();
      const rec = { ...(await this.mustGet(name)), desired: "running" as const };
      await this.writeEnv(name, rec, onProgress);
      await this.deps.store.put(name, rec);
      this.notes.delete(name);
      await this.deps.systemctl.run(["reset-failed", unitName(name)]);
      await this.sc(["enable", unitName(name)], `${name} を自動起動に入れ`);
      const r = await this.deps.systemctl.run(["restart", unitName(name)]);
      await this.settle();
      const status = await this.status(name, rec);
      if (r.code !== 0) status.note = `起こし直しを頼んだとき systemd が断りました: ${(r.stderr || r.stdout).trim()}`;
      return status;
    });
  }

  remove(nameInput: unknown): Promise<{ name: string; removed: true }> {
    return this.serialize(async () => {
      const name = assertName(nameInput);
      await this.mustGet(name);
      await this.deps.systemctl.run(["disable", "--now", unitName(name)]);
      await this.cleanup(name);
      await this.deps.store.delete(name);
      this.notes.delete(name);
      return { name, removed: true as const };
    });
  }

  list(): Promise<ServiceStatus[]> {
    return this.serialize(async () => {
      await this.reconcile();
      const records = await this.deps.store.all();
      const listening = await this.deps.systemctl.listeningPorts();
      const out: ServiceStatus[] = [];
      for (const name of Object.keys(records).sort()) out.push(await this.status(name, records[name]!, listening));
      return out;
    });
  }

  logs(nameInput: unknown, tailInput?: unknown): Promise<{ name: string; logFile: string; lines: string[] }> {
    return this.serialize(async () => {
      const name = assertName(nameInput);
      await this.mustGet(name);
      const tail = typeof tailInput === "number" && Number.isInteger(tailInput) ? Math.min(Math.max(tailInput, 1), 2000) : 100;
      const logFile = join(serviceDir(this.deps.paths, name), "log");
      const current = await readFile(logFile, "utf8").catch(() => "");
      let lines = splitLines(current);
      if (lines.length < tail) {
        const older = await readFile(`${logFile}.1`, "utf8").catch(() => "");
        lines = [...splitLines(older), ...lines];
      }
      return { name, logFile, lines: lines.slice(-tail) };
    });
  }

  private async cleanup(name: string): Promise<void> {
    await rm(unitPath(this.deps.paths, name), { force: true });
    await rm(serviceDir(this.deps.paths, name), { recursive: true, force: true });
    await this.deps.systemctl.run(["daemon-reload"]);
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
