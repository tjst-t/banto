// **別のサーバの資源を見せる**（決定・2026-10-14、ユーザー「別サーバのリソース状況についても見えるようにして」。
// `docs/specs/v4-security.md` §1「資源の逼迫を見せる」の別のサーバの段）。
//
// 別のサーバは「機械まるごとがその Project の AI のもの」（§1「実行場所——別のサーバ」）なので、見せるのは機械の全体と、
// banto が起こしたもの（ユーザーの systemd の単位）の内訳。上限は付けない（向こうの持ち主の責任のまま）——見るだけ。
//
// 読み方：張ってある SSH の接続の上で、向こうの node に小さな読み取りを走らせ（`REMOTE_RESOURCE_PROBE`）、JSON で受け取る。
// **読むためだけには繋がない**（繋いでいない実行場所は「繋いでいません」と出す）。ここは受け取った JSON を形にするだけ。
//
// **`containers`**（追加・2026-10-20、Backlog #369。v4-security.md §1「他の仕組みとの関係」の資源の画面）：Module はその Project の
// コンテナの中で動くので、SSH ユーザーの systemd にはほとんど何も無い。VM の cgroup の根の、SSH ユーザーの区画のコンテナ
// （`lxc.payload.user-<uid>_banto-*`）も読み、中の単位を同じ内訳に Project の名前を添えて数える。上限に当たった数え
// （`memory.events` の oom_kill・`pids.events` の max）と上限（`memory.max`・`pids.max`）も持ち帰る——見張り（`container-pressure.ts`）が使う

import { parseMeminfo, parsePressure, type Pressure } from "./host-health.js";
import { busyReason, commandLabel, unitServiceName, waitingOf, type ConsumerGroup, type ConsumerGroupId, type Waiting } from "./resources.js";

/** 向こうで走らせる読み取り（node の `-` に標準入力で渡す）。値を変えるものは無い */
export const REMOTE_RESOURCE_PROBE = String.raw`
const fs = require("fs"), path = require("path"), os = require("os");
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return undefined; } };
const uid = process.getuid();
const base = "/sys/fs/cgroup/user.slice/user-" + uid + ".slice/user@" + uid + ".service";
const units = [];
const walk = (dir, depth) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name.endsWith(".slice") && depth < 6) walk(full, depth + 1);
    else if (e.name.endsWith(".service") || e.name.endsWith(".scope")) {
      const pid = (read(path.join(full, "cgroup.procs")) || "").split("\n").filter(Boolean)[0];
      const cmd = pid ? (read("/proc/" + pid + "/cmdline") || "").split("\0").filter(Boolean) : [];
      units.push({ unit: e.name, stat: read(path.join(full, "memory.stat")), cmd });
    }
  }
};
walk(base, 0);
// containers：SSH ユーザーの区画（incus-user の user-<uid>）の、banto のコンテナ。中の単位は .slice と user@<n>.service の下
const croot = "/sys/fs/cgroup", cprefix = "lxc.payload.user-" + uid + "_";
const containers = [];
let roots = [];
try { roots = fs.readdirSync(croot).filter((n) => n.startsWith(cprefix + "banto-")); } catch {}
for (const dir of roots) {
  const full = path.join(croot, dir), cunits = [];
  const cwalk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const f = path.join(d, e.name);
      if ((e.name.endsWith(".slice") || /^user@\d+\.service$/.test(e.name)) && depth < 8) cwalk(f, depth + 1);
      else if (e.name.endsWith(".service") || e.name.endsWith(".scope")) {
        const pid = (read(path.join(f, "cgroup.procs")) || "").split("\n").filter(Boolean)[0];
        const cmd = pid ? (read("/proc/" + pid + "/cmdline") || "").split("\0").filter(Boolean) : [];
        cunits.push({ unit: e.name, stat: read(path.join(f, "memory.stat")), cmd });
      }
    }
  };
  cwalk(full, 0);
  containers.push({
    name: dir.slice(cprefix.length),
    stat: read(path.join(full, "memory.stat")),
    events: read(path.join(full, "memory.events")),
    pidsEvents: read(path.join(full, "pids.events")),
    memoryMax: read(path.join(full, "memory.max")),
    pidsMax: read(path.join(full, "pids.max")),
    units: cunits,
  });
}
process.stdout.write(JSON.stringify({
  meminfo: read("/proc/meminfo"),
  pressure: { cpu: read("/proc/pressure/cpu"), memory: read("/proc/pressure/memory"), io: read("/proc/pressure/io") },
  cores: os.cpus().length,
  stat: (read("/proc/stat") || "").split("\n")[0],
  user: read(base + "/memory.stat"),
  units,
  containers,
}));
`;

/** 向こうの読み取りが返すもの */
export interface RemoteProbeRaw {
  meminfo?: string;
  pressure: { cpu?: string; memory?: string; io?: string };
  cores: number;
  /** /proc/stat の頭の行（cpu の合計） */
  stat?: string;
  /** banto の SSH ユーザーの systemd（user@<uid>.service）の memory.stat */
  user?: string;
  units: Array<{ unit: string; stat?: string; cmd: string[] }>;
  /** containers：SSH ユーザーの区画の banto のコンテナ（名前は Incus のコンテナの名前） */
  containers?: Array<{
    name: string;
    stat?: string;
    events?: string;
    pidsEvents?: string;
    memoryMax?: string;
    pidsMax?: string;
    units: Array<{ unit: string; stat?: string; cmd: string[] }>;
  }>;
}

/** containers のコンテナの、上限に当たった数えと上限（見張りが使う。読めなければ数えは無い） */
export interface RemoteContainerCounts {
  oomKills: number;
  pidsMax: number;
  /** 上限（memory.max のバイト数・pids.max）。`max`（無制限）・読めなければ無い */
  limits: { memoryBytes?: number; processes?: number };
}

/** 読み取りから、コンテナの名前 → 上限に当たった数え */
export function remoteContainerCounts(raw: RemoteProbeRaw | undefined): Map<string, RemoteContainerCounts> {
  const out = new Map<string, RemoteContainerCounts>();
  for (const c of raw?.containers ?? []) {
    const oom = /^oom_kill\s+(\d+)$/m.exec(c.events ?? "")?.[1];
    if (oom === undefined) continue;
    const limit = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);
    const memoryBytes = limit(c.memoryMax);
    const processes = limit(c.pidsMax);
    out.set(c.name, {
      oomKills: Number(oom),
      pidsMax: Number(/^max\s+(\d+)$/m.exec(c.pidsEvents ?? "")?.[1] ?? 0),
      limits: { ...(memoryBytes !== undefined ? { memoryBytes } : {}), ...(processes !== undefined ? { processes } : {}) },
    });
  }
  return out;
}

/** 1つの実行場所の読み取りの結果（`RemoteSshRuntime.readResources`） */
export interface RemoteProbe {
  runtime: string;
  /** 人に見せる宛先（user@host） */
  address: string;
  raw?: RemoteProbeRaw;
  /** 繋いでいない・読めなかった理由 */
  unavailable?: string;
}

export interface RemoteResources {
  runtime: string;
  address: string;
  /** この実行場所で動く Project（閉じていないもの） */
  projects: Array<{ projectId: string; name: string }>;
  unavailable?: string;
  busy: boolean;
  busyReason?: string;
  totalBytes?: number;
  availableBytes?: number;
  cores?: number;
  /** 直近の測りの間に使った CPU（コア数）。最初の1回は無い */
  cpuUsed?: number;
  waiting?: Waiting;
  /** banto が向こうで起こしたもの（SSH ユーザーの systemd）が使っている量 */
  bantoBytes?: number;
  /** banto 以外（向こうの機械のほかのもの・OS） */
  otherBytes?: number;
  groups: ConsumerGroup[];
}

function memOf(stat: string | undefined): { used: number; cache: number } | undefined {
  if (!stat) return undefined;
  const m = new Map<string, number>();
  for (const line of stat.split("\n")) {
    const [k, v] = line.trim().split(/\s+/);
    if (k && v !== undefined) m.set(k, Number(v));
  }
  if (!m.has("anon")) return undefined;
  return { used: (m.get("anon") ?? 0) + (m.get("shmem") ?? 0) + (m.get("kernel") ?? 0), cache: m.get("file") ?? 0 };
}

/** /proc/stat の cpu の行から、動いていた時間と全部の時間（jiffies） */
export function cpuJiffies(line: string | undefined): { busy: number; total: number } | undefined {
  const f = line?.trim().split(/\s+/);
  if (!f || f[0] !== "cpu") return undefined;
  const n = f.slice(1).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return undefined;
  const total = n.reduce((a, b) => a + b, 0);
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  return { busy: total - idle, total };
}

/** banto の包み役（起動役・Service のログの包み・待たない形の包み）。これが代表なら中身が分からないので出さない */
const WRAPPER = /(banto-launcher\.mjs|log-wrapper\.js|background-wrapper\.js)$/;

/**
 * 向こうの単位を内訳のどこに数えるか。Module は起動役が `banto-mod-<Module>-<Project の id>.service` で包む。Terminal の
 * tmux とその窓も仕事の側（コマンド）。ほかは手元のコンテナと同じ（`unitServiceName`）
 */
export function remoteUnitKind(unit: string): { group: ConsumerGroupId; name: string } | undefined {
  const mod = /^banto-mod-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.service$/.exec(unit);
  if (mod) return { group: "modules", name: mod[1]! };
  if (/^banto-terminal-.+\.scope$/.test(unit) || /^tmux-spawn-.+\.scope$/.test(unit)) return { group: "commands", name: "Terminal" };
  return unitServiceName(unit);
}

/** 単位の代表のコマンド（仕事の組の前置き `… banto-work <本物>` と sh -c を外す） */
function unitDetail(cmd: readonly string[]): string | undefined {
  if (cmd.length === 0) return undefined;
  const at = cmd.indexOf("banto-work");
  const real = at >= 0 ? cmd.slice(at + 1) : cmd;
  if (real.some((a) => WRAPPER.test(a))) return undefined;
  return real.length > 0 ? commandLabel(real) : undefined;
}

const ORDER: ConsumerGroupId[] = ["modules", "work", "commands", "services", "nested", "other"];
const LABEL: Record<ConsumerGroupId, string> = {
  modules: "Module",
  work: "AI の仕事",
  commands: "コマンド",
  services: "Service",
  nested: "入れ子のコンテナ",
  other: "その他",
};

/** 1回の読み取りを形にする。`prev` は前の回の CPU（最初は無い） */
export function remoteResourcesOf(
  probe: RemoteProbe,
  projects: Array<{ projectId: string; name: string; containerName?: string }>,
  prev: { busy: number; total: number } | undefined,
): { resources: RemoteResources; cpu?: { busy: number; total: number } } {
  const base = { runtime: probe.runtime, address: probe.address, projects: projects.map(({ projectId, name }) => ({ projectId, name })), groups: [] as ConsumerGroup[] };
  if (!probe.raw) return { resources: { ...base, busy: false, unavailable: probe.unavailable ?? "読めませんでした" } };
  const raw = probe.raw;
  const meminfo = parseMeminfo(raw.meminfo ?? "");
  const pressure: { cpu?: Pressure; memory?: Pressure; io?: Pressure } = {
    cpu: parsePressure(raw.pressure.cpu ?? ""),
    memory: parsePressure(raw.pressure.memory ?? ""),
    io: parsePressure(raw.pressure.io ?? ""),
  };
  const cpu = cpuJiffies(raw.stat);
  // jiffies は全コアの合計。全体の割合 × コア数 ＝ 使ったコア数
  const cpuUsed =
    cpu && prev && cpu.total > prev.total && cpu.busy >= prev.busy
      ? Math.round(((cpu.busy - prev.busy) / (cpu.total - prev.total)) * raw.cores * 100) / 100
      : undefined;

  const items: Array<{ group: ConsumerGroupId; name: string; detail?: string; bytes: number }> = [];
  const addUnits = (units: RemoteProbeRaw["units"], suffix: string) => {
    for (const u of units) {
      if (u.unit === "init.scope") continue;
      const mem = memOf(u.stat);
      if (!mem || mem.used < 1024 * 1024) continue;
      const kind = remoteUnitKind(u.unit);
      const detail = kind?.group === "modules" || kind?.group === "work" ? undefined : unitDetail(u.cmd);
      items.push({ group: kind?.group ?? "other", name: `${kind?.name ?? u.unit}${suffix}`, ...(detail ? { detail } : {}), bytes: mem.used });
    }
  };
  addUnits(raw.units, "");
  // containers：その実行場所の Project のコンテナの中の単位を、Project の名前を添えて数える（ほかの banto のコンテナは数えない）
  let containersBytes = 0;
  for (const c of raw.containers ?? []) {
    const project = projects.find((p) => p.containerName === c.name);
    if (!project) continue;
    containersBytes += memOf(c.stat)?.used ?? 0;
    addUnits(c.units, `（${project.name}）`);
  }
  const groups = ORDER.map((id) => ({
    id,
    label: LABEL[id],
    items: items
      .filter((i) => i.group === id)
      .map(({ name, detail, bytes }) => ({ name, ...(detail ? { detail } : {}), bytes }))
      .sort((a, b) => b.bytes - a.bytes),
  })).filter((g) => g.items.length > 0);

  const userBytes = memOf(raw.user)?.used;
  const banto = userBytes === undefined && containersBytes === 0 ? undefined : (userBytes ?? 0) + containersBytes;
  const used = meminfo.total !== undefined && meminfo.available !== undefined ? meminfo.total - meminfo.available : undefined;
  const reason = busyReason(pressure, undefined, meminfo.available);
  return {
    resources: {
      ...base,
      groups,
      busy: reason !== undefined,
      ...(reason ? { busyReason: reason } : {}),
      ...(meminfo.total !== undefined ? { totalBytes: meminfo.total } : {}),
      ...(meminfo.available !== undefined ? { availableBytes: meminfo.available } : {}),
      cores: raw.cores,
      ...(cpuUsed !== undefined ? { cpuUsed } : {}),
      waiting: waitingOf(pressure),
      ...(banto !== undefined ? { bantoBytes: banto } : {}),
      ...(used !== undefined && banto !== undefined ? { otherBytes: Math.max(0, used - banto) } : {}),
    },
    ...(cpu ? { cpu } : {}),
  };
}
