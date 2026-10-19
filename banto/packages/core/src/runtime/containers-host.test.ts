import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncusResult } from "@banto/container";
import {
  evaluateContainersHost,
  idRangesInclude,
  inspectContainersHost,
  prepareContainersHost,
  sameGroups,
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
    const [cmd, ...rest] = args;
    if (cmd === "query" && rest[0] === "/1.0") {
      // incus-user は最初に繋いだときに区画を作る（制限つき・idmap はそのユーザーだけ）
      if (!vm.admin && !vm.project) vm.project = { restricted: "true", "restricted.idmap.uid": "1000", "restricted.idmap.gid": "1001" };
      return ok(JSON.stringify({ environment: { server_version: vm.version, project: vm.admin ? "default" : "user-1000" } }));
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
    if (cmd === "admin" && rest[0] === "waitready") return ok();
    return fail(`偽の VM は incus ${args.join(" ")} を知らない`);
  };
  const root = (args: string[]): IncusResult => {
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
    if (cmd === "systemctl" && rest.join(" ") === "enable --now incus-user.socket") return ok();
    if (cmd === "sh" && rest[0] === "-c" && rest[2] === "banto-incus") {
      vm.installed = true;
      vm.version = rest[3] === "stable" ? "6.19.0" : "6.0.6";
      return ok();
    }
    return fail(`偽の VM は sudo ${args.join(" ")} を知らない`);
  };
  return {
    user: "banto",
    uid: 1000,
    gid: 1001,
    ...(vm.os ? { os: vm.os } : {}),
    run: async (args) => {
      const [cmd, ...rest] = args;
      if (cmd === "incus") return incus(rest, false);
      if (cmd === "/usr/bin/sudo" && rest[0] === "-n") return root(rest.slice(1));
      if (cmd === "id" && rest[0] === "-nG") return ok(`banto ${groupNames(vm).join(" ")}\n`);
      if (cmd === "id" && rest[0] === "-G") return ok(`1001 ${groupNames(vm).map(gidOf).join(" ")}\n`);
      if (cmd === "systemctl" && rest[0] === "show") return ok(vm.managerGroups ? "4242\n" : "0\n");
      if (cmd === "cat" && rest[0] === "/proc/4242/status") return ok(`Name:\tsystemd\nGroups:\t1001 ${vm.managerGroups!.map(gidOf).join(" ")}\n`);
      if (cmd === "dpkg-query") return vm.installed ? ok(vm.version) : fail("no packages found matching incus", 1);
      if (cmd === "cat" && rest[0] === "/etc/subuid") return ok(vm.subuid);
      if (cmd === "cat" && rest[0] === "/etc/subgid") return ok(vm.subgid);
      if (cmd === "test") return vm.linger ? ok() : fail("", 1);
      if (cmd === "findmnt") return ok(`${vm.fs}\n`);
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
    sudo: "ok",
  });
  // Incus に繋がらないうちは版が分からない——区画の項目で名指しする
  assert.match(checks.find((c) => c.id === "incus-project")!.detail!, /Incus に繋がりません/);
  assert.match(checks.find((c) => c.id === "incus-project")!.fix!, /^sudo usermod -aG incus banto$/);
  // 見るための sudo（置き場が root から見えるか）だけで、何も変えていない
  assert.deepEqual(vm.sudoCalls, [["incus", "storage", "show", "banto"]]);
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
  assert.deepEqual(new Set(before.filter((c) => c.id !== "sudo" && c.id !== "user-manager").map((c) => c.status)), new Set(["warn"]));
  assert.match(before.find((c) => c.id === "incus")!.detail!, /Incus が入っていません。登録するときに banto/);
  assert.match(before.find((c) => c.id === "incus")!.fix!, /Zabbly の lts-6\.0 から Incus と btrfs-progs を入れる（鍵の指紋 4EFC590696CB15B87C73A3AD82CC8797C838DCFD/);
  assert.match(before.find((c) => c.id === "incus-pool")!.detail!, /Incus を入れたあとに整えます/);
  assert.ok(before.every((c) => c.status === "ok" || c.autoFix));

  const { state, ran } = await prepareContainersHost(access);
  const install = ran[0]!;
  assert.deepEqual(
    [install[0], install[1], install[3], install[4], install[5], install[6], install[7]],
    ["sh", "-c", "banto-incus", "lts-6.0", "noble", "amd64", "4EFC590696CB15B87C73A3AD82CC8797C838DCFD"],
  );
  // 台本：鍵の指紋を確かめ、合わなければ置かずに止める
  assert.match(install[2]!, /gpg --show-keys --with-colons/);
  assert.match(install[2]!, /exit 3/);
  assert.deepEqual(ran.slice(1, 2), [["usermod", "-aG", "incus", "banto"]]);
  const after = await evaluateContainersHost(state, access, "verify");
  assert.deepEqual(new Set(after.map((c) => c.status)), new Set(["ok"]));

  // 26.04 は stable（lts-6.0 には resolute が無い）
  const vm26 = fakeVm({ installed: false, os: { ...os, version: "26.04", codename: "resolute" } });
  const r26 = await prepareContainersHost(accessOf(vm26));
  assert.equal(r26.ran[0]![4], "stable");
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
