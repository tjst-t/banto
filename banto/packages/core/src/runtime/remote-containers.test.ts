// 別のサーバの中の、Project ごとのコンテナ（Backlog #368）。偽の ssh は向こうのコマンドをこの機械の sh で流し、偽の incus
// （状態をファイルに持つ）がコンテナの作り・装置・中で流したコマンドを記録する。中のユーザー（`--user`）で流したものだけは
// この機械で本当に走らせる——中から書いたものが、見せたフォルダに本当にできることを見る
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { idmapFor } from "@banto/container";
import {
  INSIDE_IDS,
  INSIDE_RELAY_PORT,
  containersRootProblem,
  createOnlyDirScript,
  insideCommand,
  insideShellHomeCommand,
  parseIpAddr,
  vmProjectRunDir,
} from "./remote-containers.js";
import { RemoteSshRuntime } from "./remote-ssh.js";

test("VM のインターフェースは ip -o -4 addr show から読む（loopback は除く）", () => {
  const out = [
    "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever",
    "2: enp1s0    inet 192.168.1.20/24 brd 192.168.1.255 scope global enp1s0\\       valid_lft forever",
    "3: incusbr-1001    inet 10.40.3.1/24 scope global incusbr-1001\\       valid_lft forever",
    "4: veth1@if5    inet 10.1.1.1/32 scope global veth1",
  ].join("\n");
  assert.deepEqual(parseIpAddr(out), { enp1s0: ["192.168.1.20"], "incusbr-1001": ["10.40.3.1"], veth1: ["10.1.1.1"] });
});

test("containers の根の重なり：home そのもの・home の外・置き場の根・ほかの Project の根（閉じたものも）と重なれば断る", () => {
  const facts = {
    home: "/home/vm",
    dataRoot: "/home/vm/.local/share/banto-remote",
    others: [{ name: "B", root: "/home/vm/work/b" }],
  };
  assert.match(containersRootProblem("/home/vm", facts)!, /home そのもの/);
  assert.match(containersRootProblem("/srv/x", facts)!, /home（\/home\/vm）の下にありません/);
  assert.match(containersRootProblem("/", facts)!, /home（\/home\/vm）の下にありません/);
  // 置き場の根を含む・その中
  assert.match(containersRootProblem("/home/vm/.local", facts)!, /banto の置き場/);
  assert.match(containersRootProblem("/home/vm/.local/share/banto-remote/abc/code", facts)!, /banto の置き場/);
  // ほかの Project の根：同じ・含む・その中
  for (const root of ["/home/vm/work/b", "/home/vm/work", "/home/vm/work/b/sub"]) {
    assert.match(containersRootProblem(root, facts)!, /Project「B」の根/, root);
  }
  // 綴りが前方で一致するだけなら重ならない
  assert.equal(containersRootProblem("/home/vm/work/bb", facts), undefined);
  assert.equal(containersRootProblem("/home/vm/work/a", facts), undefined);
});

test("まだ見せていないフォルダを作る台本：無ければ作り、あれば触らない。symlink は辿らずに断る", () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-create-only-"));
  const outside = join(dir, "outside");
  mkdirSync(outside);
  const sh = (path: string) => spawnSync("sh", ["-c", createOnlyDirScript(path)], { encoding: "utf8" });
  try {
    // 無ければ作る（0700）
    const fresh = join(dir, "modules", "shell-p1");
    assert.equal(sh(fresh).status, 0);
    assert.ok(existsSync(fresh));
    // あれば何もしない
    writeFileSync(join(fresh, "keep"), "x");
    assert.equal(sh(fresh).status, 0);
    assert.ok(existsSync(join(fresh, "keep")));
    // そのパスが symlink
    const link = join(dir, "modules", "shell-p2");
    symlinkSync(outside, link);
    const r1 = sh(link);
    assert.equal(r1.status, 3, r1.stderr);
    assert.match(r1.stderr, /symlink なので使いません/);
    // 途中が symlink：辿った先に作らない
    const viaLink = join(dir, "modules", "shell-p2", "deeper");
    const r2 = sh(viaLink);
    assert.equal(r2.status, 3, r2.stderr);
    assert.deepEqual(readdirSync(outside), [], "symlink の先に作った");
    // フォルダでないもの
    const file = join(dir, "file");
    writeFileSync(file, "x");
    assert.equal(sh(file).status, 3);
    assert.throws(() => createOnlyDirScript("relative/path"), /おかしい/);
    assert.throws(() => createOnlyDirScript("/a/../b"), /おかしい/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("中で流すコマンドは incus exec <c> --user 1000 --group 1000 で、引数は崩れない", () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-inside-cmd-"));
  try {
    writeFileSync(join(dir, "incus"), `#!/bin/sh\nfor a; do printf '[%s]\\n' "$a"; done\n`);
    chmodSync(join(dir, "incus"), 0o755);
    const cmd = insideShellHomeCommand("banto-p1", "/home/vm/x y/home", "/c/bin/node", `const s='a b';"$x"`);
    const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    const argv = [...r.stdout.matchAll(/^\[([\s\S]*?)\]$/gm)].map((m) => m[1]);
    assert.deepEqual(argv.slice(0, 6), ["exec", "banto-p1", "--user", "1000", "--group", "1000"]);
    assert.ok(argv.includes("HOME=/home/banto"));
    const rest = argv.slice(argv.indexOf("--") + 1);
    assert.equal(rest[0], "/bin/sh");
    assert.deepEqual(rest.slice(3), ["banto-shell-home", "/home/vm/x y/home", "/c/bin/node", `const s='a b';"$x"`]);
    assert.match(insideCommand("c", ["true"]), /^exec 'incus' 'exec' 'c' '--user' '1000' '--group' '1000' /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 偽の VM（ssh → この機械の sh、incus → 状態を持つ偽物）────────────────────

/** 偽の incus（node）。状態は $FAKE_INCUS_STATE、呼ばれた引数は $FAKE_INCUS_LOG に1行ずつ JSON で */
const FAKE_INCUS = String.raw`#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const statePath = "__STATE__";
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { instances: {} };
const args = process.argv.slice(2);
fs.appendFileSync("__ILOG__", JSON.stringify(args) + "\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(st));
const out = (s) => { process.stdout.write(s); save(); process.exit(0); };
const die = (s) => { process.stderr.write(s); save(); process.exit(1); };
const profileNic = { eth0: { type: "nic", network: "incusbr-1001", name: "eth0" } };
const [cmd, ...rest] = args;
if (cmd === "project") out("user-1001\n");
if (cmd === "query") {
  if (rest[0] === "-X") {
    const name = /instances\/([^?]+)/.exec(rest[2])[1];
    const added = JSON.parse(rest[rest.indexOf("--data") + 1]).devices;
    Object.assign(st.instances[name].devices, added);
    // 本物の bind mount と同じく、付けたときのフォルダ（inode）を見続ける
    st.mounted = st.mounted || {};
    for (const [dev, d] of Object.entries(added)) if (d.type === "disk") st.mounted[name + "/" + dev] = fs.statSync(d.source).ino;
    out("");
  }
  if (/^\/1\.0\/images\/aliases\//.test(rest[0])) out("{}");
  if (/^\/1\.0\/instances\?recursion=1/.test(rest[0])) out(JSON.stringify(Object.entries(st.instances).map(([name, i]) => ({ name, ...i }))));
  const m = /^\/1\.0\/instances\/([^/?]+)\?/.exec(rest[0]);
  if (m) {
    const i = st.instances[m[1]];
    if (!i) die("Error: Instance not found");
    out(JSON.stringify({ ...i, expanded_devices: { ...profileNic, ...i.devices } }));
  }
  die("偽の incus は " + rest[0] + " を知らない");
}
if (cmd === "init") {
  const config = {};
  for (let i = 0; i < rest.length; i++) if (rest[i] === "-c") { const kv = rest[i + 1]; config[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); }
  st.instances[rest[1]] = { status: "Stopped", config, devices: {}, image: rest[0], storage: rest[rest.indexOf("--storage") + 1] };
  out("");
}
if (cmd === "config" && rest[0] === "device" && rest[1] === "remove") {
  delete st.instances[rest[2]].devices[rest[3]];
  if (st.mounted) delete st.mounted[rest[2] + "/" + rest[3]];
  out("");
}
if (cmd === "config" && rest[0] === "set") { for (const kv of rest.slice(2)) st.instances[rest[1]].config[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); out(""); }
if (cmd === "start") { st.instances[rest[0]].status = "Running"; out(""); }
if (cmd === "stop") { st.instances[rest[0]].status = "Stopped"; out(""); }
if (cmd === "exec") {
  const name = rest[0];
  const dash = rest.indexOf("--");
  const opts = rest.slice(1, dash);
  const argv = rest.slice(dash + 1);
  const user = opts.includes("--user") ? opts[opts.indexOf("--user") + 1] : undefined;
  if (argv[1] === "--version") out(process.version + "\n");
  // 中から見たフォルダの inode：そのパスに付いている装置の、付けたときのもの（bind mount と同じ）。付いていなければ無い
  if (argv[0] === "stat") {
    const path = argv[argv.length - 1];
    const dev = Object.entries(st.instances[name].devices).find(([, d]) => d.type === "disk" && d.path === path);
    const ino = dev && st.mounted ? st.mounted[name + "/" + dev[0]] : undefined;
    if (ino === undefined) die("stat: cannot statx '" + path + "': No such file or directory");
    out(ino + "\n");
  }
  // 中の root で流すもの（ユーザーを作る・仕事の組）はこの機械で走らせない
  if (user === undefined) out("1\n");
  // 中のユーザーで流すもの：この機械で本当に走らせる（見せたフォルダに書けたかを見る）
  const env = { ...process.env };
  for (let i = 0; i < opts.length; i++) if (opts[i] === "--env") { const kv = opts[i + 1]; env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); }
  save();
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
out("");
`;

/** 偽の ssh：`--` の後の宛先を飛ばし、向こうのコマンドをこの機械の sh で流す。流した台本を $FAKE_SSH_LOG に残す */
const FAKE_SSH = String.raw`#!/bin/sh
case " $* " in *" -O "*) printf '%s\n' "$*" >> '__OLOG__' ;; esac
while [ "$1" != "--" ]; do shift; done
shift; shift
if [ "$1" = "sh -s" ]; then
  script=$(cat)
  printf '%s\n\0' "$script" >> '__SLOG__'
  exec sh -c "$script"
fi
printf '%s\n\0' "$1" >> '__SLOG__'
exec sh -c "$1"
`;

test("containers の Project：コンテナの中で起こし、置き場はその Project のコンテナにだけ見せ、見せたフォルダには中から書き、symlink を辿らない", async () => {
  // VM の置き場の中のソケット（流れの口の待ち受け）がパスの上限に収まるよう、短い /tmp の下に作る（TMPDIR は長いことがある）
  const root = mkdtempSync("/tmp/banto-remote-ct-");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const base = join(root, "vm", "base");
  const codeDir = `${base}/code/v-1`;
  for (const d of [bin, dataDir, codeDir, join(root, "vm", "work", "a"), join(root, "vm", "work", "b")]) mkdirSync(d, { recursive: true });
  const incusLog = join(root, "incus.log");
  const sshLog = join(root, "ssh.log");
  writeFileSync(join(bin, "incus"), FAKE_INCUS.replace("__STATE__", join(root, "incus.json")).replace("__ILOG__", incusLog));
  const controlLog = join(root, "control.log");
  writeFileSync(join(bin, "ssh"), FAKE_SSH.replaceAll("__SLOG__", sshLog).replaceAll("__OLOG__", controlLog));
  // VM だけの場所（本物は /run/user/<uid>）。ソケットのパスの上限に収まるよう、短い /tmp の下に作る
  const runDir = mkdtempSync("/tmp/banto-run-");
  chmodSync(join(bin, "incus"), 0o755);
  chmodSync(join(bin, "ssh"), 0o755);
  // 中の node＝この機械の node（Shell のホームの古いものを消すのに使う）
  mkdirSync(join(codeDir, "bin"));
  symlinkSync(process.execPath, join(codeDir, "bin", "node"));
  writeFileSync(incusLog, "");
  writeFileSync(sshLog, "");
  writeFileSync(controlLog, "");
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const masters: ChildProcess[] = [];
  const servers: Server[] = [];
  /** 本物の `connect` は待ち受けを作ってから繋ぐ——偽の接続は、最後に待ち受けを作った Project のものにする */
  let connecting: string | undefined;
  /** 閉じた Project（core の記録の代わり） */
  const closed = new Set<string>();
  const conn = () => {
    const master = spawn("sleep", ["60"], { stdio: "ignore" });
    masters.push(master);
    const exited = new Promise<void>((resolve) => master.once("close", () => resolve()));
    const c: Record<string, unknown> = {
      runtimeName: "vm",
      projectId: connecting,
      runtime: { name: "vm", host: "vm.example", port: 22, user: "u", mode: "containers" },
      controlPath: join(root, "cm"),
      knownHostsFile: "/dev/null",
      master,
      alive: true,
      exited,
      remotePort: undefined,
      base,
      codeDir,
      checks: [],
      forwards: new Map(),
      cautioned: new Set(),
    };
    void exited.then(() => (c.alive = false));
    return c;
  };
  const rt = new RemoteSshRuntime({
    dataDir,
    monorepoRoot: join(root, "repo"),
    runtimes: { withConnection: async () => conn(), get: () => ({ mode: "containers", host: "vm.example" }) } as never,
    remoteNameOf: (id) => (id.startsWith("p") ? "vm" : undefined),
    createRelayListener: (_name, projectId) => {
      connecting = projectId;
      const s = createServer();
      servers.push(s);
      return s;
    },
    notify: async () => undefined,
    log: () => undefined,
    shellHomeSource: join(root, "nohome"),
    vmRunDir: () => runDir,
    projectClosed: (id) => closed.has(id),
    lookupIPv4: async () => "192.168.1.20",
  });
  const state = () =>
    JSON.parse(readFileSync(join(root, "incus.json"), "utf8")) as {
      instances: Record<string, { config: Record<string, string>; devices: Record<string, Record<string, string>>; storage: string; status: string }>;
      mounted: Record<string, number>;
    };
  try {
    const rootA = join(root, "vm", "work", "a");
    const rootB = join(root, "vm", "work", "b");
    const a = await rt.prepare({ id: "p1", root: rootA, nesting: false });
    const b = await rt.prepare({ id: "p2", root: rootB, nesting: false });

    // コンテナの作り
    const ca = state().instances["banto-p1"]!;
    const cb = state().instances["banto-p2"]!;
    assert.ok(ca && cb, "Project ごとのコンテナが無い");
    assert.equal(ca.storage, "banto");
    assert.equal(ca.status, "Running");
    const { uid, gid } = userInfo();
    assert.equal(ca.config["raw.idmap"], idmapFor(uid, gid, INSIDE_IDS), "VM のユーザーを中の 1000 に対応させていない");
    assert.equal(ca.config["user.banto.owner"], dataDir);
    assert.deepEqual(ca.devices["banto"], { type: "disk", source: `${base}/code`, path: `${base}/code`, readonly: "true" });
    assert.deepEqual(ca.devices["project"], { type: "disk", source: rootA, path: rootA });
    assert.equal(ca.devices["eth0"]?.["security.port_isolation"], "true");
    assert.deepEqual(cb.devices["project"], { type: "disk", source: rootB, path: rootB });
    assert.equal(a.nodePath, `${codeDir}/bin/node`);
    assert.equal(a.moduleEnv, undefined, "中では sudo できる——BANTO_NO_SUDO を渡している");

    // 中から banto へ（#369）：住所はコンテナの中の 127.0.0.1 の決めたポート。proxy device がその Project のトンネルの
    // ソケット（VM だけの場所）へ繋ぐ。VM の 127.0.0.1 のトンネルの番号は中からは届かないので使わない
    assert.equal(a.bantoOrigin, `http://127.0.0.1:${INSIDE_RELAY_PORT}`);
    assert.equal(b.bantoOrigin, `http://127.0.0.1:${INSIDE_RELAY_PORT}`);
    const tunnelA = `${runDir}/banto/p-p1/t.sock`;
    const tunnelB = `${runDir}/banto/p-p2/t.sock`;
    assert.deepEqual(ca.devices["banto-relay"], {
      type: "proxy",
      bind: "instance",
      listen: `tcp:127.0.0.1:${INSIDE_RELAY_PORT}`,
      connect: `unix:${tunnelA}`,
      // 繋ぐのは VM の側——VM のユーザーの番号に落とす（root で繋がない、条件4）
      "security.uid": String(uid),
      "security.gid": String(gid),
    });
    assert.equal(cb.devices["banto-relay"]?.["connect"], `unix:${tunnelB}`, "p2 の道が p1 のトンネルへ繋いでいる");
    // トンネルは Project ごとの決まったパスの UNIX ソケット（-R <ソケット>:127.0.0.1:<その Project の待ち受け>）。置き場は VM の
    // ユーザーだけのもの
    const controls = () => readFileSync(controlLog, "utf8").trim().split("\n").filter(Boolean);
    const tunnels = controls().filter((l) => / -O forward -R /.test(l));
    const portOf = (sock: string) => Number(new RegExp(`-R ${sock}:127\\.0\\.0\\.1:(\\d+) `).exec(tunnels.join("\n"))?.[1]);
    const portA = portOf(tunnelA);
    const portB = portOf(tunnelB);
    assert.ok(portA > 0 && portB > 0, `トンネルを張っていない：${tunnels.join("\n")}`);
    assert.notEqual(portA, portB, "2つの Project のトンネルが同じ待ち受けに繋がっている");
    assert.deepEqual(servers.map((s) => (s.address() as { port: number }).port).sort(), [portA, portB].sort());
    for (const d of [`${runDir}/banto/p-p1`, `${runDir}/banto/p-p2`, `${runDir}/banto`]) assert.equal(statSync(d).mode & 0o777, 0o700, d);

    // Module の置き場：その Project のコンテナにだけ見せる
    const modA = join(dataDir, "modules", "shell-p1");
    const modB = join(dataDir, "modules", "shell-p2");
    await a.prepareModuleDirs({ dataDir: modA, packageDir: join(dataDir, "none") });
    await b.prepareModuleDirs({ dataDir: modB, packageDir: join(dataDir, "none") });
    const sources = (c: string) => Object.values(state().instances[c]!.devices).map((d) => d["source"]);
    assert.ok(sources("banto-p1").includes(`${base}/modules/shell-p1`));
    assert.ok(!sources("banto-p1").includes(`${base}/modules/shell-p2`), "p1 のコンテナに p2 の置き場が見える");
    assert.ok(!sources("banto-p1").includes(rootB), "p1 のコンテナに p2 の根が見える");
    assert.ok(sources("banto-p2").includes(`${base}/modules/shell-p2`));
    assert.ok(!sources("banto-p2").includes(`${base}/modules/shell-p1`), "p2 のコンテナに p1 の置き場が見える");

    // Shell のホーム：中のユーザーで展開する（VM のユーザーの台本はホームに触らない）
    writeFileSync(sshLog, "");
    writeFileSync(incusLog, "");
    const home = await a.prepareShellHome(modA, []);
    assert.equal(home.home, `${base}/modules/shell-p1/home`);
    assert.ok(existsSync(join(home.home, ".banto-shell-home.json")), "中から展開したホームが無い");
    const incusCalls = readFileSync(incusLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    const homeExec = incusCalls.find((c) => c[0] === "exec" && c.includes(home.home));
    assert.ok(homeExec, "ホームを中で展開していない");
    assert.deepEqual(homeExec.slice(0, 6), ["exec", "banto-p1", "--user", "1000", "--group", "1000"]);
    // 中のユーザーで流したもの（`exec 'incus' 'exec' …`、標準入力を流すときは `sh -c` に包まれる）を除いた、VM のユーザーの台本
    const vmScripts = readFileSync(sshLog, "utf8").split("\0").filter((s) => s.trim() && !/^(sh -c ')?exec '[^a-z]*incus/.test(s.trim()));
    assert.ok(!vmScripts.some((s) => s.includes(home.home)), `VM のユーザーの台本が見せたフォルダに書いている：${vmScripts.join("\n---\n")}`);

    // symlink を辿らない：置き場が外への symlink に差し替えられていたら断り、装置も足さない
    const outside = join(root, "outside");
    mkdirSync(outside);
    const modA2 = join(dataDir, "modules", "files-p1");
    symlinkSync(outside, `${base}/modules/files-p1`);
    await assert.rejects(a.prepareModuleDirs({ dataDir: modA2, packageDir: join(dataDir, "none") }), /symlink なので使いません/);
    assert.ok(!sources("banto-p1").includes(`${base}/modules/files-p1`), "symlink の置き場を見せた");
    assert.deepEqual(readdirSync(outside), []);

    // 起こし方：ssh <VM> incus exec <c> --user 1000 -- <node> <起動役> <単位>
    const cmd = a.processCommand({ name: "shell-p1", command: process.execPath, args: ["server.js"], cwd: rootA, env: { SECRET: "s" } });
    assert.equal(cmd.command, "ssh");
    const remote = cmd.args[cmd.args.length - 1]!;
    assert.ok(remote.startsWith("exec 'incus' 'exec' 'banto-p1' '--user' '1000' '--group' '1000' "), remote);
    assert.ok(remote.endsWith(`'--' '${codeDir}/bin/node' '${codeDir}/banto-launcher.mjs' 'banto-mod-shell-p1'`), remote);
    assert.ok(!remote.includes("SECRET"), "env がコマンド行に載った");
    assert.throws(() => a.processCommand({ name: "x", command: "x", args: [], cwd: "/", env: {}, asRoot: true }), /root/);
    // 鍵の窓口（#369）：VM だけの場所の Project ごとのソケットへ転送し、proxy device で中の /run に出す
    const agentHost = join(dataDir, "s", "m-shell", "agent.sock");
    mkdirSync(join(dataDir, "s", "m-shell"), { recursive: true });
    writeFileSync(agentHost, "");
    const agentInside = await a.socketPathInside!(agentHost);
    assert.match(agentInside, /^\/run\/banto-a-[0-9a-f]{12}\.sock$/);
    const mark = /banto-a-([0-9a-f]{12})/.exec(agentInside)![1]!;
    const agentVm = `${runDir}/banto/p-p1/a-${mark}.sock`;
    assert.ok(controls().some((l) => l.includes(`-O forward -R ${agentVm}:${agentHost} `)), `鍵の窓口を VM だけの場所へ転送していない：${controls().join("\n")}`);
    assert.deepEqual(state().instances["banto-p1"]!.devices[`banto-a-${mark}`], {
      type: "proxy",
      bind: "instance",
      listen: `unix:${agentInside}`,
      connect: `unix:${agentVm}`,
      "security.uid": String(uid),
      "security.gid": String(gid),
      // 中の待ち受けは中のユーザーのもの（中の番号は宣言から——決め打ちしない）
      uid: String(INSIDE_IDS.uid),
      gid: String(INSIDE_IDS.gid),
      mode: "0600",
    });
    assert.ok(!Object.keys(state().instances["banto-p2"]!.devices).some((d) => d.startsWith("banto-a-")), "p1 の鍵の窓口が p2 のコンテナに見える");
    await assert.rejects(a.socketPathInside!("/etc/agent.sock"), /banto の置き場の外/);
    // host の窓口が消えたら（Vault が閉じた）、転送と装置を外す
    rmSync(agentHost);
    const until = Date.now() + 5_000;
    while (state().instances["banto-p1"]!.devices[`banto-a-${mark}`] && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.equal(state().instances["banto-p1"]!.devices[`banto-a-${mark}`], undefined, "窓口が閉じたのに道を外していない");
    assert.ok(controls().some((l) => l.includes(`-O cancel -R ${agentVm}:${agentHost} `)), "窓口が閉じたのに転送を外していない");
    // 外すのは鍵の窓口だけ——トンネル（host の側は TCP の待ち受けでファイルが無い）を、窓口が消えたものとして外さない
    assert.ok(!controls().some((l) => l.includes(`-O cancel -R ${tunnelA}:`)), "鍵の窓口の見張りがトンネルを外した");
    // 流れの口（向きが逆）：VM の置き場の s（コンテナに見せていない）で装置が待ち受け、中の Module の待ち受けへ繋ぐ。
    // host はそこへ -L。VM のユーザーは中の置き場の symlink を辿らない（向こうに symlink を置かない）
    writeFileSync(controlLog, "");
    const streamHost = await rt.streamSocketPath("p1", "shell-p1", "s/stream.sock");
    const st = /\/(st-[0-9a-f]{10})$/.exec(streamHost)![1]!;
    assert.ok(controls().some((l) => l.includes(`-O forward -L ${streamHost}:${base}/s/${st} `)), `流れの口を転送していない：${controls().join("\n")}`);
    assert.deepEqual(state().instances["banto-p1"]!.devices[`banto-${st}`], {
      type: "proxy",
      bind: "host",
      listen: `unix:${base}/s/${st}`,
      connect: `unix:${base}/modules/shell-p1/s/stream.sock`,
      // 繋ぐのは中——中の番号に落とす（宣言から）。VM の待ち受けは VM のユーザー（sshd）のもの
      "security.uid": String(INSIDE_IDS.uid),
      "security.gid": String(INSIDE_IDS.gid),
      uid: String(uid),
      gid: String(gid),
      mode: "0600",
    });
    assert.ok(!existsSync(`${base}/s/${st}`), "VM に流れの口の symlink を置いた（VM のユーザーが中の置き場を辿る）");
    assert.equal(statSync(`${base}/s`).mode & 0o777, 0o700);
    // 2回目は同じもの（張り直さない）
    writeFileSync(incusLog, "");
    assert.equal(await rt.streamSocketPath("p1", "shell-p1", "s/stream.sock"), streamHost);
    assert.ok(!readFileSync(incusLog, "utf8").includes("PATCH"), "同じ流れの口の装置を張り直した");

    // 取ってきた配布物：読み取り専用で見せ、**版が変わってフォルダごと差し替えたら付け直す**（付けたままだと中は消された
    // 古いフォルダを見続け、空に見える）。変わっていなければ付け直さない
    const pkgHost = join(dataDir, "module-packages", "ext-a");
    mkdirSync(pkgHost, { recursive: true });
    writeFileSync(join(pkgHost, "server.js"), "v1\n");
    const pkgVm = `${base}/module-packages/ext-a`;
    const modExt = join(dataDir, "modules", "ext-a-p1");
    const modExtB = join(dataDir, "modules", "ext-a-p2");
    const pkgDevice = (c = "banto-p1") => Object.entries(state().instances[c]!.devices).find(([, d]) => d["source"] === pkgVm);
    const mountedIsCurrent = (c = "banto-p1") => {
      const [dev] = pkgDevice(c)!;
      return state().mounted[`${c}/${dev}`] === statSync(pkgVm).ino;
    };
    await a.prepareModuleDirs({ dataDir: modExt, packageDir: pkgHost });
    assert.equal(readFileSync(join(pkgVm, "server.js"), "utf8"), "v1\n");
    assert.deepEqual(pkgDevice()?.[1], { type: "disk", source: pkgVm, path: pkgVm, readonly: "true" });
    assert.ok(mountedIsCurrent());
    // 同じ VM のもう1つの Project も同じ配布物を使う（置き場は Module 名だけで決まり、共有）
    await b.prepareModuleDirs({ dataDir: modExtB, packageDir: pkgHost });
    assert.ok(mountedIsCurrent("banto-p2"));
    // 同じ版：付け直さない
    writeFileSync(incusLog, "");
    await a.prepareModuleDirs({ dataDir: modExt, packageDir: pkgHost });
    assert.ok(!readFileSync(incusLog, "utf8").includes("remove"), "版が同じなのに付け直した");
    // 版を上げた：VM でフォルダごと差し替わる → 付け直して、新しいフォルダを見る
    writeFileSync(join(pkgHost, "server.js"), "v2\n");
    const inoBefore = statSync(pkgVm).ino;
    await a.prepareModuleDirs({ dataDir: modExt, packageDir: pkgHost });
    assert.equal(readFileSync(join(pkgVm, "server.js"), "utf8"), "v2\n");
    assert.notEqual(statSync(pkgVm).ino, inoBefore, "試験の前提：フォルダごと差し替わっていない");
    assert.ok(mountedIsCurrent(), "差し替えたあと、コンテナは消した古いフォルダを見ている（付け直していない）");
    assert.equal(pkgDevice()?.[1]["readonly"], "true");
    // もう1つの Project：この接続は置き換えていない（VM のフォルダはもう新しい版）が、コンテナは消された古いフォルダを
    // 見ている——次に用意するときに付け直す
    assert.ok(!mountedIsCurrent("banto-p2"), "試験の前提：p2 のコンテナが古いフォルダを見ていない");
    await b.prepareModuleDirs({ dataDir: modExtB, packageDir: pkgHost });
    assert.ok(mountedIsCurrent("banto-p2"), "ほかの Project が差し替えたあと、このコンテナは消した古いフォルダを見ている（付け直していない）");
    // 付け直したあとは、もう付け直さない
    writeFileSync(incusLog, "");
    await b.prepareModuleDirs({ dataDir: modExtB, packageDir: pkgHost });
    assert.ok(!readFileSync(incusLog, "utf8").includes("remove"), "今のフォルダを見ているのに付け直した");

    // 2回目の用意では作り直さない
    writeFileSync(incusLog, "");
    await rt.prepare({ id: "p1", root: rootA, nesting: false });
    assert.equal(readFileSync(incusLog, "utf8"), "", "用意したコンテナをもう一度確かめに行った");

    // 接続を手放して繋ぎ直す：前の接続の鍵の窓口の道は外し（窓口の転送は接続と一緒に消えた）、トンネルは同じパスに張り直す
    // ——中から banto への道は変えない
    writeFileSync(agentHost, "");
    await a.socketPathInside!(agentHost);
    assert.ok(state().instances["banto-p1"]!.devices[`banto-a-${mark}`]);
    await rt.release("p1");
    writeFileSync(controlLog, "");
    const a2 = await rt.prepare({ id: "p1", root: rootA, nesting: false });
    assert.equal(state().instances["banto-p1"]!.devices[`banto-a-${mark}`], undefined, "前の接続の鍵の窓口の道が残っている");
    assert.equal(state().instances["banto-p1"]!.devices["banto-relay"]?.["connect"], `unix:${tunnelA}`);
    assert.ok(controls().some((l) => l.includes(`-O forward -R ${tunnelA}:127.0.0.1:`)), "繋ぎ直したのにトンネルを張っていない");
    assert.equal(a2.bantoOrigin, `http://127.0.0.1:${INSIDE_RELAY_PORT}`);

    // 公開（#369）：サービスのポートを渡すと、VM のポートからコンテナの中へ繋ぐ道を張り、その VM のポートを返す。VM のポートは
    // 止まっているものも含め区画の全コンテナの装置を避けて選ぶ
    const s0 = JSON.parse(readFileSync(join(root, "incus.json"), "utf8"));
    s0.instances["other"] = { status: "Stopped", config: {}, devices: { web: { type: "proxy", listen: "tcp:0.0.0.0:20000-20001", connect: "tcp:127.0.0.1:80" } } };
    writeFileSync(join(root, "incus.json"), JSON.stringify(s0));
    const pubA = await rt.address("p1", 3000);
    assert.ok("address" in pubA && pubA.port !== undefined, JSON.stringify(pubA));
    const vmPortA = (pubA as { port: number }).port;
    assert.equal((pubA as { address: string }).address, "192.168.1.20");
    assert.equal((pubA as { exposedOnLan?: true }).exposedOnLan, true);
    assert.ok(vmPortA >= 20002 && vmPortA <= 29999, `止まっているコンテナの装置のポートを避けていない：${vmPortA}`);
    assert.deepEqual(state().instances["banto-p1"]!.devices["banto-pub-3000"], {
      type: "proxy",
      bind: "host",
      listen: `tcp:0.0.0.0:${vmPortA}`,
      connect: "tcp:127.0.0.1:3000",
      // 繋ぐのは中——中の番号に落とす（宣言から）
      "security.uid": String(INSIDE_IDS.uid),
      "security.gid": String(INSIDE_IDS.gid),
    });
    // 同じポートをもう一度：同じ VM のポート（覚えずに装置から読む）
    assert.deepEqual(await rt.address("p1", 3000), pubA);
    // ポートを渡さなければ道は張らない（見積もり）
    assert.deepEqual(await rt.address("p1"), { address: "192.168.1.20", exposedOnLan: true });
    // ほかの Project の同じサービスのポート：ぶつからない（別の VM のポート）
    const pubB = (await rt.address("p2", 3000)) as { port: number };
    assert.notEqual(pubB.port, vmPortA);

    // 眠らせる・閉じる（#369）：containers は手放すときに Project のコンテナを止めるだけ（ほかの Project のコンテナには触らない）。
    // 手放すだけ（stop なし）なら動いたまま
    await rt.release("p1");
    assert.equal(state().instances["banto-p1"]!.status, "Running", "stop を頼んでいないのにコンテナを止めた");
    await rt.release("p2", { stop: true });
    assert.equal(state().instances["banto-p2"]!.status, "Stopped", "眠らせたのにコンテナが動いている");
    // 眠らせても公開の道は外さない（外すと眠っている間に番号を取られる）
    assert.equal(state().instances["banto-p2"]!.devices["banto-pub-3000"]?.["listen"], `tcp:0.0.0.0:${pubB.port}`, "眠らせたら公開の道を外した");
    assert.equal(state().instances["banto-p1"]!.status, "Running", "ほかの Project のコンテナまで止めた");
    // 接続が無くても（banto を起こし直したあと等）、止めるために繋いで止める
    await rt.prepare({ id: "p1", root: rootA, nesting: false });
    await rt.release("p1");
    await rt.release("p1", { stop: true });
    assert.equal(state().instances["banto-p1"]!.status, "Stopped", "接続が無いときにコンテナを止めていない");
    // 起こす：次に使うときにコンテナを起こす（装置はそのまま）
    await rt.prepare({ id: "p2", root: rootB, nesting: false });
    assert.equal(state().instances["banto-p2"]!.status, "Running");
    assert.equal(state().instances["banto-p2"]!.devices["banto-relay"]?.["connect"], `unix:${tunnelB}`);
    // 眠っている Project（接続も手放した）の公開は確かめられない（投げる——公開の実装は道に触らない。道は Incus の設定なので残る）。
    // 眠っている間に p1 が新しく公開しても、眠っている p2 の番号は選ばない
    await rt.release("p2", { stop: true });
    await assert.rejects(rt.address("p2", 3000), /繋いでいないので/);
    assert.ok(state().instances["banto-p2"]!.devices["banto-pub-3000"]);
    await rt.prepare({ id: "p1", root: rootA, nesting: false });
    const pubA2 = (await rt.address("p1", 4000)) as { port: number };
    assert.ok(![vmPortA, pubB.port, 20000, 20001].includes(pubA2.port), `使っている・眠っている Project の番号を選んだ：${pubA2.port}`);
    // 繋いでいてコンテナが止まっている（人が止めた等）：届かないと値で返し（公開の実装は 503 にする）、道は残す
    const s1 = JSON.parse(readFileSync(join(root, "incus.json"), "utf8"));
    s1.instances["banto-p1"].status = "Stopped";
    writeFileSync(join(root, "incus.json"), JSON.stringify(s1));
    assert.match((await rt.address("p1", 4000) as { unavailable: string }).unavailable, /動いていません/);
    assert.equal(state().instances["banto-p1"]!.devices["banto-pub-4000"]?.["listen"], `tcp:0.0.0.0:${pubA2.port}`);
    s1.instances["banto-p1"].status = "Running";
    writeFileSync(join(root, "incus.json"), JSON.stringify(s1));
    // 公開をやめる：その道だけを外す
    await rt.releasePublishedPort("p1", 3000);
    assert.equal(state().instances["banto-p1"]!.devices["banto-pub-3000"], undefined, "公開をやめたのに道が残っている");
    assert.ok(state().instances["banto-p1"]!.devices["banto-pub-4000"], "ほかの公開の道まで外した");
    // 閉じるとき：その Project の公開の道を全部外す（ほかの装置は残す）
    await rt.releasePublishedPort("p1");
    assert.ok(!Object.keys(state().instances["banto-p1"]!.devices).some((d) => d.startsWith("banto-pub-")), "閉じたのに公開の道が残っている");
    assert.ok(state().instances["banto-p1"]!.devices["banto-relay"], "公開でない道まで外した");
    // 閉じた Project の公開（レビュー H1）：確かに届かないと返し（公開の実装は Caddy の道を 503 にする——繋がずに）、外したばかりの
    // 番号はほかの Project にすぐは渡さない——閉じた p1 の公開の URL（p1 の認証の設定）が、同じ番号を受けた p2 のサービスへ向かない
    closed.add("p1");
    writeFileSync(incusLog, "");
    assert.match(((await rt.address("p1", 4000)) as { unavailable: string }).unavailable, /閉じています/);
    assert.match(((await rt.address("p1", 3000)) as { unavailable: string }).unavailable, /閉じています/);
    assert.equal(readFileSync(incusLog, "utf8"), "", "閉じた Project の公開を確かめるのに VM に聞きに行った");
    await rt.prepare({ id: "p2", root: rootB, nesting: false });
    const pubB2 = (await rt.address("p2", 5000)) as { port: number };
    assert.ok(![vmPortA, pubA2.port].includes(pubB2.port), `外したばかりの番号（${vmPortA}・${pubA2.port}）をすぐにほかの Project に渡した：${pubB2.port}`);
  } finally {
    await rt.closeAll();
    for (const m of masters) m.kill("SIGKILL");
    for (const s of servers) s.close();
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("VM だけの場所：Project の id はパスに使える字だけ（でなければ断る）", () => {
  assert.equal(vmProjectRunDir("/run/user/1001", "0b6e8c2a-1f3d-4e5a-9b7c-123456789abc"), "/run/user/1001/banto/p-0b6e8c2a-1f3d-4e5a-9b7c-123456789abc");
  for (const bad of ["../x", "a/b", "", "-x", "a b"]) assert.throws(() => vmProjectRunDir("/run/user/1001", bad), /作れません/, bad);
});
