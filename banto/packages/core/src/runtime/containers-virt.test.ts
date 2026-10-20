import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncusResult } from "@banto/container";
import type { VmAccess } from "./containers-host.js";
import {
  ContainersVirtualization,
  HUGEPAGES_SYSCTL_FILE,
  MODULES_LOAD_FILE,
  NO_VIRTUALIZATION,
  readProjectVirtualization,
  VIRT_KEYS,
  type ProjectVirtualization,
} from "./containers-virt.js";
import { RemoteRuntimeError } from "./remote-runtimes.js";
import type { RemoteRuntime } from "./remote-store.js";

const ok = (stdout = ""): IncusResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): IncusResult => ({ code, stdout: "", stderr });

/** 偽の VM：SSH ユーザー banto（uid 1001）の区画と、root のファイル。打たれた sudo を記録する */
interface FakeVm {
  project: Record<string, string>;
  files: Map<string, string>;
  sudo: boolean;
  sudoCalls: string[][];
  /** VM のユーザーとして打った incus（sudo でないもの） */
  incusCalls: string[][];
  /** 読み込んだモジュール */
  modules: Set<string>;
  /** 区画のコンテナ（名前 → 様子） */
  containers: Map<string, { status: string; config: Record<string, string>; devices: Record<string, Record<string, string>> }>;
  /** サーバのメモリ（KiB） */
  memTotalKiB: number;
  /** vm.nr_hugepages と、確保できる上限（断片化） */
  nrHugepages: number;
  hugepagesCap: number;
  /** コンテナごとの hugetlb.2MB.current（バイト） */
  hugetlbCurrent: Map<string, number>;
}

function fakeVm(over: Partial<FakeVm> = {}): FakeVm {
  return {
    project: { restricted: "true", "restricted.devices.proxy": "allow" },
    files: new Map(),
    sudo: true,
    sudoCalls: [],
    incusCalls: [],
    modules: new Set(),
    containers: new Map(),
    memTotalKiB: 16 * 1024 * 1024,
    nrHugepages: 0,
    hugepagesCap: Infinity,
    hugetlbCurrent: new Map(),
    ...over,
  };
}

function accessOf(vm: FakeVm): VmAccess {
  const root = (args: string[], input?: string): IncusResult => {
    if (!vm.sudo) return fail("sudo: a password is required");
    vm.sudoCalls.push(args);
    const [cmd, ...rest] = args;
    if (cmd === "incus" && rest[0] === "project" && rest[1] === "set" && rest[2] === "user-1001") {
      for (const kv of rest.slice(3)) {
        const [k, v] = kv.split("=");
        vm.project[k!] = v!;
      }
      return ok();
    }
    if (cmd === "incus" && rest[0] === "project" && rest[1] === "unset" && rest[2] === "user-1001") {
      if (vm.project[rest[3]!] === undefined) return fail(`Error: Key "${rest[3]}" is not set`);
      delete vm.project[rest[3]!];
      return ok();
    }
    if (cmd === "rm" && rest[0] === "-f") {
      for (const f of rest.slice(1)) vm.files.delete(f);
      return ok();
    }
    if (cmd === "tee") {
      vm.files.set(rest[0]!, input ?? "");
      return ok();
    }
    if (cmd === "sysctl" && rest[0] === "-w" && /^vm\.nr_hugepages=\d+$/.test(rest[1]!)) {
      vm.nrHugepages = Number(rest[1]!.split("=")[1]);
      return ok();
    }
    if (cmd === "modprobe" && rest.length === 1) {
      vm.modules.add(rest[0]!);
      return ok();
    }
    return fail(`偽の VM は sudo ${args.join(" ")} を知らない`);
  };
  return {
    user: "banto",
    uid: 1001,
    gid: 1001,
    run: async (args, opts) => {
      const [cmd, ...rest] = args;
      if (cmd === "/usr/bin/sudo" && rest[0] === "-n") return root(rest.slice(1), opts?.input);
      if (cmd === "cat" && rest[0] === "/proc/meminfo") {
        return ok(`MemTotal:       ${vm.memTotalKiB} kB\nHugePages_Total:    ${Math.min(vm.nrHugepages, vm.hugepagesCap)}\nHugepagesize:       2048 kB\n`);
      }
      if (cmd === "nproc") return ok("8\n");
      if (cmd === "incus") {
        vm.incusCalls.push(rest);
        if (rest[0] === "query" && rest[1] === "/1.0/projects/user-1001") return ok(JSON.stringify({ config: vm.project }));
        return incusAsUser(vm, rest);
      }
      return fail(`偽の VM は ${args.join(" ")} を知らない`, 127);
    },
  };
}

/** VM のユーザーとしての incus（コンテナの様子・装置・設定） */
function incusAsUser(vm: FakeVm, args: string[]): IncusResult {
  if (args[0] === "project" && args[1] === "get-current") return ok("user-1001\n");
  const m = /^\/1\.0\/instances\/([^?]+)\?project=user-1001$/.exec(args[args[0] === "query" && args[1] === "-X" ? 3 : 1] ?? "");
  if (args[0] === "query" && m) {
    const c = vm.containers.get(m[1]!);
    if (!c) return fail("Error: Instance not found");
    if (args[1] === "-X" && args[2] === "PATCH") {
      Object.assign(c.devices, (JSON.parse(args[args.indexOf("--data") + 1]!) as { devices: Record<string, Record<string, string>> }).devices);
      return ok();
    }
    return ok(JSON.stringify(c));
  }
  if (args[0] === "exec" && args.at(-1) === "/sys/fs/cgroup/hugetlb.2MB.current") return ok(`${vm.hugetlbCurrent.get(args[1]!) ?? 0}\n`);
  if (args[0] === "config" && (args[1] === "set" || args[1] === "unset")) {
    const c = vm.containers.get(args[2]!);
    if (!c) return fail("Error: Instance not found");
    for (const kv of args.slice(3)) {
      if (args[1] === "unset") delete c.config[kv];
      else c.config[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
    }
    return ok();
  }
  if (args[0] === "config" && args[1] === "device" && args[2] === "remove") {
    const c = vm.containers.get(args[3]!);
    if (!c?.devices[args[4]!]) return fail("Error: Device doesn't exist");
    delete c.devices[args[4]!];
    return ok();
  }
  return fail(`偽の VM は incus ${args.join(" ")} を知らない`, 127);
}

const runtimeOf = (over: Partial<RemoteRuntime> = {}): RemoteRuntime => ({
  name: "lab",
  host: "lab.example",
  user: "banto",
  port: 22,
  identity: "lab-key",
  dataRoot: "~/.local/share/banto-remote",
  mode: "containers",
  hostKey: { type: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:x", confirmedAt: "2026-10-20T00:00:00Z" },
  checks: [],
  checkedAt: "2026-10-20T00:00:00Z",
  registeredAt: "2026-10-20T00:00:00Z",
  ...over,
});

interface Harness {
  virt: ContainersVirtualization;
  vm: FakeVm;
  runtimes: Map<string, RemoteRuntime>;
  settings: Map<string, ProjectVirtualization>;
  projects: Array<{ id: string; name: string; runtime: string }>;
  nesting: Set<string>;
}

function harness(opts: { vm?: Partial<FakeVm>; runtime?: Partial<RemoteRuntime>; projects?: Harness["projects"] } = {}): Harness {
  const vm = fakeVm(opts.vm);
  const runtimes = new Map([["lab", runtimeOf(opts.runtime)]]);
  const settings = new Map<string, ProjectVirtualization>();
  const projects = opts.projects ?? [];
  const nesting = new Set<string>();
  const virt = new ContainersVirtualization({
    runtime: (name) => runtimes.get(name),
    withVm: (_name, fn) => fn(accessOf(vm)),
    recordAllowed: async (name, allowed) => {
      const r = runtimes.get(name)!;
      runtimes.set(name, { ...r, virtualization: allowed });
    },
    projectsOn: (rt) => projects.filter((p) => p.runtime === rt).map(({ id, name }) => ({ id, name })),
    settingsOf: (id) => settings.get(id) ?? NO_VIRTUALIZATION,
    saveSettings: async (id, v) => {
      settings.set(id, v);
    },
    project: (id) => projects.find((p) => p.id === id),
    nestingOf: (id) => nesting.has(id),
  });
  return { virt, vm, runtimes, settings, projects, nesting };
}

test("仮想化の実験を許す：区画に unix-char を sudo -n で足して記録する（項目ごとの固定のコマンド）", async () => {
  const h = harness();
  const result = await h.virt.setAllowed("lab", true);
  assert.deepEqual(h.vm.sudoCalls, [["incus", "project", "set", "user-1001", "restricted.devices.unix-char=allow"]]);
  assert.equal(h.vm.project["restricted.devices.unix-char"], "allow");
  assert.equal(h.runtimes.get("lab")!.virtualization, true);
  assert.equal(result.ran.length, 1);
  // sh -c の台本を使わない
  assert.ok(!h.vm.sudoCalls.flat().some((a) => a === "sh" || a === "-c"));
});

test("止める：区画の項目を unset し、modules-load と sysctl のファイルを消す。足していない項目は触らない", async () => {
  const h = harness({ runtime: { virtualization: true } });
  h.vm.project["restricted.devices.unix-char"] = "allow";
  h.vm.files.set(MODULES_LOAD_FILE, "vhost_net\n");
  h.vm.files.set(HUGEPAGES_SYSCTL_FILE, "vm.nr_hugepages = 64\n");
  await h.virt.setAllowed("lab", false);
  assert.deepEqual(h.vm.sudoCalls, [
    ["incus", "project", "unset", "user-1001", "restricted.devices.unix-char"],
    ["rm", "-f", MODULES_LOAD_FILE, HUGEPAGES_SYSCTL_FILE],
  ]);
  assert.equal(h.vm.project["restricted.devices.unix-char"], undefined);
  assert.equal(h.vm.files.size, 0);
  assert.equal(h.runtimes.get("lab")!.virtualization, false);

  // もう一度押しても、無い項目は unset しない（何度流しても同じ）
  h.vm.sudoCalls.length = 0;
  await h.virt.setAllowed("lab", false);
  assert.deepEqual(h.vm.sudoCalls, [["rm", "-f", MODULES_LOAD_FILE, HUGEPAGES_SYSCTL_FILE]]);
});

test("止める：まだ使っている Project（閉じたもの・眠っているものも）があれば名指しして断り、何も打たない", async () => {
  const h = harness({
    runtime: { virtualization: true },
    projects: [
      { id: "p-aaa", name: "実験A", runtime: "remote:lab" },
      { id: "p-bbb", name: "閉じた実験", runtime: "remote:lab" },
      { id: "p-ccc", name: "使っていない", runtime: "remote:lab" },
      { id: "p-ddd", name: "ほかの実行場所", runtime: "remote:other" },
    ],
  });
  h.settings.set("p-aaa", { kvm: true, modules: [], hugepages: 0 });
  h.settings.set("p-bbb", { kvm: false, modules: [], hugepages: 16 });
  h.settings.set("p-ddd", { kvm: true, modules: [], hugepages: 0 });
  await assert.rejects(h.virt.setAllowed("lab", false), (err: unknown) => {
    assert.ok(err instanceof RemoteRuntimeError);
    assert.equal(err.status, 409);
    assert.match(err.message, /「実験A」（\/dev\/kvm を見せる）/);
    assert.match(err.message, /「閉じた実験」（hugepages 16 個）/);
    assert.doesNotMatch(err.message, /使っていない|ほかの実行場所/);
    return true;
  });
  assert.deepEqual(h.vm.sudoCalls, []);
  assert.equal(h.runtimes.get("lab")!.virtualization, true);
});

test("machine の実行場所・無い実行場所には出さない。sudo -n が通らなければ打ったものの言葉を添えて断り、記録しない", async () => {
  await assert.rejects(harness({ runtime: { mode: "machine" } }).virt.setAllowed("lab", true), /containers だけ/);
  await assert.rejects(harness().virt.setAllowed("nope", true), /ありません/);
  const h = harness({ vm: { sudo: false } });
  await assert.rejects(h.virt.setAllowed("lab", true), (err: unknown) => {
    assert.ok(err instanceof RemoteRuntimeError);
    assert.match(err.message, /sudo incus project set user-1001 restricted.devices.unix-char=allow が失敗しました.*password is required/);
    return true;
  });
  assert.equal(h.runtimes.get("lab")!.virtualization, undefined);
});

test("Project の設定は Project の層から読む（壊れた値・無い値は使っていないとして読む）", () => {
  const layer = new Map<string, unknown>([
    [VIRT_KEYS.kvm, true],
    [VIRT_KEYS.modules, " br_netfilter  dummy "],
    [VIRT_KEYS.hugepages, 32],
  ]);
  assert.deepEqual(readProjectVirtualization((k) => layer.get(k)), { kvm: true, modules: ["br_netfilter", "dummy"], hugepages: 32 });
  assert.deepEqual(readProjectVirtualization(() => undefined), NO_VIRTUALIZATION);
  assert.deepEqual(readProjectVirtualization((k) => (k === VIRT_KEYS.hugepages ? 1.5 : k === VIRT_KEYS.kvm ? "yes" : undefined)), NO_VIRTUALIZATION);
});

const LAB_PROJECTS = [
  // 名前に記号・空白・パスの字を入れる——コマンドに名前が入っていないことを見る
  { id: "p-aaa", name: "実験 A; rm -rf /", runtime: "remote:lab" },
  { id: "p-bbb", name: "../閉じた", runtime: "remote:lab" },
  { id: "p-ccc", name: "ほかの実行場所", runtime: "remote:other" },
];

const runningContainer = () => ({ status: "Running", config: {}, devices: {} as Record<string, Record<string, string>> });

test("/dev/kvm を見せる：vhost_net と足したモジュールを読み、modules-load を全 Project の和で書き、動いているコンテナに装置を足す", async () => {
  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS });
  h.vm.containers.set("banto-p-aaa", runningContainer());
  // 閉じた Project も和に入る。ほかの実行場所の Project は入れない
  h.settings.set("p-bbb", { kvm: true, modules: ["dummy"], hugepages: 0 });
  h.settings.set("p-ccc", { kvm: true, modules: ["wireguard"], hugepages: 0 });
  const result = await h.virt.setKvm("p-aaa", { enabled: true, modules: ["br-netfilter", "vhost-net", "8021q", "8021q"] });
  assert.deepEqual(result.modules, ["br_netfilter", "8021q"], "- を _ に揃え、重ねず、vhost_net は除く");
  assert.deepEqual(h.vm.sudoCalls.slice(0, 3), [
    ["modprobe", "vhost_net"],
    ["modprobe", "br_netfilter"],
    ["modprobe", "8021q"],
  ]);
  assert.deepEqual(h.vm.sudoCalls[3], ["tee", MODULES_LOAD_FILE]);
  const lines = h.vm.files.get(MODULES_LOAD_FILE)!.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(lines, ["8021q", "br_netfilter", "dummy", "vhost_net"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /br_netfilter/);
  // 装置は固定の2つ、起こし直さない
  const c = h.vm.containers.get("banto-p-aaa")!;
  assert.deepEqual(c.devices["kvm"], { type: "unix-char", path: "/dev/kvm", mode: "0666" });
  assert.deepEqual(c.devices["vhost-net"], { type: "unix-char", path: "/dev/vhost-net", mode: "0666" });
  assert.equal(c.status, "Running");
  assert.deepEqual(h.settings.get("p-aaa"), { kvm: true, modules: ["br_netfilter", "8021q"], hugepages: 0 });
  // 「中で Docker を使う」は変えない（返すだけ）
  assert.equal(result.nesting, false);
  assert.equal(h.nesting.size, 0);
  // 識別子は Project id だけ（名前はどのコマンドにも入らない）。sh -c の台本は使わない
  const everything = JSON.stringify([...h.vm.sudoCalls, ...h.vm.incusCalls]);
  assert.doesNotMatch(everything, /実験|閉じた|rm -rf/);
  assert.ok(!h.vm.sudoCalls.flat().some((a) => a === "sh" || a === "-c"));
});

test("/dev/kvm を外す：先に装置を外し、modules-load を残りの和で書き直す（読み込んだモジュールは抜かない）。誰も見せなくなれば消す", async () => {
  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS });
  h.vm.containers.set("banto-p-aaa", runningContainer());
  await h.virt.setKvm("p-aaa", { enabled: true, modules: ["dummy"] });
  h.settings.set("p-bbb", { kvm: true, modules: [], hugepages: 0 });
  h.vm.sudoCalls.length = 0;

  await h.virt.setKvm("p-aaa", { enabled: false });
  assert.equal(h.vm.containers.get("banto-p-aaa")!.devices["kvm"], undefined);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.devices["vhost-net"], undefined);
  assert.ok(!h.vm.sudoCalls.some((c) => c[0] === "modprobe"), "外すときにモジュールを触った");
  assert.ok(!h.vm.sudoCalls.some((c) => c[0] === "rmmod" || c.includes("-r")), "読み込んだモジュールを抜いた");
  assert.deepEqual(h.vm.files.get(MODULES_LOAD_FILE)!.split("\n").filter((l) => l && !l.startsWith("#")), ["vhost_net"]);
  // 名前の一覧は残す（もう一度入れたときに戻る）
  assert.deepEqual(h.settings.get("p-aaa"), { kvm: false, modules: ["dummy"], hugepages: 0 });

  h.settings.set("p-bbb", NO_VIRTUALIZATION);
  h.vm.sudoCalls.length = 0;
  await h.virt.setKvm("p-aaa", { enabled: false });
  assert.deepEqual(h.vm.sudoCalls, [["rm", "-f", MODULES_LOAD_FILE]]);
  assert.equal(h.vm.files.has(MODULES_LOAD_FILE), false);
});

test("/dev/kvm を見せる：実行場所が許していない・containers でない・名前の形が違うなら断り、何も打たない。コンテナがまだ無ければ設定だけ", async () => {
  const notAllowed = harness({ projects: LAB_PROJECTS });
  await assert.rejects(notAllowed.virt.setKvm("p-aaa", { enabled: true }), (err: unknown) => {
    assert.ok(err instanceof RemoteRuntimeError);
    assert.equal(err.status, 409);
    assert.match(err.message, /許していません/);
    return true;
  });
  assert.deepEqual(notAllowed.vm.sudoCalls, []);
  assert.equal(notAllowed.virt.describe("p-aaa").available, false);

  const machine = harness({ runtime: { mode: "machine", virtualization: true }, projects: LAB_PROJECTS });
  await assert.rejects(machine.virt.setKvm("p-aaa", { enabled: true }), /containers/);
  const hostProject = harness({ runtime: { virtualization: true }, projects: [{ id: "p-host", name: "この機械", runtime: "host-container" }] });
  await assert.rejects(hostProject.virt.setKvm("p-host", { enabled: true }), /containers/);

  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS });
  for (const bad of [["Dummy"], ["a b"], ["x;y"], ["../x"], "dummy", [1]]) {
    await assert.rejects(h.virt.setKvm("p-aaa", { enabled: true, modules: bad }), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 400);
  }
  assert.deepEqual(h.vm.sudoCalls, []);
  assert.equal(h.virt.describe("p-aaa").available, true);

  // コンテナがまだ無い（次に作るときに付く）
  await h.virt.setKvm("p-aaa", { enabled: true });
  assert.equal(h.settings.get("p-aaa")!.kvm, true);
  assert.deepEqual(h.virt.containerSpecOf("lab", "p-aaa"), { kvm: true, hugepagesBytes: 0 });
  assert.equal(notAllowed.virt.containerSpecOf("lab", "p-aaa"), null, "許していない実行場所のコンテナには付けない（付いていれば外す）");
});

test("modprobe が落ちたら設定を変えず、装置も足さない", async () => {
  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS });
  h.vm.containers.set("banto-p-aaa", runningContainer());
  const access = accessOf(h.vm);
  const virt = new ContainersVirtualization({
    runtime: (name) => h.runtimes.get(name),
    withVm: (_name, fn) =>
      fn({ ...access, run: async (args, opts) => (args[2] === "modprobe" && args[3] === "nosuch" ? fail("modprobe: FATAL: Module nosuch not found") : access.run(args, opts)) }),
    recordAllowed: async () => undefined,
    projectsOn: () => LAB_PROJECTS.slice(0, 2),
    settingsOf: (id) => h.settings.get(id) ?? NO_VIRTUALIZATION,
    saveSettings: async (id, v) => {
      h.settings.set(id, v);
    },
    project: (id) => LAB_PROJECTS.find((p) => p.id === id),
    nestingOf: () => false,
  });
  await assert.rejects(virt.setKvm("p-aaa", { enabled: true, modules: ["nosuch"] }), /Module nosuch not found/);
  assert.equal(h.settings.get("p-aaa"), undefined);
  assert.deepEqual(h.vm.containers.get("banto-p-aaa")!.devices, {});
  assert.equal(h.vm.files.has(MODULES_LOAD_FILE), false);
});

test("許す・止める：その実行場所の全コンテナ（閉じた Project のものも）に hugepages の上限 0 を書き、止めるときに外す", async () => {
  const h = harness({ projects: LAB_PROJECTS });
  h.vm.containers.set("banto-p-aaa", runningContainer());
  h.vm.containers.set("banto-p-bbb", { status: "Stopped", config: {}, devices: {} });
  h.vm.containers.set("banto-p-ccc", runningContainer());
  await h.virt.setAllowed("lab", true);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.hugepages.2MB"], "0");
  assert.equal(h.vm.containers.get("banto-p-bbb")!.config["limits.hugepages.2MB"], "0");
  assert.equal(h.vm.containers.get("banto-p-ccc")!.config["limits.hugepages.2MB"], undefined, "ほかの実行場所のコンテナに書いた");
  await h.virt.setAllowed("lab", false);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.hugepages.2MB"], undefined);
  assert.equal(h.vm.containers.get("banto-p-bbb")!.config["limits.hugepages.2MB"], undefined);
});

test("hugepages：合計（閉じた Project も）を sysctl と sysctl.d に書き、上限を N×2MiB にし、同じ実行場所の動いているコンテナのメモリの上限を合計を引いて引き直す", async () => {
  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS });
  h.vm.containers.set("banto-p-aaa", runningContainer());
  h.vm.containers.set("banto-p-bbb", { status: "Stopped", config: {}, devices: {} });
  h.vm.containers.set("banto-p-ccc", runningContainer());
  h.settings.set("p-bbb", { kvm: false, modules: [], hugepages: 100 });
  h.settings.set("p-ccc", { kvm: false, modules: [], hugepages: 999 });
  const result = await h.virt.setHugepages("p-aaa", 412);
  assert.equal(result.total, 512);
  assert.equal(result.allocated, 512);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(h.vm.sudoCalls, [
    ["sysctl", "-w", "vm.nr_hugepages=512"],
    ["tee", HUGEPAGES_SYSCTL_FILE],
  ]);
  assert.match(h.vm.files.get(HUGEPAGES_SYSCTL_FILE)!, /^vm\.nr_hugepages = 512$/m);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.hugepages.2MB"], "824MiB");
  assert.deepEqual(h.settings.get("p-aaa"), { kvm: false, modules: [], hugepages: 412 });
  // メモリの上限：16GiB − 512×2MiB（1GiB）− 残す 4GiB = 11GiB。動いているものだけ、ほかの実行場所には触らない
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.memory"], "11264MiB");
  assert.equal(h.vm.containers.get("banto-p-bbb")!.config["limits.memory"], undefined, "止まっているコンテナ（次に用意するときに付く）");
  assert.equal(h.vm.containers.get("banto-p-ccc")!.config["limits.memory"], undefined);
  assert.equal(h.virt.hugepagesReservedBytes("lab"), 512 * 2 * 1024 ** 2);
  // 識別子は Project id だけ
  assert.doesNotMatch(JSON.stringify([...h.vm.sudoCalls, ...h.vm.incusCalls]), /実験|閉じた|rm -rf/);

  // 0 に戻す：合計が 100 に、sysctl.d も書き直す。誰も持たなければ消す
  await h.virt.setHugepages("p-aaa", 0);
  assert.equal(h.vm.nrHugepages, 100);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.hugepages.2MB"], "0");
  h.settings.set("p-bbb", NO_VIRTUALIZATION);
  h.vm.sudoCalls.length = 0;
  await h.virt.setHugepages("p-aaa", 0);
  assert.deepEqual(h.vm.sudoCalls, [
    ["sysctl", "-w", "vm.nr_hugepages=0"],
    ["rm", "-f", HUGEPAGES_SYSCTL_FILE],
  ]);
  assert.equal(h.vm.files.has(HUGEPAGES_SYSCTL_FILE), false);
});

test("hugepages：合計がサーバのメモリの半分を越える・使っているのに減らす・許していない・数がおかしい、は断って何も打たない", async () => {
  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS });
  h.vm.containers.set("banto-p-aaa", runningContainer());
  h.settings.set("p-bbb", { kvm: false, modules: [], hugepages: 2048 });
  // 16GiB の半分＝8GiB＝4096 個。閉じた Project の 2048 個と合わせて越える
  await assert.rejects(h.virt.setHugepages("p-aaa", 2049), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 409 && /半分を越えます/.test(err.message));
  assert.deepEqual(h.vm.sudoCalls, []);
  await h.virt.setHugepages("p-aaa", 2048);

  // 使っている（hugetlb の使用中がある）なら減らせない。増やすのはよい
  h.vm.hugetlbCurrent.set("banto-p-aaa", 64 * 2 * 1024 ** 2);
  h.vm.sudoCalls.length = 0;
  await assert.rejects(h.virt.setHugepages("p-aaa", 10), (err: unknown) => err instanceof RemoteRuntimeError && /使っています（64 個）.*止めてから/.test(err.message));
  assert.deepEqual(h.vm.sudoCalls, []);
  assert.equal(h.settings.get("p-aaa")!.hugepages, 2048);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.hugepages.2MB"], "4096MiB");
  // 止まっていれば減らせる
  h.vm.containers.get("banto-p-aaa")!.status = "Stopped";
  await h.virt.setHugepages("p-aaa", 10);
  assert.equal(h.vm.containers.get("banto-p-aaa")!.config["limits.hugepages.2MB"], "20MiB");

  for (const bad of [-1, 1.5, "3", null]) {
    await assert.rejects(h.virt.setHugepages("p-aaa", bad), (err: unknown) => err instanceof RemoteRuntimeError && err.status === 400);
  }
  const notAllowed = harness({ projects: LAB_PROJECTS });
  await assert.rejects(notAllowed.virt.setHugepages("p-aaa", 1), /許していません/);
  assert.deepEqual(notAllowed.vm.sudoCalls, []);
  assert.equal(notAllowed.virt.hugepagesReservedBytes("lab"), 0);
});

test("hugepages：確保できた数が足りなければ、その数を言う（設定は残す）", async () => {
  const h = harness({ runtime: { virtualization: true }, projects: LAB_PROJECTS, vm: { hugepagesCap: 40 } });
  const result = await h.virt.setHugepages("p-aaa", 64);
  assert.equal(result.allocated, 40);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /64 個頼みましたが、確保できたのは 40 個/);
  assert.equal(h.settings.get("p-aaa")!.hugepages, 64);
});
