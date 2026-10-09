// **資源の逼迫を見せる**（決定・2026-10-08〜09、ユーザー。`docs/specs/v4-security.md` §1「資源の逼迫を見せる・共倒れさせない」の段1）。
//
// host が Project のコンテナの cgroup のファイルを**直接**読む（`incus exec` を通さない——incusd が詰まったとき見張りも
// 一緒に止まるため）。10 秒ごとに読んで、この機械と Project ごとの使い方・混み具合・何が使っているかを作る。
// 画面（設定の「資源」とサイドバーの印、v4-frontend.md §6.36）はこれを読む。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePressure, parseMeminfo, type Pressure } from "./host-health.js";
import type { Stall } from "./host-stall.js";

// ---------------------------------------------------------------------------------------------------------------
// 読み方（試験では差し替える）

export interface FsReader {
  /** 読めなければ undefined */
  read(path: string): string | undefined;
  /** 直下のフォルダの名前。読めなければ [] */
  dirs(path: string): string[];
}

export const realFs: FsReader = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  dirs(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
};

/** host から見たコンテナの cgroup の場所。区画が default なら区画の名前は付かない */
export function containerCgroupPath(incusProject: string, containerName: string, cgroupRoot = "/sys/fs/cgroup"): string {
  const prefix = incusProject && incusProject !== "default" ? `${incusProject}_` : "";
  return join(cgroupRoot, `lxc.payload.${prefix}${containerName}`);
}

function kv(text: string | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of (text ?? "").split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined && Number.isFinite(Number(v))) m.set(k, Number(v));
  }
  return m;
}

function num(text: string | undefined): number | undefined {
  const t = text?.trim();
  if (!t || t === "max") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** cgroup の「使っている」メモリ（anon＋shmem）と「戻せる」キャッシュ（file）。memory.stat が読めなければ memory.current を使っている側に */
function memoryOf(fs: FsReader, dir: string): { used: number; cache: number } | undefined {
  const stat = kv(fs.read(join(dir, "memory.stat")));
  if (stat.has("anon")) return { used: (stat.get("anon") ?? 0) + (stat.get("shmem") ?? 0), cache: stat.get("file") ?? 0 };
  const cur = num(fs.read(join(dir, "memory.current")));
  return cur === undefined ? undefined : { used: cur, cache: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// 何が使っているか

export type ConsumerGroupId = "modules" | "work" | "commands" | "services" | "nested" | "other";

export interface Consumer {
  name: string;
  detail?: string;
  bytes: number;
}

export interface ConsumerGroup {
  id: ConsumerGroupId;
  label: string;
  items: Consumer[];
}

const GROUP_LABEL: Record<ConsumerGroupId, string> = {
  modules: "Module",
  work: "AI の仕事",
  commands: "コマンド",
  services: "Service",
  nested: "入れ子のコンテナ",
  other: "その他",
};

interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  argv: string[];
  bytes: number;
}

function readProc(fs: FsReader, pid: number, procRoot: string): Proc | undefined {
  const stat = fs.read(join(procRoot, String(pid), "stat"));
  if (!stat) return undefined;
  // pid (comm) state ppid …——comm に空白や括弧が入りうるので最後の「)」で切る
  const close = stat.lastIndexOf(")");
  const comm = stat.slice(stat.indexOf("(") + 1, close);
  const rest = stat.slice(close + 2).split(" ");
  const ppid = Number(rest[1]);
  const argv = (fs.read(join(procRoot, String(pid), "cmdline")) ?? "").split("\0").filter((a) => a.length > 0);
  const status = kv((fs.read(join(procRoot, String(pid), "status")) ?? "").replace(/:/g, " ").replace(/ kB/g, ""));
  const bytes = ((status.get("RssAnon") ?? 0) + (status.get("RssShmem") ?? 0)) * 1024;
  return { pid, ppid, comm, argv, bytes };
}

const MODULE_SERVER = /\/modules\/([a-z0-9-]+)\/dist\/server\.js$/;

function moduleNameOf(p: Proc): string | undefined {
  for (const a of p.argv) {
    const m = MODULE_SERVER.exec(a);
    if (m) return m[1];
  }
  return undefined;
}

function agentNameOf(p: Proc): string | undefined {
  const line = p.argv.join(" ");
  if (/claude-agent-acp|@anthropic-ai\/claude-code|\/claude-code\//.test(line)) return "サブエージェント（Claude Code）";
  if (/\bopencode\b/.test(line)) return "サブエージェント（OpenCode）";
  return undefined;
}

/** 人に見せるコマンドの1行。`sh -c '…'` は中身を、長いものは頭だけ */
export function commandLabel(argv: readonly string[]): string {
  let a = [...argv];
  if (a.length >= 3 && /(^|\/)(ba|da)?sh$/.test(a[0]!) && a[1] === "-c") a = [a[2]!];
  const line = a.join(" ").replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * `.lxc`（`incus exec` で起こしたもの）のプロセスを、親子をたどって分類する。根は Module のサーバ・サブエージェント・
 * Module の子のコマンド。根を持たないものは「その他」
 */
export function classifyProcesses(procs: readonly Proc[]): Array<{ group: ConsumerGroupId; name: string; detail?: string; bytes: number }> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  type Root = { group: ConsumerGroupId; name: string; detail?: string; bytes: number };
  const roots = new Map<number, Root>();
  const rootOf = new Map<number, number | null>();

  const kindOf = (p: Proc): Root | undefined => {
    const agent = agentNameOf(p);
    if (agent) return { group: "work", name: agent, bytes: 0 };
    const mod = moduleNameOf(p);
    if (mod) return { group: "modules", name: mod, bytes: 0 };
    return undefined;
  };

  const resolve = (pid: number, seen = new Set<number>()): number | null => {
    if (rootOf.has(pid)) return rootOf.get(pid)!;
    const p = byPid.get(pid);
    if (!p || seen.has(pid)) return null;
    seen.add(pid);
    const own = kindOf(p);
    const parentRoot = byPid.has(p.ppid) ? resolve(p.ppid, seen) : null;
    let root: number | null;
    if (own && own.group === "work") {
      // サブエージェントの中の子（アダプタ→CLI）は、外側のサブエージェントにまとめる
      const outer = parentRoot !== null ? roots.get(parentRoot) : undefined;
      if (outer && outer.group === "work") root = parentRoot;
      else {
        root = pid;
        roots.set(pid, own);
      }
    } else if (own) {
      root = pid;
      roots.set(pid, own);
    } else if (parentRoot !== null && roots.get(parentRoot)!.group === "modules") {
      // Module の子で、サブエージェントでも Module でもない——コマンド（Shell の sh -c・Factory のテスト等）
      root = pid;
      roots.set(pid, { group: "commands", name: commandLabel(p.argv.length > 0 ? p.argv : [p.comm]), bytes: 0 });
    } else {
      root = parentRoot;
    }
    rootOf.set(pid, root);
    return root;
  };

  let other = 0;
  for (const p of procs) {
    const r = resolve(p.pid);
    if (r === null) other += p.bytes;
    else roots.get(r)!.bytes += p.bytes;
  }
  const out = [...roots.values()];
  if (other > 0) out.push({ group: "other", name: "その他のプロセス", bytes: other });
  return out;
}

function unitServiceName(unit: string): { group: ConsumerGroupId; name: string } | undefined {
  const shell = /^banto-shell-(.+)\.service$/.exec(unit);
  if (shell) return { group: "commands", name: `待たないコマンド ${shell[1]}` };
  const svc = /^banto-(.+)\.service$/.exec(unit);
  if (svc) return { group: "services", name: svc[1]! };
  return undefined;
}

/** 単位の中の代表のコマンド（sh -c があればその中身） */
function unitCommand(fs: FsReader, dir: string, procRoot: string): string | undefined {
  const pids = (fs.read(join(dir, "cgroup.procs")) ?? "").split("\n").map(Number).filter((n) => n > 0);
  let fallback: string | undefined;
  for (const pid of pids) {
    const p = readProc(fs, pid, procRoot);
    if (!p || p.argv.length === 0) continue;
    if (/(^|\/)(ba|da)?sh$/.test(p.argv[0]!) && p.argv[1] === "-c") return commandLabel(p.argv);
    fallback ??= commandLabel(p.argv);
  }
  return fallback;
}

/** コンテナの中の内訳。`root` はコンテナの cgroup のフォルダ */
export function readConsumers(fs: FsReader, root: string, procRoot = "/proc"): ConsumerGroup[] {
  const items: Array<{ group: ConsumerGroupId; name: string; detail?: string; bytes: number }> = [];

  // incus exec で起こしたもの（Module・サブエージェント・コマンド）
  const lxcPids = (fs.read(join(root, ".lxc", "cgroup.procs")) ?? "").split("\n").map(Number).filter((n) => n > 0);
  const procs = lxcPids.map((pid) => readProc(fs, pid, procRoot)).filter((p): p is Proc => !!p);
  items.push(...classifyProcesses(procs));

  // systemd のユーザー単位（Service・Shell の待たない形）
  for (const userSlice of fs.dirs(join(root, "user.slice"))) {
    for (const userSvc of fs.dirs(join(root, "user.slice", userSlice))) {
      if (!userSvc.startsWith("user@")) continue;
      const appSlice = join(root, "user.slice", userSlice, userSvc, "app.slice");
      for (const unit of fs.dirs(appSlice)) {
        const kind = unitServiceName(unit);
        const mem = memoryOf(fs, join(appSlice, unit));
        if (!mem || mem.used === 0) continue;
        if (kind) {
          const detail = unitCommand(fs, join(appSlice, unit), procRoot);
          items.push({ group: kind.group, name: kind.name, ...(detail ? { detail } : {}), bytes: mem.used });
        } else items.push({ group: "other", name: unit, bytes: mem.used });
      }
    }
  }

  // 入れ子のコンテナ・system.slice
  for (const child of fs.dirs(root)) {
    if (child.startsWith("lxc.payload.")) {
      const mem = memoryOf(fs, join(root, child));
      if (mem && mem.used > 0) items.push({ group: "nested", name: child.slice("lxc.payload.".length), bytes: mem.used });
    } else if (child === "system.slice") {
      const mem = memoryOf(fs, join(root, child));
      if (mem && mem.used > 0) items.push({ group: "other", name: "システムのサービス（Incus・Docker 等）", bytes: mem.used });
    }
  }

  const order: ConsumerGroupId[] = ["modules", "work", "commands", "services", "nested", "other"];
  return order
    .map((id) => ({
      id,
      label: GROUP_LABEL[id],
      items: items
        .filter((i) => i.group === id)
        .map(({ name, detail, bytes }) => ({ name, ...(detail ? { detail } : {}), bytes }))
        .sort((a, b) => b.bytes - a.bytes),
    }))
    .filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// 混み具合

export interface Waiting {
  /** CPU・メモリ・ディスクの空きを待たされた時間（直近10秒、%）。some */
  cpu: number;
  memory: number;
  io: number;
}

function waitingOf(p: { cpu?: Pressure; memory?: Pressure; io?: Pressure }): Waiting {
  return { cpu: p.cpu?.some?.avg10 ?? 0, memory: p.memory?.some?.avg10 ?? 0, io: p.io?.some?.avg10 ?? 0 };
}

/**
 * **混んでいるかは待たされている時間で決める**（仮の区切り、段3で実物を見て決め直す）。使っている量だけでは決めない
 * ——ビルド中はキャッシュで多く見える。CPU の some は並列の仕事があればいつも高いので full で見る
 */
export const BUSY = {
  memorySomeAvg10: 10,
  cpuFullAvg10: 10,
  usedRatio: 0.9,
  hostMemAvailableBytes: 1024 ** 3,
};

function busyReason(
  pressure: { cpu?: Pressure; memory?: Pressure },
  used?: { used: number; limit?: number },
  memAvailable?: number,
): string | undefined {
  const reasons: string[] = [];
  if (used?.limit && used.used / used.limit >= BUSY.usedRatio) reasons.push(`メモリが上限の ${Math.round((used.used / used.limit) * 100)}% に達しています`);
  if (memAvailable !== undefined && memAvailable < BUSY.hostMemAvailableBytes)
    reasons.push(`空いているメモリが ${(memAvailable / 1024 ** 3).toFixed(1)} GB しかありません`);
  const mem = pressure.memory?.some?.avg10 ?? 0;
  if (mem >= BUSY.memorySomeAvg10) reasons.push(`メモリの空きを待つ時間が ${Math.round(mem)}%`);
  const cpu = pressure.cpu?.full?.avg10 ?? 0;
  if (cpu >= BUSY.cpuFullAvg10) reasons.push(`CPU の空きを待って全部が止まっている時間が ${Math.round(cpu)}%`);
  return reasons.length > 0 ? reasons.join("、") : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// まとめ

export interface ProjectResources {
  projectId: string;
  name: string;
  containerName: string;
  busy: boolean;
  busyReason?: string;
  usedBytes: number;
  cacheBytes: number;
  limitBytes?: number;
  cpuLimit?: number;
  /** 直近の測りの間に使った CPU（コア数）。最初の1回は無い */
  cpuUsed?: number;
  waiting: Waiting;
  processes: number;
  processLimit?: number;
  groups: ConsumerGroup[];
  hits: Array<{ at: string; what: string }>;
}

export interface HostResources {
  busy: boolean;
  busyReason?: string;
  totalBytes?: number;
  availableBytes?: number;
  cores: number;
  waiting: Waiting;
  memory: Array<{ id: string; label: string; bytes: number; projectId?: string }>;
  stalls: Array<{ at: string; seconds: number }>;
}

export interface ResourcesSnapshot {
  measuredAt: string;
  host: HostResources;
  projects: ProjectResources[];
}

export interface ResourceTarget {
  containerName: string;
  /** 無ければ banto 全体用のコンテナ */
  projectId?: string;
  name: string;
}

export interface ResourceWatchOptions {
  fs?: FsReader;
  cgroupRoot?: string;
  procRoot?: string;
  /** いまの区画（`incus project get-current`）。読めなければ undefined（区画の名前を付けずに探す） */
  incusProject: () => Promise<string | undefined>;
  cores: number;
  /** banto 本体の使っているメモリ（バイト） */
  selfBytes: () => number;
  stalls: () => readonly Stall[];
  now?: () => number;
}

interface Prev {
  at: number;
  cpuUsec?: number;
  oomKills?: number;
  pidsMax?: number;
}

export class ResourceWatch {
  private latest?: ResourcesSnapshot;
  private readonly prev = new Map<string, Prev>();
  private readonly hits = new Map<string, Array<{ at: string; what: string }>>();
  private readonly fs: FsReader;
  private readonly cgroupRoot: string;
  private readonly procRoot: string;
  private readonly now: () => number;

  constructor(private readonly opts: ResourceWatchOptions) {
    this.fs = opts.fs ?? realFs;
    this.cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
    this.procRoot = opts.procRoot ?? "/proc";
    this.now = opts.now ?? Date.now;
  }

  snapshot(): ResourcesSnapshot | undefined {
    return this.latest;
  }

  /** 混んでいる Project とこの機械（サイドバーの印に使う） */
  busySummary(): { projects: Array<{ projectId: string; reason?: string }>; host?: { reason?: string } } {
    const s = this.latest;
    if (!s) return { projects: [] };
    return {
      projects: s.projects.filter((p) => p.busy).map((p) => ({ projectId: p.projectId, ...(p.busyReason ? { reason: p.busyReason } : {}) })),
      ...(s.host.busy ? { host: { ...(s.host.busyReason ? { reason: s.host.busyReason } : {}) } } : {}),
    };
  }

  /** 消したコンテナの前の値を忘れる */
  forget(containerName: string): void {
    this.prev.delete(containerName);
    this.hits.delete(containerName);
  }

  /** 1回測る */
  async tick(targets: readonly ResourceTarget[]): Promise<ResourcesSnapshot> {
    const now = this.now();
    const incusProject = (await this.opts.incusProject().catch(() => undefined)) ?? "";
    const projects: ProjectResources[] = [];
    const containerMemory: HostResources["memory"] = [];

    for (const t of targets) {
      const root = containerCgroupPath(incusProject, t.containerName, this.cgroupRoot);
      const mem = memoryOf(this.fs, root);
      if (!mem) continue; // 動いていない・読めない
      const limit = num(this.fs.read(join(root, "memory.max")));
      const events = kv(this.fs.read(join(root, "memory.events")));
      const pidsEvents = kv(this.fs.read(join(root, "pids.events")));
      const cpuStat = kv(this.fs.read(join(root, "cpu.stat")));
      const cpuMax = (this.fs.read(join(root, "cpu.max")) ?? "").trim().split(/\s+/);
      const quota = num(cpuMax[0]);
      const period = num(cpuMax[1]);
      const pressure = {
        cpu: parsePressure(this.fs.read(join(root, "cpu.pressure")) ?? ""),
        memory: parsePressure(this.fs.read(join(root, "memory.pressure")) ?? ""),
        io: parsePressure(this.fs.read(join(root, "io.pressure")) ?? ""),
      };

      const before = this.prev.get(t.containerName);
      const cpuUsec = cpuStat.get("usage_usec");
      const cpuUsed =
        before?.cpuUsec !== undefined && cpuUsec !== undefined && cpuUsec >= before.cpuUsec && now > before.at
          ? (cpuUsec - before.cpuUsec) / 1000 / (now - before.at)
          : undefined;
      const oomKills = events.get("oom_kill");
      const pidsMax = pidsEvents.get("max");
      const hits = this.hits.get(t.containerName) ?? [];
      const grew = (cur: number | undefined, prev: number | undefined) =>
        cur === undefined || prev === undefined ? 0 : cur >= prev ? cur - prev : cur;
      const at = new Date(now).toISOString();
      const oom = grew(oomKills, before?.oomKills);
      if (oom > 0) hits.unshift({ at, what: `メモリの上限に当たり、プロセスが ${oom} 個止められました` });
      const pids = grew(pidsMax, before?.pidsMax);
      if (pids > 0) hits.unshift({ at, what: `プロセス数の上限に当たり、新しいプロセスを起こせなかったことが ${pids} 回ありました` });
      this.hits.set(t.containerName, hits.slice(0, 10));
      this.prev.set(t.containerName, { at: now, ...(cpuUsec !== undefined ? { cpuUsec } : {}), ...(oomKills !== undefined ? { oomKills } : {}), ...(pidsMax !== undefined ? { pidsMax } : {}) });

      containerMemory.push({
        id: `container:${t.containerName}`,
        label: t.name,
        bytes: mem.used,
        ...(t.projectId ? { projectId: t.projectId } : {}),
      });
      if (!t.projectId) continue;
      const reason = busyReason(pressure, { used: mem.used, ...(limit !== undefined ? { limit } : {}) });
      projects.push({
        projectId: t.projectId,
        name: t.name,
        containerName: t.containerName,
        busy: reason !== undefined,
        ...(reason ? { busyReason: reason } : {}),
        usedBytes: mem.used,
        cacheBytes: mem.cache,
        ...(limit !== undefined ? { limitBytes: limit } : {}),
        ...(quota !== undefined && period ? { cpuLimit: Math.round((quota / period) * 10) / 10 } : {}),
        ...(cpuUsed !== undefined ? { cpuUsed: Math.round(cpuUsed * 100) / 100 } : {}),
        waiting: waitingOf(pressure),
        processes: num(this.fs.read(join(root, "pids.current"))) ?? 0,
        ...(num(this.fs.read(join(root, "pids.max"))) !== undefined ? { processLimit: num(this.fs.read(join(root, "pids.max")))! } : {}),
        groups: readConsumers(this.fs, root, this.procRoot),
        hits: this.hits.get(t.containerName) ?? [],
      });
    }

    // この機械
    const meminfo = parseMeminfo(this.fs.read(join(this.procRoot, "meminfo")) ?? "");
    const hostPressure = {
      cpu: parsePressure(this.fs.read(join(this.procRoot, "pressure", "cpu")) ?? ""),
      memory: parsePressure(this.fs.read(join(this.procRoot, "pressure", "memory")) ?? ""),
      io: parsePressure(this.fs.read(join(this.procRoot, "pressure", "io")) ?? ""),
    };
    const memory: HostResources["memory"] = [...containerMemory];
    memory.push({ id: "banto", label: "banto 本体", bytes: this.opts.selfBytes() });
    const incus = memoryOf(this.fs, join(this.cgroupRoot, "system.slice", "incus.service"));
    if (incus) memory.push({ id: "incus", label: "Incus", bytes: incus.used });
    if (meminfo.total !== undefined && meminfo.available !== undefined) {
      const used = meminfo.total - meminfo.available;
      const known = memory.reduce((a, m) => a + m.bytes, 0);
      if (used > known) memory.push({ id: "other", label: "その他（OS・Caddy 等）", bytes: used - known });
    }
    const hostReason = busyReason(hostPressure, undefined, meminfo.available);
    const stallHorizon = now - 10 * 60_000;
    this.latest = {
      measuredAt: new Date(now).toISOString(),
      host: {
        busy: hostReason !== undefined,
        ...(hostReason ? { busyReason: hostReason } : {}),
        ...(meminfo.total !== undefined ? { totalBytes: meminfo.total } : {}),
        ...(meminfo.available !== undefined ? { availableBytes: meminfo.available } : {}),
        cores: this.opts.cores,
        waiting: waitingOf(hostPressure),
        memory,
        stalls: this.opts
          .stalls()
          .filter((s) => s.endedAt >= stallHorizon && s.ms >= 1000)
          .map((s) => ({ at: new Date(s.endedAt - s.ms).toISOString(), seconds: Math.round(s.ms / 100) / 10 })),
      },
      projects: projects.sort((a, b) => Number(b.busy) - Number(a.busy) || b.usedBytes - a.usedBytes),
    };
    return this.latest;
  }

  /** 上限に当たった数え（受信箱で知らせる見張り `container-pressure.ts` が使う）。読めなければ undefined */
  async readEvents(containerName: string): Promise<{ oomKills: number; pidsMax: number } | undefined> {
    const incusProject = (await this.opts.incusProject().catch(() => undefined)) ?? "";
    const root = containerCgroupPath(incusProject, containerName, this.cgroupRoot);
    const events = kv(this.fs.read(join(root, "memory.events")));
    if (!events.has("oom_kill")) return undefined;
    return { oomKills: events.get("oom_kill")!, pidsMax: kv(this.fs.read(join(root, "pids.events"))).get("max") ?? 0 };
  }
}
