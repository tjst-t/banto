/**
 * task-0001: いま着手できる仕事を一級クエリとして出す（spec-daemon-core §6）。
 *
 * **判定の真実を一箇所に保つ**（D3）。番頭の `kobo.list`・CLI の `kobo ready`・自動着手の
 * tick は、すべて Kobo の同じ導出を見る——別々に数え始めると「画面では着手できるのに
 * 実際は上がらない」がありうる状態になる。
 *
 * CLI は**本物のバイナリを別プロセスで**起こす（`cli-status.spec.ts` と同じ形）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Daemon } from "@banto/daemon";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(REPO_ROOT, "packages/banto-cli/src/bin.ts");
const NODE = process.execPath;
const TSX_PREFLIGHT = path.join(REPO_ROOT, "node_modules/tsx/dist/preflight.cjs");
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;

async function runKobo(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 8000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      NODE,
      ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, BIN, ...args],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`kobo ${args.join(" ")} timed out`));
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    proc.on("error", reject);
  });
}

describe("[task-0001] いま着手できる仕事（ready クエリ）", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let daemonUrl: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-ready-"));
    daemon = Daemon.create({
      port: 0,
      dataDir: tmpDir,
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
    });
    await daemon.start();
    daemonUrl = `http://localhost:${daemon.port}`;

    daemon.registerProject("proj-a", "/repos/proj-a");
    daemon.registerProject("proj-b", "/repos/proj-b");

    // 着手できるもの（ready）と、まだのもの（queued）と、動いているもの（implementing）
    daemon.createTask("proj-a", "task-0001", "着手できる仕事", { kind: "feature" });
    daemon.transition("proj-a", "task-0001", "queued");
    daemon.transition("proj-a", "task-0001", "ready");

    // 依存で止まっているもの。**ゲートの判定がそのまま出る**ことを見る（a1）
    daemon.createTask("proj-a", "task-0002", "まだ待っている仕事", {
      kind: "feature",
      depends: ["task-0003"],
    });
    daemon.transition("proj-a", "task-0002", "queued");

    daemon.createTask("proj-a", "task-0003", "動いている仕事", { kind: "feature" });
    daemon.transition("proj-a", "task-0003", "queued");
    daemon.transition("proj-a", "task-0003", "ready");
    daemon.transition("proj-a", "task-0003", "planning");

    daemon.createTask("proj-b", "task-0010", "別プロジェクトの仕事", { kind: "feature" });
    daemon.transition("proj-b", "task-0010", "queued");
    daemon.transition("proj-b", "task-0010", "ready");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[a1] GET /api/v1/ready が着手可能なものだけを返す", async () => {
    const res = await fetch(`${daemonUrl}/api/v1/ready`);
    assert.equal(res.status, 200);
    const { tasks } = (await res.json()) as { tasks: Array<{ id: string; status: string }> };
    const ids = tasks.map((t) => t.id).sort();
    assert.deepEqual(ids, ["task-0001", "task-0010"], "ready のものだけ（queued も planning も出ない）");
    assert.ok(tasks.every((t) => t.status === "ready"));
  });

  it("[a1] プロジェクトで絞れる。知らないプロジェクトは 404（黙って空にしない・I2）", async () => {
    const res = await fetch(`${daemonUrl}/api/v1/ready?project=proj-a`);
    const { tasks } = (await res.json()) as { tasks: Array<{ id: string }> };
    assert.deepEqual(tasks.map((t) => t.id), ["task-0001"]);

    const missing = await fetch(`${daemonUrl}/api/v1/ready?project=no-such`);
    assert.equal(missing.status, 404);
  });

  it("[a2] CLI（kobo ready）が同じものを出す", async () => {
    const { stdout, stderr, code } = await runKobo(["ready"], { BANTO_DAEMON_URL: daemonUrl });
    assert.equal(code, 0, `exit 0 であること。stderr: ${stderr}`);
    assert.match(stdout, /ready \(2\)/);
    assert.match(stdout, /task-0001/);
    assert.match(stdout, /task-0010/);
    assert.doesNotMatch(stdout, /task-0002/, "待っているものは出ない");
    assert.doesNotMatch(stdout, /task-0003/, "動いているものは出ない");
  });

  it("[a2] CLI もプロジェクトで絞れる", async () => {
    const { stdout, code } = await runKobo(["ready", "--project", "proj-a"], {
      BANTO_DAEMON_URL: daemonUrl,
    });
    assert.equal(code, 0);
    assert.match(stdout, /task-0001/);
    assert.doesNotMatch(stdout, /task-0010/);
  });

  it("[a2] 判定は Kobo の1つの導出。CLI は数え直さない（D3）", async () => {
    // API・CLI・Daemon の3つの入口が同じ集合を返すこと——どれかが自分で数え始めていたら、
    // ここがずれる（画面では着手できるのに実際は上がらない、が起きる形）
    const api = await fetch(`${daemonUrl}/api/v1/ready`).then(
      (r) => r.json() as Promise<{ tasks: Array<{ id: string }> }>
    );
    const direct = daemon.readyTasks().map((t) => t.id).sort();
    const { stdout } = await runKobo(["ready"], { BANTO_DAEMON_URL: daemonUrl });
    const fromCli = [...stdout.matchAll(/task-\d{4}/g)].map((m) => m[0]).sort();

    assert.deepEqual(api.tasks.map((t) => t.id).sort(), direct);
    assert.deepEqual(fromCli, direct);
  });

  it("着手できるものが無ければ、そう言う（空の出力で黙らない）", async () => {
    const { stdout, code } = await runKobo(["ready", "--project", "proj-b"], {
      BANTO_DAEMON_URL: daemonUrl,
    });
    assert.equal(code, 0);
    assert.match(stdout, /task-0010/);

    // 全部進めてしまえば ready は空になる
    daemon.transition("proj-b", "task-0010", "planning");
    const empty = await runKobo(["ready", "--project", "proj-b"], { BANTO_DAEMON_URL: daemonUrl });
    assert.match(empty.stdout, /\(none\)/);
  });
});
