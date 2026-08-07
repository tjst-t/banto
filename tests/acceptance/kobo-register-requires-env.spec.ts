/**
 * task-0076: **検証環境が無いリポジトリは受け持たない**（PO裁定 2026-08-07）。
 *
 * Kobo は検証をホストで走らせない（task-0075）。だからプロファイルの無いリポジトリは
 * **最初のマージで必ず落ちる**——しかもそこまで気づけない。受け持った時点で言う方が、
 * 10タスク積んだあとに言うより親切。
 *
 * **確かめ方も原則どおり**：Kobo は `environments.yaml` を自分で読まず、**検証環境に聞く**
 * （`env.list_profiles`）。読み方を2箇所に置くと同じファイルに2つの解釈ができ、
 * 「Kobo は使えると言うのに立たない」が起きる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import * as http from "node:http";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboModule, KOBO_MODULE_PATH } from "../../packages/banto-daemon/src/index.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** 検証環境の代わり。`env.list_profiles` にだけ答える（他は使わない）。 */
function startFakeEnvPool(
  profilesFor: (repoPath: string) => { usable: Array<{ name: string }>; rejected: Array<{ name: string; reason: string }> }
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const args = (JSON.parse(body || "{}") as { args?: { repoPath?: string } }).args ?? {};
        const details = profilesFor(args.repoPath ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [], details }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}/api/environment-pool`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let tmpDir: string;
let repoDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-reg-env-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function withDaemon(
  envPoolUrl: string,
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>
): Promise<void> {
  const port = await freePort();
  const daemon = Daemon.create({
    port,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "kobo-reg-data-")),
    watchIntervalMs: 99999,
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    environmentPoolUrl: envPoolUrl,
  });
  await daemon.start();
  const tools = createKoboModule(`http://127.0.0.1:${port}${KOBO_MODULE_PATH}`)
    .tools as unknown as NamespacedToolDefinition[];
  try {
    await fn(async (name, args) => {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `${name} が無い`);
      return tool!.execute(args as never, { toolCallId: "t" });
    });
  } finally {
    await daemon.stop();
  }
}

describe("[task-0076] 検証環境が無いリポジトリは受け持たない", () => {
  it("プロファイルが無ければ断る。**何を書けばよいか**まで言う", async () => {
    const pool = await startFakeEnvPool(() => ({ usable: [], rejected: [] }));
    try {
      await withDaemon(pool.url, async (call) => {
        await assert.rejects(
          () => call("kobo.register_project", { projectTag: "no-env", repoPath: repoDir }),
          (err: Error) => {
            assert.match(err.message, /検証プロファイル "test" がありません/);
            assert.match(err.message, /meta\/environments\.yaml/, "書く場所が示されていない");
            assert.match(err.message, /ホストで走らせません/, "なぜ要るのかが示されていない");
            return true;
          }
        );
      });
    } finally {
      await pool.close();
    }
  });

  it("在るが使えないときは、その理由を添える（I2）", async () => {
    const pool = await startFakeEnvPool(() => ({
      usable: [],
      rejected: [{ name: "test", reason: "ttl 720h は上限 24h を超えています" }],
    }));
    try {
      await withDaemon(pool.url, async (call) => {
        await assert.rejects(
          () => call("kobo.register_project", { projectTag: "bad-env", repoPath: repoDir }),
          /上限 24h を超えています/
        );
      });
    } finally {
      await pool.close();
    }
  });

  it("プロファイルがあれば受け持てる", async () => {
    const pool = await startFakeEnvPool(() => ({ usable: [{ name: "test" }], rejected: [] }));
    try {
      await withDaemon(pool.url, async (call) => {
        const result = (await call("kobo.register_project", {
          projectTag: "ok-env",
          repoPath: repoDir,
        })) as { details: { projectTag: string } };
        assert.equal(result.details.projectTag, "ok-env");
      });
    } finally {
      await pool.close();
    }
  });

  it("名前を変えたければ meta/config.yaml の verify.profile が効く", async () => {
    fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, "meta", "config.yaml"),
      "verify:\n  profile: ci\n",
      "utf-8"
    );
    try {
      // `test` しか無ければ断られる
      const wrong = await startFakeEnvPool(() => ({ usable: [{ name: "test" }], rejected: [] }));
      try {
        await withDaemon(wrong.url, async (call) => {
          await assert.rejects(
            () => call("kobo.register_project", { projectTag: "named", repoPath: repoDir }),
            /検証プロファイル "ci" がありません/
          );
        });
      } finally {
        await wrong.close();
      }

      // `ci` があれば通る
      const right = await startFakeEnvPool(() => ({ usable: [{ name: "ci" }], rejected: [] }));
      try {
        await withDaemon(right.url, async (call) => {
          const result = (await call("kobo.register_project", {
            projectTag: "named",
            repoPath: repoDir,
          })) as { details: { projectTag: string } };
          assert.equal(result.details.projectTag, "named");
        });
      } finally {
        await right.close();
      }
    } finally {
      fs.rmSync(path.join(repoDir, "meta"), { recursive: true, force: true });
    }
  });

  it("検証環境へ届かないときは「確かめられない」と言う（勝手に受け持たない・I2）", async () => {
    await withDaemon("http://127.0.0.1:1/api/environment-pool", async (call) => {
      await assert.rejects(
        () => call("kobo.register_project", { projectTag: "unreachable", repoPath: repoDir }),
        (err: Error) => {
          assert.match(err.message, /確かめられません/);
          assert.match(err.message, /banto-environment-pool/, "何を起こせばよいか言う");
          return true;
        }
      );
    });
  });
});
