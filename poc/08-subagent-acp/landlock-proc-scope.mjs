// 捨てる。Landlock で /proc を読み取り許可したとき、ドメインの外のプロセスの environ が読めるかを測る
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BANTO = "/home/ubuntu/worktrees/banto-v4/banto";
const L = await import(join(BANTO, "packages/landlock/dist/index.js"));
const BIN = join(BANTO, "packages/landlock/rust-launcher/target/release/banto-landlock-exec");
const dir = mkdtempSync(join(tmpdir(), "ll-proc-"));
const rules = (extra = []) => {
  const { ruleset } = L.deriveProjectRuleset({ projectRoot: dir, pathEntries: process.env.PATH.split(":"), profile: "exec", nodeExecPath: process.execPath, moduleInstallDirs: [] });
  ruleset.rules.push({ path: "/proc", access: ["read_file", "read_dir"] }, ...extra);
  return ruleset;
};
// 外のプロセス：同じ uid の sleep（閉じ込めない）。環境に目印を持たせる
const outside = spawn("sleep", ["30"], { env: { ...process.env, MARK_OUTSIDE: "SECRET_OUT" } });
await new Promise((r) => setTimeout(r, 200));
const f1 = L.writeRulesetFile(join(dir, "run"), "d1", rules([{ path: BIN, access: ["execute", "read_file"] }, { path: join(dir, "run"), access: ["read_file", "read_dir"] }]));
const f2 = L.writeRulesetFile(join(dir, "run"), "d2", rules());
const script = [
  `echo "own environ: $(tr '\\0' '\\n' < /proc/$$/environ | grep -c MARK_D1)"`,
  `echo "outside environ: $(tr '\\0' '\\n' < /proc/${outside.pid}/environ 2>&1 | grep -c SECRET_OUT) $(cat /proc/${outside.pid}/environ 2>&1 >/dev/null | head -1)"`,
  `echo "outside cmdline: $(tr '\\0' ' ' < /proc/${outside.pid}/cmdline)"`,
  // 入れ子：D1 の中から、さらに launcher で D2 を作り、D2 から D1 のシェル（$$）の environ を読む
  `D1=$$; ${BIN} --ruleset-file ${f2} -- /bin/sh -c "echo nested-reads-parent-D1: \\$(cat /proc/$D1/environ 2>&1 | tr '\\\\0' '\\\\n' | grep -c MARK_D1) \\$(cat /proc/$D1/environ 2>&1 >/dev/null | head -1)" 2>&1 | grep -v banto-landlock-exec`,
].join("; ");
const r = spawnSync(BIN, ["--ruleset-file", f1, "--", "/bin/sh", "-c", script], { env: { ...process.env, MARK_D1: "SECRET_D1" }, encoding: "utf8" });
console.log(r.stdout, r.stderr.split("\n").filter((l) => !l.includes("banto-landlock-exec")).join("\n"));
outside.kill();
rmSync(dir, { recursive: true, force: true });
