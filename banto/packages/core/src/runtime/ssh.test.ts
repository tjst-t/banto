import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateProbe,
  fingerprintOf,
  hostKeyTypeLabel,
  isHostKeyRefusal,
  knownHostsLine,
  parseProbe,
  pickHostKey,
  remotePathExpr,
  shq,
  sshArgs,
  targetProblem,
} from "./ssh.js";

const HOST = { arch: "x86_64", libc: "glibc" };

test("指紋は ssh-keygen -l と同じ（公開鍵の本体の SHA-256 を base64、末尾の = は落とす）", () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-ssh-fp-"));
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k")]);
    const [type, key] = readFileSync(join(dir, "k.pub"), "utf8").trim().split(" ");
    const expected = execFileSync("ssh-keygen", ["-lf", join(dir, "k.pub")], { encoding: "utf8" }).split(" ")[1];
    assert.equal(type, "ssh-ed25519");
    assert.equal(fingerprintOf(key!), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ssh-keyscan の出力から強い種類を1つ選ぶ。何も無ければ undefined", () => {
  const out = "# 10.0.0.2:22 SSH-2.0-OpenSSH_9.6\n10.0.0.2 ssh-rsa AAAAB3rsa\n10.0.0.2 ecdsa-sha2-nistp256 AAAAE2ec\n10.0.0.2 ssh-ed25519 AAAAC3ed\n";
  const k = pickHostKey(out)!;
  assert.equal(k.type, "ssh-ed25519");
  assert.equal(k.key, "AAAAC3ed");
  assert.equal(k.fingerprint, fingerprintOf("AAAAC3ed"));
  assert.equal(pickHostKey("10.0.0.2 ssh-rsa AAAAB3rsa\n")!.type, "ssh-rsa");
  assert.equal(pickHostKey("# only comments\n"), undefined);
  assert.equal(hostKeyTypeLabel("ssh-ed25519"), "ED25519");
  assert.equal(hostKeyTypeLabel("ecdsa-sha2-nistp256"), "ECDSA");
  assert.equal(knownHostsLine(k), "banto-runtime ssh-ed25519 AAAAC3ed\n");
});

test("ssh の引数：人の設定を読まない・覚えた鍵だけ・Vault の窓口の鍵だけ・agent を渡さない", () => {
  const args = sshArgs({ host: "h", user: "u", port: 2222 }, { knownHostsFile: "/d/kh", agentSocket: "/d/s/a", publicKeyFile: "/d/id.pub" }, "ssh-rsa");
  const joined = args.join(" ");
  assert.equal(args[0], "-F");
  assert.equal(args[1], "/dev/null");
  for (const o of [
    "UserKnownHostsFile=/d/kh",
    "GlobalKnownHostsFile=/dev/null",
    "StrictHostKeyChecking=yes",
    "ForwardAgent=no",
    "IdentitiesOnly=yes",
    "IdentityAgent=/d/s/a",
    "BatchMode=yes",
    "HostKeyAlgorithms=rsa-sha2-512,rsa-sha2-256",
  ]) {
    assert.ok(joined.includes(`-o ${o}`), o);
  }
  assert.ok(joined.includes("-i /d/id.pub"));
  assert.ok(joined.includes("-p 2222"));
  assert.ok(joined.includes("-l u"));
});

test("宛先の形：ssh の引数に化けるもの（- で始まる等）を断る", () => {
  assert.equal(targetProblem({ host: "192.168.1.60", user: "banto", port: 22 }), undefined);
  assert.equal(targetProblem({ host: "lab.lan", user: "banto-remote", port: 2222 }), undefined);
  assert.match(targetProblem({ host: "-oProxyCommand=x", user: "u", port: 22 })!, /ホスト/);
  assert.match(targetProblem({ host: "h", user: "-l", port: 22 })!, /ユーザー/);
  assert.match(targetProblem({ host: "h", user: "u", port: 70000 })!, /ポート/);
});

test("向こうのパスの式：~ は向こうの $HOME、ほかは単一引用", () => {
  assert.equal(remotePathExpr("~"), `"$HOME"`);
  assert.equal(remotePathExpr(""), `"$HOME"`);
  assert.equal(remotePathExpr("~/a b"), `"$HOME"/'a b'`);
  assert.equal(remotePathExpr("/x/it's"), `'/x/it'\\''s'`);
  assert.equal(shq("a"), "'a'");
});

test("鍵が違う・覚えた種類の鍵が無い、を ssh の断りとして見分ける", () => {
  assert.ok(isHostKeyRefusal({ code: 255, stdout: "", stderr: "@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.\n" }));
  assert.ok(isHostKeyRefusal({ code: 255, stdout: "", stderr: "Unable to negotiate with 1.2.3.4 port 22: no matching host key type found." }));
  assert.ok(!isHostKeyRefusal({ code: 255, stdout: "", stderr: "Permission denied (publickey)." }));
  assert.ok(!isHostKeyRefusal({ code: 1, stdout: "", stderr: "Host key verification failed." }));
});

function probe(over: Record<string, string> = {}, before = "") {
  const values: Record<string, string> = {
    arch: "x86_64",
    libc: "glibc 2.39",
    "tool.git": "1",
    "tool.ssh": "1",
    "tool.curl": "1",
    "tool.tar": "1",
    "tool.tmux": "1",
    "tool.docker": "1",
    "tool.rsync": "1",
    uid: "1500",
    user: "banto-remote",
    home: "/home/banto-remote",
    bus: "1",
    linger: "1",
    root: "/home/banto-remote/.local/share/banto-remote",
    writable: "1",
    docker: "1",
    maxsessions: "10",
    ...over,
  };
  return parseProbe(`${before}__BANTO_PROBE_BEGIN__\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n")}\n`)!;
}

const status = (checks: ReturnType<typeof evaluateProbe>) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

test("前提：全部そろえば ok だけ", () => {
  const checks = evaluateProbe(probe(), { tcp: true, streamLocal: true }, HOST);
  assert.deepEqual(status(checks), {
    platform: "ok",
    "silent-login": "ok",
    tools: "ok",
    tmux: "ok",
    rsync: "ok",
    "user-systemd": "ok",
    linger: "ok",
    "data-root": "ok",
    sshd: "ok",
    docker: "ok",
  });
  assert.ok(checks.every((c) => !c.detail && !c.fix));
});

test("前提：banto が動くのに要るものは ✕、特定の Module だけのもの（tmux・docker）・前に居た場所へ戻すときだけの rsync と linger は注意", () => {
  const checks = evaluateProbe(
    probe({ "tool.tmux": "0", "tool.curl": "0", "tool.rsync": "0", linger: "0", docker: "0", bus: "0" }),
    { tcp: true, streamLocal: true },
    HOST,
  );
  const s = status(checks);
  assert.equal(s.tools, "fail");
  assert.equal(s["user-systemd"], "fail");
  assert.equal(s.tmux, "warn");
  assert.equal(s.linger, "warn");
  assert.equal(s.docker, "warn");
  assert.equal(s.rsync, "warn");
  assert.equal(checks.find((c) => c.id === "rsync")!.fix, "sudo apt install rsync");
  const tools = checks.find((c) => c.id === "tools")!;
  assert.match(tools.detail!, /curl/);
  assert.equal(tools.fix, "sudo apt install curl");
  assert.equal(checks.find((c) => c.id === "linger")!.fix, "sudo loginctl enable-linger banto-remote");
  assert.match(checks.find((c) => c.id === "user-systemd")!.label, /\/run\/user\/1500\/bus/);
});

test("前提：ログインシェルが何か出す・CPU が違う・転送を断る・置き場に書けない は ✕", () => {
  const checks = evaluateProbe(
    probe({ arch: "aarch64", writable: "0", maxsessions: "4" }, "Welcome!\n"),
    { tcp: false, streamLocal: true },
    HOST,
  );
  const s = status(checks);
  assert.equal(s.platform, "fail");
  assert.equal(s["silent-login"], "fail");
  assert.equal(s["data-root"], "fail");
  assert.equal(s.sshd, "fail");
  assert.match(checks.find((c) => c.id === "silent-login")!.detail!, /Welcome!/);
  assert.match(checks.find((c) => c.id === "sshd")!.fix!, /AllowTcpForwarding yes/);
  assert.doesNotMatch(checks.find((c) => c.id === "sshd")!.fix!, /AllowStreamLocalForwarding/);
  // 転送が許されていて、MaxSessions が少ないだけなら注意
  assert.equal(status(evaluateProbe(probe({ maxsessions: "4" }), { tcp: true, streamLocal: true }, HOST)).sshd, "warn");
  // musl の機械は glibc の banto と違う
  assert.equal(status(evaluateProbe(probe({ libc: "musl" }), { tcp: true, streamLocal: true }, HOST)).platform, "fail");
});

test("台本の出力の境目が無ければ読まない（ログインシェルで落ちた等）", () => {
  assert.equal(parseProbe("bash: sh: command not found\n"), undefined);
});
