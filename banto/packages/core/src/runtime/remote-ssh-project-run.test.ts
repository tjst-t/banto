// **Project の箱の中で argv を流す口**（`runInProject`、Backlog #466——Repositories のブランチを運ぶ git）。相手は偽の `ssh`
// （PATH の先頭）：宛先の後ろのコマンド行を `sh -c` で流す。containers では、その行が `incus exec <c> --user U --group G …
// -- argv` なので、偽の `incus` が呼ばれ方を書き残してから argv を流す。見るのは：machine は VM のユーザーでそのまま流す・
// containers は必ずコンテナの中のユーザー（incus exec の --user・--group）で流す・標準入出力はバイトのまま・上限を越えたら止める・
// 接続が無ければ流さずに投げる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteSshRuntime, remoteConnectionKey } from "./remote-ssh.js";

const FAKE_SSH = `#!/bin/sh
for a; do last=$a; done
exec sh -c "$last"
`;

/** 偽の incus：`exec <c> --user U --group G [--env K=V]… -- argv…` を書き残し、env を付けて argv を流す */
function fakeIncus(log: string): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> ${log}
[ "$1" = exec ] || exit 9
shift 2
envs=""
while [ "$1" != "--" ]; do
  case "$1" in
    --env) envs="$envs $2"; shift 2 ;;
    *) shift ;;
  esac
done
shift
exec env $envs "$@"
`;
}

async function withRuntime(
  mode: "machine" | "containers",
  fn: (ctx: { rt: RemoteSshRuntime; bin: string; incusLog: string; conn: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  const bin = mkdtempSync(join(tmpdir(), "banto-project-run-"));
  const dataDir = mkdtempSync(join(tmpdir(), "banto-project-run-data-"));
  const incusLog = join(bin, "incus.log");
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  writeFileSync(join(bin, "incus"), fakeIncus(incusLog));
  chmodSync(join(bin, "ssh"), 0o755);
  chmodSync(join(bin, "incus"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  const master = spawn("sleep", ["60"], { stdio: "ignore" });
  const rt = new RemoteSshRuntime({
    dataDir,
    monorepoRoot: dataDir,
    runtimes: {} as never,
    remoteNameOf: (id) => (id === "p1" ? "vm" : undefined),
    createRelayListener: () => {
      throw new Error("使わない");
    },
    notify: async () => undefined,
    log: () => undefined,
  });
  const conn: Record<string, unknown> = {
    runtimeName: "vm",
    projectId: "p1",
    runtime: { host: "example.invalid", port: 22, user: "u", mode },
    controlPath: join(dataDir, "cm"),
    knownHostsFile: "/dev/null",
    master,
    alive: true,
    remotePort: 0,
    base: "/remote/base",
    codeDir: "",
    checks: [],
    exited: new Promise(() => undefined),
    forwards: new Map(),
    cautioned: new Set(),
    ...(mode === "containers"
      ? { container: { ready: Promise.resolve("banto-p1"), root: "/r", nesting: false, virtualization: "null" }, containerIds: { uid: 1001, gid: 1002, inside: { uid: 1001, gid: 1002 } } }
      : {}),
  };
  (rt as unknown as { connections: Map<string, unknown> }).connections.set(remoteConnectionKey("vm", "p1"), conn);
  try {
    await fn({ rt, bin, incusLog, conn });
  } finally {
    process.env.PATH = savedPath;
    master.kill("SIGKILL");
    rmSync(bin, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const echoBack = ["/bin/sh", "-c", 'cat; printf "%s|%s" "$1" "$HOME" >&2', "banto-git", "it's $x"];

test("machine：VM のユーザーでそのまま流す。標準入出力はバイトのまま・引数は1語ずつ", async () => {
  await withRuntime("machine", async ({ rt, incusLog }) => {
    const data = randomBytes(300_000);
    const r = await rt.runInProject("p1", echoBack, { stdin: data, maxStdoutBytes: 1_000_000, timeoutMs: 20_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.equals(data), "標準出力がバイトのまま戻らない");
    assert.match(r.stderr, /^it's \$x\|/);
    assert.throws(() => readFileSync(incusLog), "machine で incus を呼んだ");
  });
});

test("containers：必ずコンテナの中のユーザーで流す（incus exec --user・--group と中のホーム）", async () => {
  await withRuntime("containers", async ({ rt, incusLog }) => {
    const data = randomBytes(1000);
    const r = await rt.runInProject("p1", echoBack, { stdin: data, maxStdoutBytes: 1_000_000, timeoutMs: 20_000 });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.equals(data));
    assert.match(r.stderr, /^it's \$x\|\/home\//, "中のホームで流していない");
    const called = readFileSync(incusLog, "utf8").trim();
    assert.match(called, /^exec banto-p1 --user 1001 --group 1002 .*-- \/bin\/sh -c /);
  });
});

test("標準出力が上限を越えたら止めて overflow。終了コードはそのまま返す。接続が無ければ流さない", async () => {
  await withRuntime("machine", async ({ rt, conn }) => {
    const big = await rt.runInProject("p1", ["/bin/sh", "-c", "head -c 5000000 /dev/zero"], { maxStdoutBytes: 100_000, timeoutMs: 20_000 });
    assert.equal(big.overflow, true);
    assert.ok(big.stdout.length <= 100_000);
    const seven = await rt.runInProject("p1", ["/bin/sh", "-c", "echo nope >&2; exit 7"], { maxStdoutBytes: 10, timeoutMs: 20_000 });
    assert.deepEqual([seven.code, seven.stderr.trim()], [7, "nope"]);
    const slow = await rt.runInProject("p1", ["sleep", "5"], { maxStdoutBytes: 10, timeoutMs: 300 });
    assert.notEqual(slow.code, 0);
    assert.match(slow.stderr, /終わらなかったので止めました/);
    await assert.rejects(() => rt.runInProject("p2", ["true"], { maxStdoutBytes: 10, timeoutMs: 1000 }), /SSH の接続がありません/);
    conn.alive = false;
    await assert.rejects(() => rt.runInProject("p1", ["true"], { maxStdoutBytes: 10, timeoutMs: 1000 }), /SSH の接続がありません/);
  });
});
