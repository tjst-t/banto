import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_LAUNCHER_SCRIPT, moduleUnitName } from "./remote-launcher.js";

/**
 * 偽の systemctl・systemd-run を置いた PATH で起動役を走らせる。systemd-run は受けた引数・環境を書き、`--` の後ろ（起動役の
 * 内側）を裏で起こして返る（本物の単位と同じく、呼び元とは切り離して動く）
 */
function fakeSystemd(dir: string, opts: { stopFails?: string } = {}): void {
  writeFileSync(
    join(dir, "systemctl"),
    `#!/bin/sh\necho "$@" >> ${dir}/systemctl.log\n${opts.stopFails ? `[ "$2" = stop ] && { echo '${opts.stopFails}' >&2; exit 1; }\n` : ""}exit 0\n`,
  );
  writeFileSync(
    join(dir, "systemd-run"),
    `#!/bin/sh\necho "$@" > ${dir}/run.args\nwhile [ "$1" != "--" ]; do shift; done\nshift\n"$@" > /dev/null 2> ${dir}/inner.err < /dev/null &\nexit 0\n`,
  );
  chmodSync(join(dir, "systemctl"), 0o755);
  chmodSync(join(dir, "systemd-run"), 0o755);
}

function launch(dir: string, unit: string, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  writeFileSync(join(dir, "launcher.mjs"), REMOTE_LAUNCHER_SCRIPT);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, "launcher.mjs"), unit], {
      env: { PATH: `${dir}:/usr/bin:/bin`, USER: "u" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += String(c)));
    child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// 内側のソケットは本物と同じ /run/user/<uid>/banto に置く（この試験の機械にユーザーの実行時の置き場が無ければ飛ばす）
const runtimeDir = `/run/user/${process.getuid!()}`;
const skip = existsSync(runtimeDir) ? false : `${runtimeDir} が無い`;

test("起動役：前の単位を止め、systemd-run --user で内側を起こし、最初の1行（env）と標準入出力をソケットで渡す", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-launcher-"));
  const unit = `banto-mod-test-${process.pid}`;
  try {
    fakeSystemd(dir);
    const req = {
      command: "/bin/sh",
      args: ["-c", 'cat; echo "secret=$SECRET home=$HOME xdg=$XDG_RUNTIME_DIR"; pwd; echo to-stderr >&2'],
      cwd: dir,
      env: { SECRET: "s3cr3t", HOME: "/h" },
    };
    // 最初の1行のすぐ後ろに MCP のやり取りが続く（起動役が読み過ぎると、Module に届かない）
    const r = await launch(dir, unit, `${JSON.stringify(req)}\n{"jsonrpc":"2.0","id":1}\nline2\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `{"jsonrpc":"2.0","id":1}\nline2\nsecret=s3cr3t home=/h xdg=${runtimeDir}\n${dir}\n`);
    // Module の標準エラーは2本目で届く
    assert.equal(r.stderr, "to-stderr\n");
    // 前の単位を止めてから起こす
    assert.deepEqual(readFileSync(join(dir, "systemctl.log"), "utf8").trim().split("\n"), [
      `--user stop ${unit}.service`,
      `--user reset-failed ${unit}.service`,
    ]);
    // コマンド行に env は載らない（向こうの ps で読めない）
    const args = readFileSync(join(dir, "run.args"), "utf8").trim();
    assert.match(args, new RegExp(`^--user --quiet --collect --unit=${unit} --setenv=PATH=\\S+ -- \\S+node\\S* ${join(dir, "launcher.mjs")} --inner ${runtimeDir}/banto/${unit}\\.sock$`));
    assert.ok(!args.includes("s3cr3t"));
    // ソケットは使い終わったら消える
    assert.equal(existsSync(`${runtimeDir}/banto/${unit}.sock`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("起動役：前の単位を止められなければ起こさずに理由を出す。最初の1行が壊れている・単位の名前が不正なら断る", async () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-launcher-"));
  try {
    fakeSystemd(dir, { stopFails: "Failed to connect to bus" });
    const req = { command: "/bin/true", args: [], cwd: dir, env: {} };
    const r = await launch(dir, "banto-mod-x", `${JSON.stringify(req)}\n`);
    assert.equal(r.code, 127);
    assert.match(r.stderr, /前の banto-mod-x を止められません: Failed to connect to bus/);
    assert.equal(existsSync(join(dir, "run.args")), false, "止められないのに起こした");

    const bad = await launch(dir, "banto-mod-x", "これは JSON ではない\n");
    assert.equal(bad.code, 127);
    assert.match(bad.stderr, /最初の1行が JSON ではありません/);

    const unit = await launch(dir, "a b; rm -rf /", `${JSON.stringify(req)}\n`);
    assert.equal(unit.code, 127);
    assert.match(unit.stderr, /単位の名前が不正です/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("単位の名前は接続名から（systemd の名前に使えない字は _ に）", () => {
  assert.equal(moduleUnitName("shell-0b6c6d0e-1f2a"), "banto-mod-shell-0b6c6d0e-1f2a");
  assert.equal(moduleUnitName("a/b c"), "banto-mod-a_b_c");
});
