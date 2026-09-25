// 実機の Incus で、Project のコンテナの一生を確かめる（`BANTO_TEST_INCUS=1` のときだけ。incus グループが効いた
// プロセスで走らせる——例：`sudo -u "$USER" env BANTO_TEST_INCUS=1 node --test dist/*.integration.test.js`。
// `sg incus` は主グループを incus に変えるので、作るフォルダのグループが中に対応せず、本番と形が変わる）。
// 権限を絞った区画はホームの下しかマウントできないので、試験の根はホームの下に作る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { runIncus } from "./incus.js";
import { ProjectContainers, containerNameFor, execInContainer, CONTAINER_NODE_PATH } from "./project-container.js";

const enabled = process.env.BANTO_TEST_INCUS === "1";
const skip = enabled ? false : "実機の Incus が要る（BANTO_TEST_INCUS=1 のときだけ走る）";

function runIn(cmd: { command: string; args: string[] }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const c = spawn(cmd.command, cmd.args);
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => res({ code, stdout, stderr }));
  });
}

test("Project のコンテナ：作る→同じ根を同じパスで・持ち主が揃う→コードは読み取り専用→根を付け替える→止める→消す", { skip, timeout: 300_000 }, async () => {
  const base = join(homedir(), ".cache", "banto-container-test");
  mkdirSync(base, { recursive: true });
  const rootA = realpathSync(mkdtempSync(join(base, "a-")));
  const rootB = realpathSync(mkdtempSync(join(base, "b-")));
  const bantoDir = resolve(new URL("../../..", import.meta.url).pathname);
  const projectId = `t-${Math.random().toString(16).slice(2, 10)}`;
  const name = containerNameFor(projectId);
  const containers = new ProjectContainers(runIncus);
  // gid はユーザーの登録情報から——`sg incus` で起こしたプロセスの主グループは incus に変わる
  const { uid, gid } = userInfo();
  const spec = { projectId, root: rootA, bantoDir, nodePath: process.execPath, nodeVersion: process.version, nesting: false, image: "images:ubuntu/24.04", uid, gid };
  try {
    writeFileSync(join(rootA, "from-host.txt"), "host");
    const first = await containers.ensure(spec);
    assert.deepEqual(first, { name, created: true });
    const again = await containers.ensure(spec);
    assert.deepEqual(again, { name, created: false }, "2回目で作り直している");

    // 中の node はホストと同じ版
    const node = await runIncus(["exec", name, "--", CONTAINER_NODE_PATH, "--version"]);
    assert.equal(node.stdout.trim(), process.version);

    // 同じパスで見え、中で書いたものはホストでも自分の持ち物
    const inside = execInContainer(name, { cwd: rootA, env: { MARK: "m1" }, uid, gid }, CONTAINER_NODE_PATH, [
      "-e",
      `const fs=require("fs");process.stdout.write(process.cwd()+"|"+process.env.MARK+"|"+fs.readFileSync("from-host.txt","utf8"));fs.writeFileSync("from-container.txt","c")`,
    ]);
    const r = await runIn(inside);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${rootA}|m1|host`);
    assert.equal(statSync(join(rootA, "from-container.txt")).uid, uid);
    assert.equal(readFileSync(join(rootA, "from-container.txt"), "utf8"), "c");

    // 入れない作業ディレクトリは、黙って / で動かさずに止まる
    const noCwd = await runIn(execInContainer(name, { cwd: `${rootA}/no-such-dir`, env: {}, uid, gid }, "pwd", []));
    assert.equal(noCwd.code, 126, noCwd.stdout);

    // banto のコードは読み取り専用
    const ro = await runIn(execInContainer(name, { cwd: rootA, env: {}, uid, gid }, "sh", ["-c", `touch ${bantoDir}/should-not-exist 2>&1; echo rc=$?`]));
    assert.match(ro.stdout, /Read-only file system/);

    // 根を付け替える：新しい根が同じパスで見え、古い根は見えない
    writeFileSync(join(rootB, "b.txt"), "b\n");
    await containers.ensure({ ...spec, root: rootB });
    const moved = await runIn(execInContainer(name, { cwd: rootB, env: {}, uid, gid }, "sh", ["-c", `cat b.txt; test -e ${rootA}/from-host.txt && echo old-visible || echo old-gone`]));
    assert.equal(moved.stdout.trim(), "b\nold-gone");

    await containers.stop(name);
    assert.equal((await containers.state(name))?.status, "Stopped");
  } finally {
    await containers.remove(name);
    assert.equal(await containers.state(name), undefined, "消えていない");
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
