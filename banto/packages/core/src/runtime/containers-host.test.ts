import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncusResult } from "@banto/container";
import {
  evaluateContainersHost,
  idRangesInclude,
  inspectContainersHost,
  prepareContainersHost,
  probeContainersPrerequisites,
  reachableProject,
  sameGroups,
  zabblyKeyOk,
  type VmAccess,
} from "./containers-host.js";

/** 偽の VM：SSH ユーザー banto（uid 1000・gid 1001）から見た Incus と sudo。打たれた sudo を記録する */
interface FakeVm {
  installed: boolean;
  version: string;
  inGroup: boolean;
  admin: boolean;
  project?: Record<string, string>;
  subuid: string;
  subgid: string;
  pools: Set<string>;
  sudo: boolean;
  linger: boolean;
  fs: string;
  availGiB: number;
  sudoCalls: string[][];
  restarts: number;
  /** ユーザーの systemd が起きたときの補助グループ（undefined なら動いていない） */
  managerGroups?: string[];
  /** Incus を入れられる OS（Ubuntu 24.04） */
  os?: VmAccess["os"];
  /** Incus を初期化してある（default のプロファイルに root のディスク） */
  initialized: boolean;
  /** root で書いたファイル（tee） */
  files: Map<string, string>;
  /** incus-user の口が起きていない（incus グループでも繋がらない。`systemctl enable --now incus-user.socket` で起きる） */
  socketDown?: boolean;
  /** apt で入れた道具 */
  tools: Set<string>;
  /** `/sys/module/kvm_intel/parameters/nested` の中身（無ければ KVM のモジュールが読まれていない） */
  nested?: string;
}

function fakeVm(over: Partial<FakeVm> = {}): FakeVm {
  return {
    installed: true,
    version: "6.0.6",
    inGroup: false,
    admin: false,
    subuid: "banto:100000:65536\n",
    subgid: "banto:100000:65536\n",
    pools: new Set(),
    sudo: true,
    linger: false,
    fs: "btrfs",
    availGiB: 80,
    sudoCalls: [],
    restarts: 0,
    initialized: true,
    files: new Map(),
    tools: new Set(),
    ...over,
  };
}

/** 補助のグループの名前（主のグループ banto は除く） */
const groupNames = (vm: FakeVm) => [...(vm.inGroup ? ["incus"] : []), ...(vm.admin ? ["incus-admin"] : [])];
const gidOf = (name: string) => (name === "incus" ? "990" : name === "incus-admin" ? "991" : "9");

const ok = (stdout = ""): IncusResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1): IncusResult => ({ code, stdout: "", stderr });

function accessOf(vm: FakeVm): VmAccess {
  const incus = (args: string[], asRoot: boolean): IncusResult => {
    if (!vm.installed) return fail("sh: exec: incus: not found", 127);
    if (!asRoot && !vm.inGroup && !vm.admin) return fail("Error: You don't have the needed permissions to talk to the incus daemon");
    if (!asRoot && !vm.admin && vm.socketDown) return fail("Error: Failed to connect to the user socket");
    const [cmd, ...rest] = args;
    if (cmd === "query" && rest[0] === "/1.0") {
      // incus-user は最初に繋いだときに区画を作る（制限つき・idmap はそのユーザーだけ）。区画を指定しない問い合わせでは、制限つきの
      // 証明書でも environment.project は default（本物の Incus と同じ——2026-10-20 に banto-ct-test で実測）
      if (!vm.admin && !vm.project) vm.project = { restricted: "true", "restricted.idmap.uid": "1000", "restricted.idmap.gid": "1001" };
      return ok(JSON.stringify({ environment: { server_version: vm.version, project: "default" } }));
    }
    if (cmd === "query" && rest[0] === "/1.0/projects") {
      return ok(JSON.stringify(vm.admin ? ["/1.0/projects/default", "/1.0/projects/user-1000"] : vm.project ? ["/1.0/projects/user-1000"] : []));
    }
    if (cmd === "query" && rest[0] === "/1.0/projects/user-1000") return vm.project ? ok(JSON.stringify({ config: vm.project })) : fail("not found");
    if (cmd === "query" && rest[0] === "/1.0/storage-pools/banto") return vm.pools.has("banto") ? ok("{}") : fail("not found");
    if (!asRoot) return fail(`偽の VM は incus ${args.join(" ")} を知らない`);
    if (cmd === "storage" && rest[0] === "show") return vm.pools.has(rest[1]!) ? ok() : fail("not found");
    if (cmd === "storage" && rest[0] === "create") {
      if (vm.pools.has(rest[1]!)) return fail("already exists");
      vm.pools.add(rest[1]!);
      return ok();
    }
    if (cmd === "project" && rest[0] === "set") {
      if (!vm.project) return fail("project not found");
      for (const kv of rest.slice(2)) {
        const [k, v] = kv.split("=");
        vm.project[k!] = v!;
      }
      return ok();
    }
    if (cmd === "project" && rest[0] === "unset") {
      if (!vm.project) return fail("project not found");
      delete vm.project[rest[2]!];
      return ok();
    }
    if (cmd === "admin" && rest[0] === "waitready") return ok();
    if (cmd === "profile" && rest.join(" ") === "device get default root pool") return vm.initialized ? ok("default\n") : fail("Device doesn't exist");
    if (cmd === "admin" && rest.join(" ") === "init --minimal") {
      vm.initialized = true;
      return ok();
    }
    return fail(`偽の VM は incus ${args.join(" ")} を知らない`);
  };
  const root = (args: string[], input?: string): IncusResult => {
    if (!vm.sudo) return fail("sudo: a password is required");
    if (args[0] !== "true") vm.sudoCalls.push(args);
    const [cmd, ...rest] = args;
    if (cmd === "true") return ok();
    if (cmd === "incus") return incus(rest, true);
    if (cmd === "usermod" && rest[0] === "-aG" && rest[1] === "incus") {
      vm.inGroup = true;
      return ok();
    }
    if (cmd === "usermod" && rest[0] === "--add-subuids") {
      vm.subuid += `root:${rest[1]!.split("-")[0]}:1\n`;
      return ok();
    }
    if (cmd === "usermod" && rest[0] === "--add-subgids") {
      vm.subgid += `root:${rest[1]!.split("-")[0]}:1\n`;
      return ok();
    }
    if (cmd === "systemctl" && rest.join(" ") === "restart incus.service") {
      vm.restarts++;
      return ok();
    }
    if (cmd === "loginctl" && rest[0] === "enable-linger") {
      vm.linger = true;
      return ok();
    }
    if (cmd === "gpasswd" && rest[0] === "-d" && rest[2] === "incus-admin") {
      vm.admin = false;
      return ok();
    }
    if (cmd === "systemctl" && rest.join(" ") === "restart user@1000.service") {
      vm.managerGroups = groupNames(vm);
      return ok();
    }
    if (cmd === "systemctl" && rest.join(" ") === "enable --now incus-user.socket") {
      vm.socketDown = false;
      return ok();
    }
    if (cmd === "tee") {
      vm.files.set(rest[0]!, input ?? "");
      return ok();
    }
    if (cmd === "install" || cmd === "chmod") return ok();
    if (cmd === "env" && rest.includes("update")) return ok();
    if (cmd === "env" && rest.includes("install") && !rest.includes("incus")) {
      for (const t of rest.slice(rest.indexOf("--no-install-recommends") + 1)) vm.tools.add(t);
      return ok();
    }
    if (cmd === "env" && rest.includes("install") && rest.includes("incus")) {
      const sources = [...vm.files.keys()].find((f) => f.startsWith("/etc/apt/sources.list.d/zabbly-incus-"));
      if (!sources || vm.files.get("/etc/apt/keyrings/zabbly.asc") !== "偽の Zabbly の鍵") return fail("E: Unable to locate package incus");
      vm.installed = true;
      vm.initialized = false;
      vm.version = sources.includes("stable") ? "6.19.0" : "6.0.6";
      return ok();
    }
    return fail(`偽の VM は sudo ${args.join(" ")} を知らない`);
  };
  return {
    user: "banto",
    uid: 1000,
    gid: 1001,
    ...(vm.os ? { os: vm.os } : {}),
    run: async (args, opts) => {
      const [cmd, ...rest] = args;
      if (cmd === "incus") return incus(rest, false);
      if (cmd === "/usr/bin/sudo" && rest[0] === "-n") return root(rest.slice(1), opts?.input);
      if (cmd === "id" && rest[0] === "-nG") return ok(`banto ${groupNames(vm).join(" ")}\n`);
      if (cmd === "id" && rest[0] === "-G") return ok(`1001 ${groupNames(vm).map(gidOf).join(" ")}\n`);
      if (cmd === "systemctl" && rest[0] === "show") return ok(vm.managerGroups ? "4242\n" : "0\n");
      if (cmd === "cat" && rest[0] === "/proc/4242/status") return ok(`Name:\tsystemd\nGroups:\t1001 ${vm.managerGroups!.map(gidOf).join(" ")}\n`);
      if (cmd === "dpkg-query") return vm.installed ? ok(vm.version) : fail("no packages found matching incus", 1);
      if (cmd === "cat" && rest[0] === "/etc/subuid") return ok(vm.subuid);
      if (cmd === "cat" && rest[0] === "/etc/subgid") return ok(vm.subgid);
      if (cmd === "test") return vm.linger ? ok() : fail("", 1);
      if (cmd === "findmnt") return ok(`${vm.fs}\n`);
      if (cmd === "cat" && rest[0] === "/sys/module/kvm_intel/parameters/nested") {
        return vm.nested !== undefined ? { code: 1, stdout: vm.nested, stderr: "cat: /sys/module/kvm_amd/parameters/nested: No such file or directory" } : fail("No such file or directory", 1);
      }
      if (cmd === "df") return ok(`Avail\n  ${vm.availGiB}G\n`);
      return fail(`偽の VM は ${args.join(" ")} を知らない`, 127);
    },
  };
}

const statuses = (checks: Array<{ id: string; status: string }>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

test("まっさらな VM（sudo -n が通る）：確かめは何も変えず、足りないものは「登録のときに整える」注意", async () => {
  const vm = fakeVm();
  const access = accessOf(vm);
  const checks = await evaluateContainersHost(await inspectContainersHost(access), access, "check");
  assert.deepEqual(statuses(checks), {
    incus: "ok",
    "incus-project": "warn",
    "user-manager": "ok",
    "incus-proxy": "warn",
    "incus-idmap": "warn",
    "incus-pool": "warn",
    linger: "warn",
    "nested-kvm": "ok",
    sudo: "ok",
  });
  // Incus に繋がらないうちは版が分からない——区画の項目で名指しする
  assert.match(checks.find((c) => c.id === "incus-project")!.detail!, /Incus に繋がりません/);
  assert.match(checks.find((c) => c.id === "incus-project")!.fix!, /^sudo usermod -aG incus banto$/);
  // 見るための sudo（置き場が root から見えるか）だけで、何も変えていない
  assert.deepEqual(vm.sudoCalls, [
    ["incus", "storage", "show", "banto"],
    ["incus", "admin", "waitready", "--timeout", "120"],
    ["incus", "profile", "device", "get", "default", "root", "pool"],
  ]);
  assert.equal(vm.inGroup, false);
});

test("準備：足りないものを sudo -n で順に整え、2回目は何も打たない（何度流しても同じ）", async () => {
  const vm = fakeVm();
  const access = accessOf(vm);
  const first = await prepareContainersHost(access);
  assert.deepEqual(first.ran, [
    ["usermod", "-aG", "incus", "banto"],
    ["incus", "project", "set", "user-1000", "restricted.devices.proxy=allow"],
    ["usermod", "--add-subuids", "1000-1000", "root"],
    ["usermod", "--add-subgids", "1001-1001", "root"],
    ["systemctl", "restart", "incus.service"],
    ["incus", "admin", "waitready", "--timeout", "120"],
    ["incus", "storage", "create", "banto", "btrfs", "source=/var/lib/incus/storage-pools/banto"],
    ["loginctl", "enable-linger", "banto"],
  ]);
  assert.equal(vm.restarts, 1);
  const after = await evaluateContainersHost(first.state, access, "verify");
  assert.deepEqual(new Set(after.map((c) => c.status)), new Set(["ok"]));
  assert.equal(after.find((c) => c.id === "incus")!.label, "Incus 6.0.6 以降（6.0.6）");

  const snapshot = JSON.stringify({ ...vm, pools: [...vm.pools], sudoCalls: [] });
  const second = await prepareContainersHost(access);
  assert.deepEqual(second.ran, []);
  assert.deepEqual(second.state, first.state);
  assert.equal(JSON.stringify({ ...vm, pools: [...vm.pools], sudoCalls: [] }), snapshot);
  assert.equal(vm.restarts, 1, "2回目で Incus を起こし直した");
});

test("sudo -n が通らない：何も打たず、足りないものと打つコマンドを名指しして断る", async () => {
  const vm = fakeVm({ sudo: false });
  const access = accessOf(vm);
  const { state, ran } = await prepareContainersHost(access);
  assert.deepEqual(ran, []);
  assert.equal(vm.inGroup, false);
  const checks = await evaluateContainersHost(state, access, "check");
  assert.deepEqual(statuses(checks), {
    incus: "ok",
    "incus-project": "fail",
    "user-manager": "ok",
    "incus-proxy": "fail",
    "incus-idmap": "fail",
    "incus-pool": "fail",
    linger: "fail",
    "nested-kvm": "ok",
    sudo: "fail",
  });
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  assert.match(byId["linger"]!.fix!, /^sudo loginctl enable-linger banto$/);
  assert.match(byId["incus-idmap"]!.fix!, /sudo usermod --add-subuids 1000-1000 root\nsudo usermod --add-subgids 1001-1001 root\nsudo systemctl restart incus.service/);
  assert.match(byId["incus-pool"]!.fix!, /sudo incus storage create banto btrfs/);
  assert.match(byId["sudo"]!.detail!, /banto は sudo -n できません/);
});

test("人が先に整えてあれば sudo -n が無くても使える（sudo は注意）。繋ぐたびの確かめは崩れたものを断る", async () => {
  const vm = fakeVm({
    sudo: false,
    inGroup: true,
    linger: true,
    subuid: "root:1000:1\n",
    subgid: "root:1001:1\n",
    pools: new Set(["banto"]),
    project: { restricted: "true", "restricted.idmap.uid": "1000", "restricted.idmap.gid": "1001", "restricted.devices.proxy": "allow" },
  });
  const access = accessOf(vm);
  const checks = await evaluateContainersHost(await inspectContainersHost(access), access, "verify");
  assert.deepEqual(statuses(checks), {
    incus: "ok",
    "incus-project": "ok",
    "user-manager": "ok",
    "incus-proxy": "ok",
    "incus-idmap": "ok",
    "incus-pool": "ok",
    linger: "ok",
    "nested-kvm": "ok",
    sudo: "warn",
  });
  // 人が区画の設定を戻した——繋ぐたびの確かめ（sudo しない）は断り、「確かめ直す」で整えると言う
  delete vm.project!["restricted.devices.proxy"];
  const broken = await evaluateContainersHost(await inspectContainersHost(access), access, "verify");
  const proxy = broken.find((c) => c.id === "incus-proxy")!;
  assert.equal(proxy.status, "fail");
  assert.match(proxy.detail!, /確かめ直す/);
  assert.equal(proxy.fix, "sudo incus project set user-1000 restricted.devices.proxy=allow");
  assert.equal(broken.find((c) => c.id === "sudo")!.status, "fail");
});

test("Incus が無い・古い：banto が入れられない OS（Ubuntu 24.04・26.04 でない）なら断り、準備は何もしない", async () => {
  for (const vm of [
    fakeVm({ installed: false }),
    fakeVm({ version: "6.0.5", inGroup: true }),
    fakeVm({ installed: false, os: { apt: true, id: "debian", version: "12", codename: "bookworm", arch: "amd64" } }),
  ]) {
    const access = accessOf(vm);
    const { state, ran } = await prepareContainersHost(access);
    assert.deepEqual(ran, []);
    const checks = await evaluateContainersHost(state, access, "check");
    assert.equal(checks.find((c) => c.id === "incus")!.status, "fail");
    assert.match(checks.find((c) => c.id === "incus")!.detail!, /Ubuntu 24\.04・26\.04/);
  }
});

test("Incus が無い（Ubuntu 24.04）：確かめは「登録のときに入れる」注意、準備で Zabbly の lts-6.0 から入れてから続きを整える", async () => {
  const os = { apt: true, id: "ubuntu", version: "24.04", codename: "noble", arch: "amd64" };
  const vm = fakeVm({ installed: false, os });
  const access = accessOf(vm);
  const before = await evaluateContainersHost(await inspectContainersHost(access), access, "check");
  // 後ろの項目は「Incus を入れたあとに整えます」の注意（断らない——「準備して登録する」が押せる）
  assert.deepEqual(new Set(before.filter((c) => c.id !== "sudo" && c.id !== "user-manager" && c.id !== "nested-kvm").map((c) => c.status)), new Set(["warn"]));
  assert.match(before.find((c) => c.id === "incus")!.detail!, /Incus が入っていません。登録するときに banto/);
  assert.match(before.find((c) => c.id === "incus")!.fix!, /sudo tee \/etc\/apt\/keyrings\/zabbly\.asc（Zabbly の鍵。banto の host で指紋 4EFC590696CB15B87C73A3AD82CC8797C838DCFD を確かめたもの）/);
  assert.match(before.find((c) => c.id === "incus")!.fix!, /sudo apt-get install --no-install-recommends incus btrfs-progs$/);
  assert.match(before.find((c) => c.id === "incus-pool")!.detail!, /Incus を入れたあとに整えます/);
  assert.ok(before.every((c) => c.status === "ok" || c.autoFix));

  const zabblyKey = async () => "偽の Zabbly の鍵";
  const { state, ran } = await prepareContainersHost(access, { mayRestartUserManager: true, zabblyKey });
  // 台本は使わず項目ごとのコマンドで。鍵は host が確かめたものを tee で置く。入れたあと初期化する
  assert.deepEqual(ran.slice(0, 8).map((a) => (a[0] === "env" ? a.slice(-1) : a)), [
    ["install", "-d", "-m", "0755", "/etc/apt/keyrings"],
    ["tee", "/etc/apt/keyrings/zabbly.asc"],
    ["chmod", "0644", "/etc/apt/keyrings/zabbly.asc"],
    ["tee", "/etc/apt/sources.list.d/zabbly-incus-lts-6.0.sources"],
    ["-q"],
    ["btrfs-progs"],
    ["incus", "admin", "init", "--minimal"],
    ["usermod", "-aG", "incus", "banto"],
  ]);
  assert.equal(
    vm.files.get("/etc/apt/sources.list.d/zabbly-incus-lts-6.0.sources"),
    "Enabled: yes\nTypes: deb\nURIs: https://pkgs.zabbly.com/incus/lts-6.0\nSuites: noble\nComponents: main\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/zabbly.asc\n",
  );
  const after = await evaluateContainersHost(state, access, "verify");
  assert.deepEqual(new Set(after.map((c) => c.status)), new Set(["ok"]));

  // 26.04 は stable（lts-6.0 には resolute が無い）
  const vm26 = fakeVm({ installed: false, os: { ...os, version: "26.04", codename: "resolute" } });
  const r26 = await prepareContainersHost(accessOf(vm26), { mayRestartUserManager: true, zabblyKey });
  assert.deepEqual(r26.ran[3], ["tee", "/etc/apt/sources.list.d/zabbly-incus-stable.sources"]);
  assert.equal(vm26.version, "6.19.0");
});

test("incus-admin に入っているユーザー：確かめは「外します」の注意、準備で incus-admin から外し、ユーザーの systemd を起こし直す", async () => {
  // banto-ct-test と同じ形（incus-admin と incus の両方、ユーザーの systemd は incus-admin つきで動いている）
  const vm = fakeVm({ admin: true, inGroup: true, managerGroups: ["incus", "incus-admin"] });
  const access = accessOf(vm);
  const check = await evaluateContainersHost(await inspectContainersHost(access), access, "check");
  const project = check.find((c) => c.id === "incus-project")!;
  assert.equal(project.status, "warn");
  assert.match(project.detail!, /incus-admin グループに入っていて、制限の無い管理の口に繋がります。incus-admin から外します/);
  assert.equal(project.fix, "sudo gpasswd -d banto incus-admin");
  assert.equal(check.find((c) => c.id === "user-manager")!.status, "ok");

  const { state, ran } = await prepareContainersHost(access);
  assert.deepEqual(ran.slice(0, 2), [
    ["gpasswd", "-d", "banto", "incus-admin"],
    ["systemctl", "restart", "user@1000.service"],
  ]);
  assert.deepEqual(vm.managerGroups, ["incus"]);
  const after = await evaluateContainersHost(state, access, "verify");
  assert.deepEqual(new Set(after.map((c) => c.status)), new Set(["ok"]));
});

test("Project があってユーザーの systemd を起こし直せないとき：外すのは行い、起こし直しは注意にとどめて続ける", async () => {
  const vm = fakeVm({ admin: true, inGroup: true, managerGroups: ["incus", "incus-admin"] });
  const access = accessOf(vm);
  const { state, ran } = await prepareContainersHost(access, { mayRestartUserManager: false });
  assert.deepEqual(ran[0], ["gpasswd", "-d", "banto", "incus-admin"]);
  assert.ok(!ran.some((r) => r.join(" ") === "systemctl restart user@1000.service"));
  // 後ろの項目は整えた
  assert.ok(ran.some((r) => r[0] === "loginctl"));
  const after = await evaluateContainersHost(state, access, "verify", { mayRestartUserManager: false });
  const manager = after.find((c) => c.id === "user-manager")!;
  assert.equal(manager.status, "warn");
  assert.match(manager.detail!, /Project を全部閉じてから/);
});

test("zabblyKeyOk：公開鍵が1つで、指紋が決めた値のときだけ", () => {
  const one = "pub:-:4096:1:82CC8797C838DCFD:1:::-:::scESC::::::23::0:\nfpr:::::::::4EFC590696CB15B87C73A3AD82CC8797C838DCFD:\nuid:-::::1::x::Zabbly Kernel Builds <info@zabbly.com>::::::::::0:\n";
  assert.equal(zabblyKeyOk(one), true);
  assert.equal(zabblyKeyOk(one.replace("4EFC5906", "4EFC5907")), false);
  assert.equal(zabblyKeyOk(one + one), false);
  assert.equal(zabblyKeyOk(""), false);
});

test("incus-admin を外したら incus-user の口が起きていない：同じ項目の2周目で口を起こしてから続ける", async () => {
  const vm = fakeVm({ admin: true, inGroup: true, socketDown: true });
  const access = accessOf(vm);
  const { state, ran } = await prepareContainersHost(access);
  assert.deepEqual(ran.slice(0, 2), [
    ["gpasswd", "-d", "banto", "incus-admin"],
    ["systemctl", "enable", "--now", "incus-user.socket"],
  ]);
  const after = await evaluateContainersHost(state, access, "verify");
  assert.deepEqual(new Set(after.map((c) => c.status)), new Set(["ok"]));
});

test("probeContainersPrerequisites（登録）：共通の項目（道具）を入れて引き直してから Incus の準備へ進み、行ったことは1行にまとめる", async () => {
  const vm = fakeVm({ admin: true, inGroup: true, os: { apt: true, id: "ubuntu", version: "24.04", codename: "noble", arch: "amd64" } });
  const values = (): Map<string, string> =>
    new Map(
      Object.entries({
        "os.id": "ubuntu",
        "os.like": "debian",
        "os.version": "24.04",
        "os.codename": "noble",
        apt: "1",
        "dpkg.arch": "amd64",
        sudo: "1",
        arch: process.arch === "x64" ? "x86_64" : "aarch64",
        libc: "glibc 2.39",
        "tool.tar": vm.tools.has("tar") ? "1" : "0",
        uid: "1000",
        gid: "1001",
        user: "banto",
        root: "/home/banto/.local/share/banto-remote",
        writable: "1",
        maxsessions: "10",
      }),
    );
  let probes = 0;
  const base = async () => {
    probes++;
    return { probe: { before: "", values: values() }, forwarding: { tcp: true, streamLocal: true }, result: { code: 0, stdout: "", stderr: "" } };
  };
  const r = await probeContainersPrerequisites(
    { host: "vm", port: 22, user: "banto" },
    { knownHostsFile: "", agentSocket: "", publicKeyFile: "" },
    "ssh-ed25519",
    "~/x",
    { mode: "prepare", run: accessOf(vm).run, base: base as never, mayRestartUserManager: true },
  );
  assert.equal(probes, 2);
  assert.ok(vm.tools.has("tar"));
  assert.equal(vm.admin, false);
  const prepared = r.checks.filter((c) => c.id === "prepared");
  assert.equal(prepared.length, 1);
  assert.match(prepared[0]!.detail!, /sudo apt-get install --no-install-recommends tar[\s\S]*sudo gpasswd -d banto incus-admin/);
  assert.ok(r.checks.filter((c) => c.id !== "prepared").every((c) => c.status === "ok"), JSON.stringify(r.checks.filter((c) => c.status !== "ok")));
});

test("reachableProject：environment.project ではなく見える区画の一覧で決める（banto-ct-test：incus-user 経由でも /1.0 は default を返す）", async () => {
  const at = (stdout: string, code = 0): VmAccess => ({ user: "banto", uid: 1000, gid: 1001, run: async () => ({ code, stdout, stderr: "" }) });
  assert.equal(await reachableProject(at('["/1.0/projects/user-1000"]')), "user-1000");
  assert.equal(await reachableProject(at('["/1.0/projects/default","/1.0/projects/user-1000"]')), "default");
  assert.equal(await reachableProject(at("[]")), "");
  assert.equal(await reachableProject(at("", 1)), "");
  // banto-ct-test と同じ形（制限つきの証明書・incus-admin 無し）は、繋がる
  const vm = fakeVm({ inGroup: true });
  const checks = await evaluateContainersHost(await inspectContainersHost(accessOf(vm)), accessOf(vm), "check");
  assert.equal(checks.find((c) => c.id === "incus-project")!.status, "ok");
});

test("sameGroups：主のグループの有無に左右されず、補助のグループの組で比べる", () => {
  assert.equal(sameGroups("Groups:\t4 24 990\n", "1000 4 24 990"), true);
  assert.equal(sameGroups("Groups:\t1000 4 24 990\n", "1000 4 24 990"), true);
  assert.equal(sameGroups("Groups:\t4 24 990 991\n", "1000 4 24 990"), false);
  assert.equal(sameGroups("Groups:\t4 24\n", "1000 4 24 990"), false);
  assert.equal(sameGroups("Name:\tx\n", "1000 4"), true);
});

test("置き場：/var/lib/incus が btrfs でなければ大きさを決めたファイル（空きの半分、50GiB まで）。空きが少なければ断る", async () => {
  const vm = fakeVm({ fs: "ext4", availGiB: 40 });
  await prepareContainersHost(accessOf(vm));
  assert.deepEqual(vm.sudoCalls.find((c) => c[1] === "storage" && c[2] === "create"), ["incus", "storage", "create", "banto", "btrfs", "size=20GiB"]);

  const small = fakeVm({ fs: "ext4", availGiB: 12 });
  const access = accessOf(small);
  const { state } = await prepareContainersHost(access);
  assert.equal(small.pools.size, 0);
  const pool = (await evaluateContainersHost(state, access, "check")).find((c) => c.id === "incus-pool")!;
  assert.equal(pool.status, "fail");
  assert.match(pool.detail!, /12GiB/);
});

test("区画の idmap の許しに足すときは、今の値を残して足す", async () => {
  const vm = fakeVm({ inGroup: true, project: { restricted: "true", "restricted.idmap.uid": "2000", "restricted.idmap.gid": "1001" } });
  await prepareContainersHost(accessOf(vm));
  assert.equal(vm.project!["restricted.idmap.uid"], "2000,1000");
  assert.equal(vm.project!["restricted.idmap.gid"], "1001");
  assert.equal(idRangesInclude("1-5,1000-1000", 1000), true);
  assert.equal(idRangesInclude("1-5", 1000), false);
  assert.equal(idRangesInclude(undefined, 1000), false);
});

test("仮想化の実験を許した実行場所：区画の unix-char も準備の項目に入り、登録・確かめ直しで sudo -n で足す。崩れても繋ぐたびは注意だけ", async () => {
  const vm = fakeVm({ inGroup: true, linger: true, pools: new Set(["banto"]), subuid: "root:1000:1\n", subgid: "root:1001:1\n" });
  vm.project = { restricted: "true", "restricted.devices.proxy": "allow", "restricted.idmap.uid": "1000", "restricted.idmap.gid": "1001" };
  const access = accessOf(vm);
  // 許していなければ項目に無い
  const off = await evaluateContainersHost(await inspectContainersHost(access), access, "verify");
  assert.equal(off.find((c) => c.id === "incus-unix-char"), undefined);

  const opts = { mayRestartUserManager: true, virtualization: true };
  const { ran } = await prepareContainersHost(access, opts);
  assert.deepEqual(ran, [["incus", "project", "set", "user-1000", "restricted.devices.unix-char=allow"]]);
  assert.equal(vm.project["restricted.devices.unix-char"], "allow");
  const again = await prepareContainersHost(access, opts);
  assert.deepEqual(again.ran, [], "済んでいれば何も打たない");

  // 人の手で崩された：繋ぐたびの確かめは sudo せず、断らずに「確かめ直す」で整えると言う
  delete vm.project["restricted.devices.unix-char"];
  vm.sudoCalls.length = 0;
  const checks = await evaluateContainersHost(await inspectContainersHost(access), access, "verify", opts);
  const item = checks.find((c) => c.id === "incus-unix-char")!;
  assert.equal(item.status, "warn");
  assert.match(item.detail!, /確かめ直す/);
  assert.equal(item.fix, "sudo incus project set user-1000 restricted.devices.unix-char=allow");
  assert.ok(!vm.sudoCalls.some((c) => c.includes("set")), "繋ぐたびの確かめで変えた");
});

test("入れ子の KVM は表示だけ：有効・無効・KVM が無いを出し分け、仮想化を許していて無効なら注意（何も打たない）", async () => {
  const on = fakeVm({ nested: "Y\n" });
  const onChecks = await evaluateContainersHost(await inspectContainersHost(accessOf(on)), accessOf(on), "verify", { mayRestartUserManager: false, virtualization: true });
  assert.match(onChecks.find((c) => c.id === "nested-kvm")!.label, /有効/);
  assert.equal(onChecks.find((c) => c.id === "nested-kvm")!.status, "ok");

  const offVm = fakeVm({ nested: "N\n" });
  const offState = await inspectContainersHost(accessOf(offVm));
  assert.equal(offState.nestedKvm, "off");
  const plain = await evaluateContainersHost(offState, accessOf(offVm), "verify");
  assert.equal(plain.find((c) => c.id === "nested-kvm")!.status, "ok", "仮想化を許していなければ注意にしない");
  const allowed = await evaluateContainersHost(offState, accessOf(offVm), "verify", { mayRestartUserManager: false, virtualization: true });
  const item = allowed.find((c) => c.id === "nested-kvm")!;
  assert.equal(item.status, "warn");
  assert.equal(item.fix, undefined, "banto は変えない（直し方のコマンドを出さない）");
  assert.ok(!item.autoFix);

  assert.equal((await inspectContainersHost(accessOf(fakeVm()))).nestedKvm, "missing");
});
