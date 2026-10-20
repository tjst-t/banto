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
}

function fakeVm(over: Partial<FakeVm> = {}): FakeVm {
  return {
    project: { restricted: "true", "restricted.devices.proxy": "allow" },
    files: new Map(),
    sudo: true,
    sudoCalls: [],
    incusCalls: [],
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
    return fail(`偽の VM は sudo ${args.join(" ")} を知らない`);
  };
  return {
    user: "banto",
    uid: 1001,
    gid: 1001,
    run: async (args, opts) => {
      const [cmd, ...rest] = args;
      if (cmd === "/usr/bin/sudo" && rest[0] === "-n") return root(rest.slice(1), opts?.input);
      if (cmd === "incus") {
        vm.incusCalls.push(rest);
        if (rest[0] === "query" && rest[1] === "/1.0/projects/user-1001") return ok(JSON.stringify({ config: vm.project }));
      }
      return fail(`偽の VM は ${args.join(" ")} を知らない`, 127);
    },
  };
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
}

function harness(opts: { vm?: Partial<FakeVm>; runtime?: Partial<RemoteRuntime>; projects?: Harness["projects"] } = {}): Harness {
  const vm = fakeVm(opts.vm);
  const runtimes = new Map([["lab", runtimeOf(opts.runtime)]]);
  const settings = new Map<string, ProjectVirtualization>();
  const projects = opts.projects ?? [];
  const virt = new ContainersVirtualization({
    runtime: (name) => runtimes.get(name),
    withVm: (_name, fn) => fn(accessOf(vm)),
    recordAllowed: async (name, allowed) => {
      const r = runtimes.get(name)!;
      runtimes.set(name, { ...r, virtualization: allowed });
    },
    projectsOn: (rt) => projects.filter((p) => p.runtime === rt).map(({ id, name }) => ({ id, name })),
    settingsOf: (id) => settings.get(id) ?? NO_VIRTUALIZATION,
  });
  return { virt, vm, runtimes, settings, projects };
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
