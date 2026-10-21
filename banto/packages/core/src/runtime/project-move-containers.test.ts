// **`containers` との間で Project を移す**（v4-security.md §1「`containers` との間で移す」、Backlog #464）。
//
// 偽の ssh（node）は宛先ごとに HOME を替えて、向こうのコマンドをこの機械の sh で流し、流した台本を出来事の記録に残す。偽の incus
// （状態をファイルに持つ）は、コンテナの中で流すもの（`incus exec`）をこの機械で本当に走らせ、誰として流したか（`--user` の有無）を
// 記録する。**中から触るフォルダ（`tar -C <dir>`・`cd -- <dir>`）は、装置で見せてあり、見せたときと同じ inode のものだけ**——見せる
// 前に展開すれば失敗する。rsync は本物（この機械の rsync）を偽の ssh・偽の incus の上で走らせる——`--rsync-path` に渡した
// `incus exec … rsync` が受け手として本当に起きるかを見る（本物の Incus の上で往復が素通しになるかは測っていない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { containerNameFor } from "@banto/container";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectState } from "../project-thread/types.js";
import { cleanupContainerScript, inodePairsScript, parseInodePairs } from "./remote-containers.js";
import { remoteOwnerDirName } from "./remote-ssh.js";
import { ProjectMover, containersRootScript, type MoveProgress } from "./project-move.js";

const FAKE_SSH = String.raw`#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const a = process.argv.slice(2);
let i = 0;
// ssh の引数はどれも値を取る（-F -o -i -p -l）。rsync の -e は "--" を付けずに宛先とコマンドを足す
while (i < a.length) { if (a[i] === "--") { i++; break; } if (a[i].startsWith("-")) { i += 2; continue; } break; }
const host = a[i++];
const rest = a.slice(i).join(" ");
const homes = __HOMES__;
if (!(host in homes)) { process.stderr.write("知らない宛先 " + host + "\n"); process.exit(255); }
const env = { ...process.env, HOME: homes[host] };
const fromStdin = rest === "sh -s";
const script = fromStdin ? fs.readFileSync(0, "utf8") : rest;
fs.appendFileSync("__EVENTS__", JSON.stringify({ ssh: host, script }) + "\n");
const r = spawnSync("sh", ["-c", script], { stdio: fromStdin ? ["ignore", "inherit", "inherit"] : "inherit", env, cwd: homes[host] });
process.exit(r.status ?? 255);
`;

const FAKE_INCUS = String.raw`#!/usr/bin/env node
const fs = require("fs");
const { spawnSync } = require("child_process");
const statePath = "__STATE__";
const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(statePath, JSON.stringify(st));
const ev = (o) => fs.appendFileSync("__EVENTS__", JSON.stringify(o) + "\n");
const out = (s) => { process.stdout.write(s); save(); process.exit(0); };
const die = (s) => { process.stderr.write(s + "\n"); save(); process.exit(1); };
const [cmd, ...rest] = args;
const inst = (n) => st.instances[n];
if (cmd === "list") { const i = inst(rest[0].replace(/^\^|\$$/g, "")); out(i ? i.status.toUpperCase() + "\n" : ""); }
if (cmd === "config" && rest[0] === "get") { const i = inst(rest[1]); if (!i) die("Error: Instance not found"); out((i.config[rest[2]] ?? "") + "\n"); }
if (cmd === "start") { ev({ incus: "start", name: rest[0] }); inst(rest[0]).status = "Running"; out(""); }
if (cmd === "stop") { ev({ incus: "stop", name: rest[0] }); inst(rest[0]).status = "Stopped"; out(""); }
if (cmd === "delete") { ev({ incus: "delete", name: rest[0] }); delete st.instances[rest[0]]; out(""); }
if (cmd === "exec") {
  const name = rest[0];
  const i = inst(name);
  if (!i) die("Error: Instance not found");
  if (i.status !== "Running") die("Error: Instance is not running");
  const dash = rest.indexOf("--");
  const opts = rest.slice(1, dash);
  const argv = rest.slice(dash + 1);
  const user = opts.includes("--user") ? opts[opts.indexOf("--user") + 1] : null;
  // 中から見たフォルダの inode：そのパスに付いている装置の、付けたときのもの（bind mount と同じ）
  if (argv[0] === "stat") {
    const p = argv[argv.length - 1];
    const d = Object.values(i.devices).find((x) => x.path === p);
    if (!d) die("stat: cannot statx '" + p + "': No such file or directory");
    out(d.ino + "\n");
  }
  const script = argv[0] === "/bin/sh" && argv[1] === "-c" ? argv[2] : argv.join(" ");
  ev({ incus: "exec", name, user, script });
  // 動いているものを数える台本は、この機械の systemd・tmux を見ない（何も動いていない）
  if (script.includes("banto-terminal")) out("");
  if (st.failTar && /-xpf/.test(script)) die("tar: 偽の失敗");
  // 中から触るフォルダは、見せてあって、見せたときと同じフォルダだけ
  const shown = (p) => Object.values(i.devices).some((d) => d.path === p && fs.existsSync(p) && fs.statSync(p).ino === d.ino);
  for (const m of script.matchAll(/(?:tar -C|cd --) '([^']+)'/g)) if (!shown(m[1])) die("見せていないフォルダです：" + m[1]);
  const env = { ...process.env };
  for (let k = 0; k < opts.length; k++) if (opts[k] === "--env") { const kv = opts[k + 1]; env[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); }
  save();
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
die("偽の incus は " + args.join(" ") + " を知らない");
`;

interface Instance {
  status: "Running" | "Stopped";
  config: Record<string, string>;
  devices: Record<string, { path: string; ino: number }>;
}

type Event =
  | { ssh: string; script: string }
  | { incus: "start" | "stop" | "delete"; name: string }
  | { incus: "exec"; name: string; user: string | null; script: string }
  | { release: boolean }
  | { prepare: string; root: string; dirs: string[] }
  | { closeTarget: string };

const { uid, gid } = userInfo();

function harness() {
  const root = mkdtempSync("/tmp/banto-move-ct-");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const vmHome = join(root, "vm", "home");
  const mHome = join(root, "m", "home");
  for (const d of [bin, dataDir, vmHome, mHome, join(root, "claude")]) mkdirSync(d, { recursive: true });
  const events = join(root, "events.log");
  const statePath = join(root, "incus.json");
  writeFileSync(events, "");
  writeFileSync(statePath, JSON.stringify({ instances: {} }));
  writeFileSync(
    join(bin, "ssh"),
    FAKE_SSH.replace("__HOMES__", JSON.stringify({ "vm.example": vmHome, "m.example": mHome })).replace("__EVENTS__", events),
  );
  writeFileSync(join(bin, "incus"), FAKE_INCUS.replace("__STATE__", statePath).replace("__EVENTS__", events));
  // 動いているものを数える台本が、この機械の systemd・tmux を見ないように（何も動いていない）
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 1\n");
  for (const f of ["ssh", "incus", "systemctl", "tmux"]) chmodSync(join(bin, f), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const vmData = join(vmHome, ".banto-remote");
  const mData = join(mHome, ".banto-remote");
  /** 向こうの、この banto の置き場（`<置き場の根>/<印>`） */
  const vmBase = join(vmData, remoteOwnerDirName(dataDir));
  const mBase = join(mData, remoteOwnerDirName(dataDir));
  const runtimes: Record<string, Record<string, unknown>> = {
    vm: { name: "vm", host: "vm.example", port: 22, user: "u", hostKey: { type: "ssh-ed25519" }, dataRoot: vmData, mode: "containers", usedBy: [] },
    m: { name: "m", host: "m.example", port: 22, user: "u", hostKey: { type: "ssh-ed25519" }, dataRoot: mData, mode: "machine", usedBy: [] },
  };
  const ev = (o: Event) => appendFileSync(events, `${JSON.stringify(o)}\n`);
  const state = (): { instances: Record<string, Instance>; failTar?: boolean } => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (f: (s: ReturnType<typeof state>) => void) => {
    const s = state();
    f(s);
    writeFileSync(statePath, JSON.stringify(s));
  };
  /** 装置で見せる（付けたときの inode を覚える——bind mount と同じ） */
  const mount = (name: string, dirs: readonly string[]) =>
    setState((s) => {
      const i = s.instances[name]!;
      for (const d of dirs) i.devices[d === dirs[0] ? "project" : `m-${d.split("/").pop()}`] = { path: d, ino: statSync(d).ino };
    });
  const projects = new Map<string, ProjectState>();
  const store = {
    getProject: (id: string) => projects.get(id),
    listProjects: () => [...projects.values()],
    listThreadsForProject: () => [],
    runnerCwd: (p: { root: string }) => p.root,
    async startRuntimeMove(id: string, m: { from: unknown; to: unknown; created: unknown }) {
      const p = projects.get(id)!;
      p.move = { ...(m as NonNullable<ProjectState["move"]>), startedAt: new Date().toISOString() };
      return p;
    },
    async finishRuntimeMove(id: string, m: { from: { runtime: string; root: string }; to: { runtime: string; root: string } }) {
      const p = projects.get(id)!;
      p.runtime = m.to.runtime;
      p.root = m.to.root;
      delete p.move;
      p.previousLocations = [
        ...(p.previousLocations ?? []).filter((l) => !(l.runtime === m.to.runtime && l.root === m.to.root)),
        { ...m.from, movedAt: new Date().toISOString() },
      ];
    },
    async failRuntimeMove(id: string, reason: string) {
      const p = projects.get(id)!;
      delete p.move;
      (p as unknown as { failed: string }).failed = reason;
    },
  };
  const mover = new ProjectMover({
    dataDir,
    monorepoRoot: join(root, "repo"),
    claudeConfigDir: join(root, "claude"),
    projectThread: store as unknown as ProjectThreadStore,
    remoteRuntimes: {
      get: (name: string) => runtimes[name],
      exclusive: <T>(_name: string, fn: () => Promise<T>) => fn(),
      withConnection: <T>(name: string, fn: (r: unknown, files: unknown) => Promise<T>) =>
        fn(runtimes[name], { knownHostsFile: "/dev/null", agentSocket: "/dev/null", publicKeyFile: "/dev/null" }),
    } as never,
    hostContainers: { runInside: async () => undefined, stopProjectContainer: async () => undefined },
    hostActivity: () => [],
    disableServices: async () => [],
    releaseModules: async (projectId, opts) => {
      const stop = opts?.stopContainer ?? true;
      ev({ release: stop });
      // release(stop) の代わり：その Project のコンテナを止める（containers の元のとき）
      const name = containerNameFor(projectId);
      if (stop && state().instances[name] && projects.get(projectId)?.runtime === "remote:vm") setState((s) => (s.instances[name]!.status = "Stopped"));
    },
    revokeClaudeLogin: () => undefined,
    deliver: async () => undefined,
    kick: () => undefined,
    notify: async () => undefined,
    log: () => undefined,
    containers: {
      // 作るときと同じ手の代わり：無ければ作り、起こし、根と Module の置き場を見せる
      async prepareTarget(runtimeName, projectId, targetRoot, moduleDirs) {
        ev({ prepare: runtimeName, root: targetRoot, dirs: [...moduleDirs] });
        for (const d of [targetRoot, ...moduleDirs]) assert.ok(existsSync(d), `見せる前に元のフォルダが無い：${d}`);
        const name = containerNameFor(projectId);
        setState((s) => {
          s.instances[name] ??= { status: "Stopped", config: { "user.banto.owner": dataDir, "user.banto.project": projectId }, devices: {} };
          s.instances[name]!.status = "Running";
        });
        mount(name, [targetRoot, ...moduleDirs]);
        return { container: name, inside: { uid, gid } };
      },
      async closeTarget(runtimeName) {
        ev({ closeTarget: runtimeName });
      },
    },
  });
  const read = (): Event[] =>
    readFileSync(events, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Event);
  const settle = async (id: string): Promise<MoveProgress> => {
    for (let i = 0; i < 1200; i++) {
      const p = mover.status(id).progress;
      if (p && (p.phase === "done" || p.phase === "failed")) return p;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("移し終わらない");
  };
  const add = (p: Partial<ProjectState> & { id: string; root: string; runtime: string }) =>
    projects.set(p.id, { name: p.id, status: "active", ...p } as unknown as ProjectState);
  const close = () => {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, dataDir, vmHome, mHome, vmBase, mBase, mover, projects, add, state, setState, mount, read, settle, close };
}

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

/** git の作業ツリー（中に worktree を1つ）と、ふつうのファイル */
function makeProjectTree(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.txt"), "あ\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "1");
  git(dir, "worktree", "add", "-q", ".worktrees/w1", "-b", "w1");
}

/** VM のユーザーが流した台本のうち、見せたフォルダに書くもの（展開・印・repair・rsync の受け手）を中を通さずにしたもの */
function vmWritesOutside(events: Event[], host: string): string[] {
  return events
    .filter((e): e is { ssh: string; script: string } => "ssh" in e && e.ssh === host)
    // 流す口（`spawn`）は `sh -c '<台本>'` で包む——sh に解かせて中身を見る
    .map((e) =>
      e.script.startsWith("sh -c ")
        ? spawnSync("sh", ["-c", 'eval "set -- $1"; printf %s "$1"', "_", e.script.slice("sh -c ".length)], { encoding: "utf8" }).stdout
        : e.script,
    )
    .filter((s) => /-xpf|worktree repair|> '[^']*\.banto-moved\.json'|rsync --server/.test(s))
    .filter((s) => !/^(exec )?'?incus'? '?exec'? /.test(s.trimStart()));
}

test("containers へ移す：根は正規化して1段ずつ作り、started の後に装置を見せてから、展開・印・git worktree repair を中のユーザーで", async () => {
  const h = harness();
  try {
    const src = join(h.root, "src", "proj");
    makeProjectTree(src);
    // Module の置き場（この機械）：Shell のホームとソケットの置き場は写さない
    const shell = join(h.dataDir, "modules", "shell-p1");
    mkdirSync(join(shell, "home"), { recursive: true });
    mkdirSync(join(shell, "s"), { recursive: true });
    writeFileSync(join(shell, "home", "x"), "写さない");
    writeFileSync(join(shell, "state.json"), "{}");
    h.add({ id: "p1", root: src, runtime: "host-container" });

    // 見積もり：containers を選べる・閉じ込めの注意は出さない（移った先もコンテナ）
    const est = await h.mover.estimate("p1", { runtime: "remote:vm", root: "~/work/a" });
    assert.deepEqual(est.blockers, []);
    assert.equal(est.confinementNote, undefined);

    await h.mover.start("p1", { runtime: "remote:vm", root: "~/work/a" });
    const p = await h.settle("p1");
    assert.equal(p.phase, "done", p.reason);
    const to = join(h.vmHome, "work", "a");
    const project = h.projects.get("p1")!;
    assert.equal(project.runtime, "remote:vm");
    assert.equal(project.root, to);
    // 写したもの（ホームは写さない）・中で書いた印
    assert.equal(readFileSync(join(to, "a.txt"), "utf8"), "あ\n");
    const shellTo = join(h.vmBase, "modules", "shell-p1");
    assert.equal(readFileSync(join(shellTo, "state.json"), "utf8"), "{}");
    assert.ok(!existsSync(join(shellTo, "home")), "Shell のホームを写した");
    assert.match(readFileSync(join(shellTo, ".banto-moved.json"), "utf8"), /"remote:vm"/);
    // 根は 1段ずつ作った（mkdir -m 700）——途中の段は 700 のまま。根そのものは、そのあと展開（tar -xpf）が元の根の mode に
    // そろえる。元の根の mode は試験を流す機械の umask で変わる（GitHub のランナーは 022 で 755、この開発機は 077 で 700）ので、
    // 決め打ちの 700 ではなく元と同じかを見る（2026-10-20、GitHub でだけ落ちた）
    assert.equal(statSync(join(h.vmHome, "work")).mode & 0o777, 0o700);
    assert.equal(statSync(to).mode & 0o777, statSync(src).mode & 0o777);
    // git worktree repair の結果：偽の VM はこの機械なので元の根も見える。それでも元の worktree の印は変えず、写した先の印が
    // 写した先を指す（#467。以前の git 2.43 の repair は元のほうを直していた——docs/notes/2026-10-20-containers-move.md）
    assert.equal(readFileSync(join(src, ".git", "worktrees", "w1", "gitdir"), "utf8"), `${src}/.worktrees/w1/.git\n`, "元の worktree の印を書き換えた");
    assert.equal(readFileSync(join(src, ".worktrees", "w1", ".git"), "utf8"), `gitdir: ${src}/.git/worktrees/w1\n`, "元の worktree の印を書き換えた");
    assert.equal(readFileSync(join(to, ".git", "worktrees", "w1", "gitdir"), "utf8"), `${to}/.worktrees/w1/.git\n`);
    assert.equal(readFileSync(join(to, ".worktrees", "w1", ".git"), "utf8"), `gitdir: ${to}/.git/worktrees/w1\n`);

    const events = h.read();
    const prepare = events.findIndex((e) => "prepare" in e);
    const exec = (e: Event): e is { incus: "exec"; name: string; user: string | null; script: string } => "incus" in e && e.incus === "exec";
    const extracts = events.flatMap((e, i) => (exec(e) && /-xpf/.test(e.script) ? [{ e, i }] : []));
    assert.ok(prepare >= 0, "移す先のコンテナを用意していない");
    assert.deepEqual((events[prepare] as { dirs: string[] }).dirs, [shellTo], "写す Module の置き場を全部見せていない");
    assert.equal(extracts.length, 2, "根と Module の置き場を中で展開していない");
    for (const { e, i } of extracts) {
      assert.ok(i > prepare, "装置を見せる前に展開した");
      assert.equal(e.user, String(uid), "展開を中のユーザーでしていない");
      assert.match(e.script, /^exec tar -C '.*' --no-same-owner -xpf -$/);
    }
    const repair = events.find((e) => exec(e) && /worktree repair/.test(e.script));
    assert.ok(repair && exec(repair) && repair.user === String(uid), "git worktree repair を中のユーザーでしていない");
    const marker = events.find((e) => exec(e) && /\.banto-moved\.json/.test(e.script));
    assert.ok(marker && exec(marker) && marker.user === String(uid), "移した印を中のユーザーで書いていない");
    assert.deepEqual(vmWritesOutside(events, "vm.example"), [], "VM のユーザーが見せたフォルダに書いた");
    // 成功したら接続はそのまま使う（閉じない）・コンテナは残る
    assert.ok(!events.some((e) => "closeTarget" in e));
    assert.equal(h.state().instances["banto-p1"]?.status, "Running");
  } finally {
    h.close();
  }
});

test("containers から移す：Module を畳むだけでコンテナは止めず、止まっていれば起こし、中の root で読み、読み終えてから止める", async () => {
  const h = harness();
  try {
    const from = join(h.vmHome, "work", "b");
    makeProjectTree(from);
    const shell = join(h.vmBase, "modules", "shell-p2");
    mkdirSync(join(shell, "home"), { recursive: true });
    writeFileSync(join(shell, "state.json"), "{}");
    writeFileSync(join(shell, "home", "x"), "写さない");
    h.add({ id: "p2", root: from, runtime: "remote:vm" });
    // 止まっているコンテナ（banto を起こし直したあと等）。装置はそのまま
    h.setState((s) => (s.instances["banto-p2"] = { status: "Stopped", config: { "user.banto.owner": h.dataDir }, devices: {} }));
    h.mount("banto-p2", [from, shell]);

    // 見積もりでは起こさない——大きさは「起こしたあとに数えます」
    const est = await h.mover.estimate("p2", { runtime: "remote:m", root: "~/p2" });
    assert.deepEqual(est.blockers, []);
    assert.match(est.sizeNote ?? "", /起こしたあとに数えます/);
    assert.deepEqual(est.size, { bytes: 0, files: 0 });
    assert.equal(h.state().instances["banto-p2"]?.status, "Stopped", "見積もりでコンテナを起こした");

    await h.mover.start("p2", { runtime: "remote:m", root: "~/p2" });
    const p = await h.settle("p2");
    assert.equal(p.phase, "done", p.reason);
    const to = join(h.mHome, "p2");
    assert.equal(h.projects.get("p2")!.root, to);
    assert.equal(readFileSync(join(to, "a.txt"), "utf8"), "あ\n");
    assert.equal(readFileSync(join(h.mBase, "modules", "shell-p2", "state.json"), "utf8"), "{}");

    const events = h.read();
    const at = (pred: (e: Event) => boolean) => events.findIndex(pred);
    const releaseKeep = at((e) => "release" in e && e.release === false);
    const start = at((e) => "incus" in e && e.incus === "start");
    const reads = events.flatMap((e, i) => ("incus" in e && e.incus === "exec" && /-cf - \.$/.test(e.script) ? [{ e, i }] : []));
    const releaseStop = at((e) => "release" in e && e.release === true);
    assert.ok(releaseKeep >= 0 && releaseKeep < start, "Module を畳むときにコンテナを止めた（か、起こす前に畳んでいない）");
    assert.equal(reads.length, 2);
    for (const { e, i } of reads) {
      assert.ok(i > start && i < releaseStop, "起こす前に読んだ・止めたあとに読んだ");
      assert.equal((e as { user: string | null }).user, null, "移す元を中の root で読んでいない");
    }
    assert.equal(h.state().instances["banto-p2"]?.status, "Stopped", "読み終えたあとコンテナを止めていない");
    assert.ok(h.state().instances["banto-p2"], "元のコンテナを消した");
    // 元は残す
    assert.ok(existsSync(join(from, "a.txt")));
  } finally {
    h.close();
  }
});

test("containers へ移せなかった：その実行場所に居たことが無ければコンテナを消し、作った根を消し、接続を閉じる", async () => {
  const h = harness();
  try {
    const src = join(h.root, "src", "proj");
    makeProjectTree(src);
    h.add({ id: "p3", root: src, runtime: "host-container" });
    h.setState((s) => (s.failTar = true));
    await h.mover.start("p3", { runtime: "remote:vm", root: "~/work/c" });
    const p = await h.settle("p3");
    assert.equal(p.phase, "failed");
    assert.match(p.reason ?? "", /移す先の banto が作ったものは消しました/);
    assert.equal(h.projects.get("p3")!.runtime, "host-container", "切り替えた");
    assert.ok(!existsSync(join(h.vmHome, "work", "c")), "作った根が残っている");
    const events = h.read();
    assert.ok(events.some((e) => "closeTarget" in e), "移す先の接続を閉じていない");
    assert.ok(events.some((e) => "incus" in e && e.incus === "delete" && e.name === "banto-p3"), "作ったコンテナを消していない");
    assert.equal(h.state().instances["banto-p3"], undefined);
  } finally {
    h.close();
  }
});

test("containers へ移せなかった：その実行場所に居たことがあればコンテナは止めて残し、止めてから退かせた置き場を戻す", async () => {
  const h = harness();
  try {
    const src = join(h.root, "src", "proj");
    makeProjectTree(src);
    mkdirSync(join(h.dataDir, "modules", "shell-p4"), { recursive: true });
    writeFileSync(join(h.dataDir, "modules", "shell-p4", "state.json"), "{}");
    // 前に居た VM の置き場（前のコンテナが装置で掴んでいる）
    const old = join(h.vmBase, "modules", "shell-p4");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "old.json"), "前のもの");
    const oldRoot = join(h.vmHome, "old");
    mkdirSync(oldRoot, { recursive: true });
    h.add({ id: "p4", root: src, runtime: "host-container", previousLocations: [{ runtime: "remote:vm", root: oldRoot, movedAt: "2026-10-01T00:00:00Z" }] });
    h.setState((s) => (s.instances["banto-p4"] = { status: "Stopped", config: { "user.banto.owner": h.dataDir }, devices: {} }));
    h.mount("banto-p4", [oldRoot, old]);
    h.setState((s) => (s.failTar = true));

    await h.mover.start("p4", { runtime: "remote:vm", root: "~/work/d" });
    const p = await h.settle("p4");
    assert.equal(p.phase, "failed", p.reason);
    // 退かせた置き場は元の名前に戻っている（中身もそのまま）
    assert.equal(readFileSync(join(old, "old.json"), "utf8"), "前のもの");
    assert.deepEqual(readdirSync(join(h.vmBase, "modules")).filter((n) => n.includes(".before-")), []);
    const events = h.read();
    const stop = events.findIndex((e) => "incus" in e && e.incus === "stop" && e.name === "banto-p4");
    const putBack = events.map((e) => "ssh" in e && /mv -- '.*\.before-.*' '.*shell-p4'/.test(e.script)).lastIndexOf(true);
    assert.ok(stop >= 0, "前からあったコンテナを止めていない");
    assert.ok(putBack > stop, "コンテナを止める前に置き場を戻した");
    assert.ok(!events.some((e) => "incus" in e && e.incus === "delete"), "前からあったコンテナを消した");
    assert.equal(h.state().instances["banto-p4"]?.status, "Stopped");
  } finally {
    h.close();
  }
});

test("containers の前に居た場所へ戻す：rsync の受け手は incus exec で中のユーザー。差分（--dry-run）は測らない", async () => {
  const h = harness();
  try {
    // いまは machine の m に居て、前は vm の work/e に居た
    const now = join(h.mHome, "p5");
    makeProjectTree(now);
    writeFileSync(join(now, "new.txt"), "向こうで足した\n");
    mkdirSync(join(h.mBase, "modules", "backlog-p5"), { recursive: true });
    writeFileSync(join(h.mBase, "modules", "backlog-p5", "tasks.json"), "[1]");
    const back = join(h.vmHome, "work", "e");
    mkdirSync(back, { recursive: true });
    writeFileSync(join(back, "gone.txt"), "消えるもの\n");
    const backModule = join(h.vmBase, "modules", "backlog-p5");
    mkdirSync(backModule, { recursive: true });
    writeFileSync(join(backModule, "tasks.json"), "[]");
    h.add({ id: "p5", root: now, runtime: "remote:m", previousLocations: [{ runtime: "remote:vm", root: back, movedAt: "2026-10-01T00:00:00Z" }] });
    h.setState((s) => (s.instances["banto-p5"] = { status: "Stopped", config: { "user.banto.owner": h.dataDir }, devices: {} }));

    const est = await h.mover.estimate("p5", { runtime: "remote:vm", root: "~/work/e" });
    assert.ok(est.returning, "前に居た場所と見ていない");
    assert.equal(est.returning.diff, undefined, "containers が絡むのに差分を測った");
    assert.ok(est.returning.overwritten.count > 0);

    await h.mover.start("p5", { runtime: "remote:vm", root: "~/work/e", acknowledgeOverwrite: true });
    const p = await h.settle("p5");
    assert.equal(p.phase, "done", p.reason);
    assert.equal(readFileSync(join(back, "new.txt"), "utf8"), "向こうで足した\n");
    assert.ok(!existsSync(join(back, "gone.txt")), "--delete でそろえていない");
    assert.equal(readFileSync(join(backModule, "tasks.json"), "utf8"), "[1]");
    const events = h.read();
    const receivers = events.filter((e) => "incus" in e && e.incus === "exec" && /^rsync --server/.test(e.script));
    assert.equal(receivers.length, 2, "rsync の受け手を中で起こしていない");
    for (const r of receivers) {
      assert.equal((r as { user: string | null }).user, String(uid), "rsync の受け手を中のユーザーで起こしていない");
      assert.ok(!/--sender/.test((r as { script: string }).script));
    }
    // 中に rsync があるかを確かめた（あれば入れない）
    assert.ok(events.some((e) => "incus" in e && e.incus === "exec" && e.user === null && /command -v rsync/.test(e.script)));
    assert.deepEqual(vmWritesOutside(events, "vm.example"), [], "VM のユーザーが見せたフォルダに書いた");
    assert.ok(!events.some((e) => "ssh" in e && /--dry-run|rsync --server -[a-zA-Z]*n/.test(e.script)), "差分を測った");
  } finally {
    h.close();
  }
});

test("containers の移す先の根：存在する最も深い親を正規化し、まだ無い段を後ろに付ける。symlink の切れ端・フォルダでないものは断る", () => {
  const dir = mkdtempSync("/tmp/banto-ct-root-");
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "real"), { recursive: true });
    symlinkSync(join(home, "real"), join(home, "link"));
    writeFileSync(join(home, "file"), "");
    symlinkSync(join(home, "nowhere"), join(home, "dangling"));
    mkdirSync(join(home, "real", "full"));
    writeFileSync(join(home, "real", "full", "x"), "");
    const run = (root: string) => spawnSync("sh", ["-c", containersRootScript(root, "~/.banto-remote")], { encoding: "utf8", env: { ...process.env, HOME: home } });
    const missing = run("~/link/new/deeper/");
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, new RegExp(`^root=${join(home, "real", "new", "deeper")}$`, "m"));
    assert.match(missing.stdout, /^state=missing$/m);
    assert.match(missing.stdout, new RegExp(`^home=${home}$`, "m"));
    assert.match(missing.stdout, new RegExp(`^data=${join(home, ".banto-remote")}$`, "m"));
    mkdirSync(join(home, "real", "empty"));
    assert.match(run(join(home, "link", "empty")).stdout, /^state=empty$/m);
    assert.match(run(join(home, "real", "full")).stdout, /^state=nonempty$/m);
    assert.equal(run(join(home, "file", "x")).status, 3);
    assert.equal(run(join(home, "dangling", "x")).status, 3);
    assert.equal(run("relative/x").status, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("移す先のコンテナの片づけ：その banto の札のものだけに触る。無い・札が違うなら何もしない", () => {
  const dir = mkdtempSync("/tmp/banto-ct-cleanup-");
  try {
    const log = join(dir, "log");
    writeFileSync(
      join(dir, "incus"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in\n  list) [ -n "$ST" ] && echo "$ST"; exit 0 ;;\n  config) echo "$OWNER" ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(dir, "incus"), 0o755);
    const run = (action: "remove" | "stop", st: string, owner: string) => {
      writeFileSync(log, "");
      const r = spawnSync("sh", ["-c", cleanupContainerScript("banto-p1", "/data", action)], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ST: st, OWNER: owner },
      });
      return { out: r.stdout.trim(), calls: readFileSync(log, "utf8") };
    };
    assert.deepEqual(run("remove", "", "/data").out, "ct=none");
    const foreign = run("remove", "RUNNING", "/other");
    assert.equal(foreign.out, "ct=foreign");
    assert.ok(!/delete|stop/.test(foreign.calls));
    const removed = run("remove", "STOPPED", "/data");
    assert.equal(removed.out, "ct=removed");
    assert.match(removed.calls, /^delete banto-p1 --force$/m);
    const stopped = run("stop", "RUNNING", "/data");
    assert.equal(stopped.out, "ct=stopped");
    assert.match(stopped.calls, /^stop banto-p1 --timeout 20$/m);
    assert.ok(!/delete/.test(stopped.calls));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("中から見えるかの台本：VM と中の inode を1行ずつ。中で引けなければ空", () => {
  assert.match(inodePairsScript("banto-p1", ["/a b"]), /stat -c %i -- '\/a b'.*incus exec 'banto-p1' -- stat -c %i -- '\/a b'/);
  assert.deepEqual(parseInodePairs("0=12:12\n1=13:\n", 3), [{ vm: "12", inside: "12" }, { vm: "13" }, {}]);
});
