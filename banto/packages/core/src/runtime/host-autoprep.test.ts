import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { IncusResult } from "@banto/container";
import {
  aptUsable,
  cloudInitWait,
  commonFixes,
  dockerFixCommands,
  markAutoFixes,
  mayInstallDocker,
  runFixes,
  runRootCommand,
  SSHD_CONF,
  sshdFix,
  AutoFixError,
  SUDO,
  type RootRun,
} from "./host-autoprep.js";
import { installDockerOnMachine, probePrerequisites, type BaseProbe, type RuntimeCheck } from "./ssh.js";

const values = (over: Record<string, string> = {}) =>
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
      "tool.git": "1",
      "tool.ssh": "1",
      "tool.curl": "1",
      "tool.tar": "1",
      "tool.tmux": "1",
      "tool.rsync": "1",
      "tool.docker": "0",
      uid: "1000",
      user: "banto",
      gid: "1000",
      home: "/home/banto",
      bus: "1",
      linger: "1",
      root: "/home/banto/.local/share/banto-remote",
      writable: "1",
      docker: "0",
      maxsessions: "10",
      ...over,
    }),
  );

const allForwarding = { tcp: true, streamLocal: true };

test("commonFixes：足りないものだけを、1回の apt でまとめて入れる（machine は tmux・rsync も）", () => {
  const fixes = commonFixes({
    values: values({ "tool.git": "0", "tool.ssh": "0", "tool.tmux": "0" }),
    forwarding: allForwarding,
    mode: "machine",
    requiredTools: ["git", "ssh", "curl", "tar"],
  });
  assert.deepEqual(fixes.map((f) => f.id), ["tools", "tmux"]);
  const install = fixes[0]!.commands[1]!.args;
  assert.deepEqual(install.slice(-3), ["git", "openssh-client", "tmux"]);
  assert.equal(fixes[0]!.commands, fixes[1]!.commands, "同じ apt を項目ごとに分けない");
});

test("commonFixes：apt の無い OS では道具を入れない。置き場・sshd・linger・ユーザーの systemd は入れる", () => {
  const fixes = commonFixes({
    values: values({ apt: "0", "os.id": "fedora", "os.like": "", "tool.git": "0", writable: "0", linger: "0", bus: "0", maxsessions: "5" }),
    forwarding: { tcp: false, streamLocal: true },
    mode: "machine",
    requiredTools: ["git", "ssh", "curl", "tar"],
  });
  assert.deepEqual(fixes.map((f) => f.id), ["data-root", "sshd", "linger", "user-systemd"]);
  assert.deepEqual(fixes[0]!.commands[0]!.args, ["install", "-d", "-o", "banto", "-g", "1000", "-m", "0700", "/home/banto/.local/share/banto-remote"]);
  assert.deepEqual(fixes[1]!.commands.map((c) => c.args), [["tee", SSHD_CONF], ["sshd", "-t"], ["systemctl", "reload", "ssh.service"]]);
  assert.deepEqual(fixes[3]!.commands.map((c) => c.args), [
    ["loginctl", "enable-linger", "banto"],
    ["systemctl", "start", "user@1000.service"],
  ]);
  assert.equal(aptUsable(values({ "os.id": "linuxmint", "os.like": "ubuntu debian" })), true);
});

test("commonFixes：containers は道具が tar だけで、linger・ユーザーの systemd は containers の準備が持つ", () => {
  const fixes = commonFixes({
    values: values({ "tool.tar": "0", "tool.tmux": "0", linger: "0", bus: "0" }),
    forwarding: allForwarding,
    mode: "containers",
    requiredTools: ["tar"],
  });
  assert.deepEqual(fixes.map((f) => f.id), ["tools"]);
  assert.deepEqual(fixes[0]!.commands[1]!.args.slice(-1), ["tar"]);
});

test("sshd の直し：台本を使わず、tee で 00-banto.conf に3行 → sshd -t（落ちたら消して止める）→ reload（ssh、無ければ sshd）", async () => {
  const [write, check, reload] = sshdFix();
  assert.equal(SSHD_CONF, "/etc/ssh/sshd_config.d/00-banto.conf");
  assert.equal(await write!.input!(), "AllowTcpForwarding yes\nAllowStreamLocalForwarding yes\nMaxSessions 20\n");
  assert.deepEqual(check!.undoOnFail!.args, ["rm", "-f", SSHD_CONF]);
  assert.deepEqual(reload!.orElse!.args, ["systemctl", "reload", "sshd.service"]);

  // sshd -t が落ちたら、書いたものを消して止める
  const calls: Array<{ args: string[]; input?: string }> = [];
  const run: RootRun = async (args, opts) => {
    calls.push({ args: args.slice(2), ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    return args[2] === "sshd" ? { code: 255, stdout: "", stderr: "/etc/ssh/sshd_config line 3: Bad configuration option" } : { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(runFixes(run, [{ id: "sshd", commands: sshdFix() }], { labelOf: () => "sshd" }), (err: unknown) => err instanceof AutoFixError && /元に戻しました/.test(err.message));
  assert.deepEqual(calls.map((c) => c.args), [["tee", SSHD_CONF], ["sshd", "-t"], ["rm", "-f", SSHD_CONF]]);
  assert.match(calls[0]!.input!, /MaxSessions 20/);
});

test("runRootCommand：orElse は代わりを打ち、両方落ちたら両方を並べる。ignoreFailure は落ちても先へ", async () => {
  const codes: Record<string, number> = { "systemctl reload ssh.service": 5, "systemctl reload sshd.service": 0 };
  const calls: string[] = [];
  const run: RootRun = async (args) => {
    const key = args.slice(2).join(" ");
    calls.push(key);
    return { code: codes[key] ?? 0, stdout: "", stderr: codes[key] ? `${key} が無い` : "" };
  };
  const ran: Array<{ display: string; code: number }> = [];
  const [, , reload] = sshdFix();
  await runRootCommand(run, reload!, ran, { what: "" });
  assert.deepEqual(calls, ["systemctl reload ssh.service", "systemctl reload sshd.service"]);
  codes["systemctl reload sshd.service"] = 5;
  await assert.rejects(runRootCommand(run, reload!, [], { what: "" }), /reload ssh\.service が失敗しました（終了コード 5）：systemctl reload ssh\.service が無い。代わりの sudo systemctl reload sshd\.service も失敗しました（終了コード 5）/);
  codes["timeout 600 cloud-init status --wait"] = 124;
  await runRootCommand(run, cloudInitWait(), ran, { what: "" });
  assert.equal(ran.at(-1)!.code, 124);
});

test("markAutoFixes：登録の前は sudo -n が通れば断りを注意にして「登録するときに入れます」。通らなければ今どおり", () => {
  const checks: RuntimeCheck[] = [
    { id: "tools", label: "道具", status: "fail", detail: "git がありません。", fix: "sudo apt install git" },
    { id: "platform", label: "CPU", status: "fail" },
    { id: "tmux", label: "tmux", status: "warn", detail: "tmux がありません。" },
  ];
  const fixes = commonFixes({ values: values({ "tool.git": "0", "tool.tmux": "0" }), forwarding: allForwarding, mode: "machine", requiredTools: ["git"] });
  const marked = markAutoFixes(checks, fixes, "check", true);
  assert.deepEqual(marked.map((c) => c.status), ["warn", "fail", "warn"]);
  assert.match(marked[0]!.detail!, /git がありません。登録するときに banto が sudo -n で入れます。/);
  assert.match(marked[0]!.fix!, /sudo apt-get update\nsudo apt-get install --no-install-recommends git tmux/);
  assert.equal(marked[0]!.autoFix, true);
  assert.equal(marked[1]!.autoFix, undefined);
  assert.deepEqual(markAutoFixes(checks, fixes, "check", false), checks);
  const verify = markAutoFixes(checks, fixes, "verify", undefined);
  assert.equal(verify[0]!.status, "fail");
  assert.match(verify[0]!.detail!, /「確かめ直す」を押すと、banto が sudo -n で入れます/);
});

test("runFixes：sudo を絶対パスで、同じコマンドは1回だけ。落ちたらそこで止めて、何をしたかを添える", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<IncusResult> => {
    calls.push(args);
    return args.includes("install") && args.includes("--no-install-recommends") ? { code: 100, stdout: "", stderr: "E: Unable to locate package nope" } : { code: 0, stdout: "", stderr: "" };
  };
  const fixes = commonFixes({ values: values({ "tool.git": "0", "tool.tmux": "0" }), forwarding: allForwarding, mode: "machine", requiredTools: ["git"] });
  await assert.rejects(
    runFixes(run, fixes, { labelOf: (id) => `項目 ${id}` }),
    (err: unknown) =>
      err instanceof AutoFixError &&
      /「項目 tools」を整える sudo apt-get install --no-install-recommends git tmux が失敗しました（終了コード 100）：E: Unable to locate package nope/.test(err.message) &&
      err.ran.length === 2,
  );
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    [SUDO, "-n"],
    [SUDO, "-n"],
  ]);
});

/** 偽の probeBase：向こうの様子を持ち、打たれた sudo で様子を変える */
function fakeHost(v: Map<string, string>) {
  const ran: string[][] = [];
  let probes = 0;
  const base = async (): Promise<BaseProbe> => {
    probes++;
    return { probe: { before: "", values: new Map(v) }, forwarding: allForwarding, result: { code: 0, stdout: "", stderr: "" } };
  };
  const run = async (args: string[]): Promise<IncusResult> => {
    assert.equal(args[0], SUDO);
    const cmd = args.slice(2);
    ran.push(cmd);
    if (cmd.includes("install") && cmd.includes("-y")) for (const t of ["git", "tmux"]) if (cmd.includes(t)) v.set(`tool.${t}`, "1");
    if (cmd[0] === "loginctl") v.set("linger", "1");
    if (cmd[0] === "systemctl" && cmd[1] === "start") v.set("bus", "1");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { base: base as never, run, ran, probes: () => probes };
}

const target = { host: "vm", port: 22, user: "banto", identity: "k" };
const files = { knownHostsFile: "", agentSocket: "", publicKeyFile: "" };

test("machine の登録（prepare）：足りないものを入れてから確かめ直し、何をしたかを一覧の最後に出す。2回目は何もしない", async () => {
  const host = fakeHost(values({ "tool.git": "0", "tool.tmux": "0", linger: "0", bus: "0" }));
  const r = await probePrerequisites(target, files, "ssh-ed25519", "~/x", { stage: "prepare", run: host.run, base: host.base });
  assert.deepEqual(host.ran, [
    ["env", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l", "apt-get", "-o", "DPkg::Lock::Timeout=300", "update", "-q"],
    ["env", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l", "apt-get", "-o", "DPkg::Lock::Timeout=300", "install", "-y", "-q", "--no-install-recommends", "git", "tmux", "dbus-user-session"],
    ["loginctl", "enable-linger", "banto"],
    ["systemctl", "start", "user@1000.service"],
  ]);
  assert.equal(host.probes(), 2);
  assert.ok(r.checks.filter((c) => c.id !== "docker").every((c) => c.status === "ok"), JSON.stringify(r.checks));
  const prepared = r.checks.at(-1)!;
  assert.equal(prepared.id, "prepared");
  assert.match(prepared.detail!, /sudo apt-get install --no-install-recommends git tmux dbus-user-session\nsudo loginctl enable-linger banto/);

  host.ran.length = 0;
  const again = await probePrerequisites(target, files, "ssh-ed25519", "~/x", { stage: "prepare", run: host.run, base: host.base });
  assert.deepEqual(host.ran, []);
  assert.ok(!again.checks.some((c) => c.id === "prepared"));
});

test("machine：sudo -n が通らない・ログインで何か出る相手には何も打たない。登録の前（check）は何も変えない", async () => {
  for (const over of [{ sudo: "0" }, {}] as Array<Record<string, string>>) {
    const host = fakeHost(values({ "tool.git": "0", ...over }));
    const noisy = !("sudo" in over);
    const base = noisy
      ? async () => ({ ...(await (host.base as unknown as () => Promise<BaseProbe>)()), probe: { before: "Welcome!\n", values: values({ "tool.git": "0" }) } })
      : host.base;
    const r = await probePrerequisites(target, files, "ssh-ed25519", "~/x", { stage: "prepare", run: host.run, base: base as never });
    assert.deepEqual(host.ran, []);
    assert.equal(r.checks.find((c) => c.id === "tools")!.status, noisy ? "warn" : "fail");
  }
  const host = fakeHost(values({ "tool.git": "0" }));
  const check = await probePrerequisites(target, files, "ssh-ed25519", "~/x", { stage: "check", run: host.run, base: host.base });
  assert.deepEqual(host.ran, []);
  assert.equal(check.checks.find((c) => c.id === "tools")!.status, "warn");
});

/** 偽の machine：Docker の様子を持ち、打たれた sudo で変える（docker グループは新しい接続から効く——様子を引き直すと見える） */
function fakeDockerHost(over: Record<string, string> = {}) {
  const v = values({ groups: "banto", ...over });
  const ran: string[][] = [];
  const base = async (): Promise<BaseProbe> => ({ probe: { before: "", values: new Map(v) }, forwarding: allForwarding, result: { code: 0, stdout: "", stderr: "" } });
  const run = async (args: string[]): Promise<IncusResult> => {
    assert.equal(args[0], SUDO);
    if (v.get("sudo") !== "1") return { code: 1, stdout: "", stderr: "sudo: a password is required" };
    const cmd = args.slice(2);
    ran.push(cmd);
    if (cmd.includes("install") && cmd.includes("docker.io")) v.set("tool.docker", "1");
    if (cmd[0] === "usermod") v.set("groups", `${v.get("groups")} docker`);
    if (cmd.join(" ") === "systemctl restart user@1000.service" && v.get("tool.docker") === "1" && /\bdocker\b/.test(v.get("groups")!)) v.set("docker", "1");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { base: base as never, run, ran, v };
}

test("mayInstallDocker：人が開いた・人が送ったときだけ。自動化・届いたものでは入れない（#414）", () => {
  assert.equal(mayInstallDocker("opened"), true);
  assert.equal(mayInstallDocker("human"), true);
  assert.equal(mayInstallDocker("automation"), false);
  assert.equal(mayInstallDocker("delivery"), false);
});

test("「中で Docker を使う」Project を人が開く（machine・Docker が無い）：docker.io を入れ、docker グループに足し、ユーザーの systemd を起こし直す（#414）", async () => {
  const host = fakeDockerHost({ cloudinit: "1" });
  const { ran, skipped } = await installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause: "opened", run: host.run, base: host.base });
  assert.equal(skipped, undefined);
  const apt = ["env", "DEBIAN_FRONTEND=noninteractive", "NEEDRESTART_MODE=l", "apt-get", "-o", "DPkg::Lock::Timeout=300"];
  assert.deepEqual(host.ran, [
    ["timeout", "600", "cloud-init", "status", "--wait"],
    [...apt, "update", "-q"],
    [...apt, "install", "-y", "-q", "--no-install-recommends", "docker.io"],
    ["systemctl", "enable", "--now", "docker.service"],
    ["usermod", "-aG", "docker", "banto"],
    ["systemctl", "restart", "user@1000.service"],
  ]);
  // 行ったことは「banto が向こうで行ったこと」の行になる（呼び手が確かめの一覧の最後に出す）
  assert.deepEqual(ran.map((r) => r.display), [
    "sudo cloud-init status --wait（cloud-init が終わるまで待つ）",
    "sudo apt-get update",
    "sudo apt-get install --no-install-recommends docker.io",
    "sudo systemctl enable --now docker.service",
    "sudo usermod -aG docker banto",
    "sudo systemctl restart user@1000.service",
  ]);
  assert.equal(host.v.get("docker"), "1");

  // 2回目（使えるようになった）は何もしない
  host.ran.length = 0;
  assert.deepEqual((await installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause: "human", run: host.run, base: host.base })).ran, []);
  assert.deepEqual(host.ran, []);
});

test("Docker は入っているがこのユーザーで使えない：入れ直さず、docker グループに足して起こし直すだけ。グループに居れば起こし直さない（#414）", async () => {
  const host = fakeDockerHost({ "tool.docker": "1" });
  await installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause: "human", run: host.run, base: host.base });
  assert.deepEqual(host.ran, [
    ["systemctl", "enable", "--now", "docker.service"],
    ["usermod", "-aG", "docker", "banto"],
    ["systemctl", "restart", "user@1000.service"],
  ]);
  assert.deepEqual(dockerFixCommands(values({ "tool.docker": "1", groups: "banto docker" })).map((c) => c.args), [["systemctl", "enable", "--now", "docker.service"]]);
});

test("入れない：自動化・届いたもので起きた／sudo -n が通らない／apt の無い OS——何も打たない（呼び手は今どおり断る）（#414）", async () => {
  for (const cause of ["automation", "delivery"] as const) {
    const host = fakeDockerHost();
    let probed = false;
    const base = async () => {
      probed = true;
      return (host.base as unknown as () => Promise<BaseProbe>)();
    };
    const r = await installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause, run: host.run, base: base as never });
    assert.deepEqual(r.ran, []);
    assert.match(r.skipped!, /人が作る・開くときではない/);
    assert.equal(probed, false, "自動で起きたときに向こうへ繋いだ");
    assert.deepEqual(host.ran, []);
  }
  const noSudo = fakeDockerHost({ sudo: "0" });
  const r = await installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause: "opened", run: noSudo.run, base: noSudo.base });
  assert.deepEqual(r, { ran: [], skipped: "sudo -n が通らない" });
  assert.deepEqual(noSudo.ran, []);
  const noApt = fakeDockerHost({ apt: "0", "os.id": "fedora", "os.like": "" });
  assert.equal((await installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause: "opened", run: noApt.run, base: noApt.base })).skipped, "apt で入れられない OS");
  assert.deepEqual(noApt.ran, []);
});

test("入れている途中で落ちたら、どのコマンドが何と言ったかと、それまでに行ったことを添えて投げる（#414）", async () => {
  const host = fakeDockerHost();
  const run = async (args: string[]): Promise<IncusResult> =>
    args.includes("docker.io") ? { code: 100, stdout: "", stderr: "E: Unable to locate package docker.io" } : host.run(args);
  await assert.rejects(
    installDockerOnMachine(target, files, "ssh-ed25519", "~/x", { cause: "opened", run, base: host.base }),
    (err: unknown) =>
      err instanceof AutoFixError && /docker\.io が失敗しました（終了コード 100）：E: Unable to locate package docker\.io/.test(err.message) && err.ran.length === 2,
  );
});

test("machine の登録・確かめ直し（prepare）では Docker を入れない——使わない VM で dockerd を動かさない（#414）", async () => {
  const host = fakeDockerHost();
  const r = await probePrerequisites(target, files, "ssh-ed25519", "~/x", { stage: "prepare", run: host.run, base: host.base });
  assert.ok(!host.ran.some((c) => c.includes("docker.io") || c.includes("docker")), JSON.stringify(host.ran));
  const docker = r.checks.find((c) => c.id === "docker")!;
  assert.equal(docker.status, "warn");
  assert.match(docker.detail!, /人が作る・開くときに、sudo -n が通れば banto が入れます/);
});
