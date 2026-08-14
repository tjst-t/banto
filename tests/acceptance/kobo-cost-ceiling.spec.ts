/**
 * task-0063: 費用の上限は Kobo が持ち、**積む時点で拒否**する（ADR-0013 決定67）。
 *
 * **黙って丸めない**のが要点。上限を超えたタスクを黙って `fast` へ落とすと、PO は
 * 「安く速く終わった」と読み、実際には要求水準を満たしていない成果を受け取る——
 * 拒否すれば、上限を上げるか要求を下げるかを人が決められる（決定34f と同じ形）。
 *
 * **監査は上限の対象外**。監査は費用のつまみではなく検査であり、上限で省ける形にすると
 * 「安くするために検査を外す」ができてしまう（決定57 が禁じた形）。そのことは起動時に言う。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { loadProjectConfig } from "../../packages/banto-daemon/src/review-policy.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
    });
  });
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Harness {
  daemon: Daemon;
  repoDir: string;
  tmpDir: string;
  proj: string;
}

async function harness(config: string): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-ceiling-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "meta", "config.yaml"), config, "utf-8");
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@e"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  const daemon = Daemon.create({
    port: await freePort(),
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
  });
  await daemon.start();
  const proj = "ceiling-proj";
  daemon.registerProject(proj, repoDir);
  return { daemon, repoDir, tmpDir, proj };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/**
 * 第4便：積むのは道具の入力から。**定義ファイルを先に書く経路は無くなった**
 * （Kobo が採番して記録を書く）ので、等級だけを渡して積む。
 */
function enqueue(h: Harness, tier?: string): ReturnType<Daemon["enqueueTask"]> {
  return h.daemon.enqueueTask(
    h.proj,
    {
      title: "上限の確認",
      kind: "fix",
      body: "等級の上限を確かめる。",
      scope: { paths: ["src/**"] },
      acceptance: [{ text: "確かめられる" }],
      ...(tier ? { model_tier: tier as "reasoning" | "standard" | "fast" } : {}),
    },
    { originRef: "試験" }
  );
}

describe("[task-0063] 等級の上限（決定67）", () => {
  let h: Harness;
  before(async () => {
    h = await harness("limits:\n  max_model_tier: standard\n  max_concurrent_sessions: 2\n");
  });
  after(async () => {
    await teardown(h);
  });

  it("[a1] 同時実行数の上限が層B設定から読める", () => {
    assert.equal(h.daemon.maxConcurrentSessions(), 2, "プロジェクトの設定が効く");
    assert.equal(loadProjectConfig(h.repoDir).limits.maxConcurrentSessions, 2);
  });

  it("[a2] 上限を超える model_tier のタスクは**拒否**される。黙って丸めない", () => {
    const result = enqueue(h, "reasoning");
    assert.equal(result.ok, false);
    assert.match(
      (result as { reason: string }).reason,
      /上限は standard/,
      "何が超えているかが分かる"
    );
    assert.match(
      (result as { reason: string }).reason,
      /黙って丸めません/,
      "下の等級で勝手に走らせないことが分かる"
    );
    assert.equal(h.daemon.getTasksByProject(h.proj).length, 0, "積まれていないこと");
  });

  it("[a3] 拒否の理由は呼び出し側に返る（積んだのに動かない、が黙って起きない）", () => {
    // enqueue の返りがそのまま kobo.enqueue の例外になる（Tool 側で throw する）
    const result = enqueue(h, "reasoning");
    assert.equal(result.ok, false);
    assert.ok((result as { reason: string }).reason.length > 20, "理由が具体的であること");
  });

  it("上限の内側なら通る", () => {
    assert.equal(enqueue(h, "standard").ok, true);
    assert.equal(enqueue(h, "fast").ok, true);
  });

  it("[a5] 設定に現れるのは数と等級だけ（Kobo はモデル名も金額も知らない）", () => {
    const config = fs.readFileSync(path.join(h.repoDir, "meta", "config.yaml"), "utf-8");
    assert.doesNotMatch(config, /provider|model:|api|token|\$|円/i);
    const limits = loadProjectConfig(h.repoDir).limits;
    assert.deepEqual(Object.keys(limits).sort(), ["maxConcurrentSessions", "maxModelTier"]);
  });

  it("壊れた上限は黙って無視しない（I2）", async () => {
    const bad = await harness("limits:\n  max_model_tier: ちょうすごいやつ\n");
    try {
      assert.throws(() => loadProjectConfig(bad.repoDir), /fast \/ standard \/ reasoning/);
    } finally {
      await teardown(bad);
    }
  });
});

describe("[task-0063/a4] 監査は上限の対象外（検査を費用のつまみにしない）", () => {
  it("上限が standard でも、監査は reasoning のまま回る", async () => {
    const h = await harness("limits:\n  max_model_tier: standard\n");
    try {
      assert.equal(enqueue(h, "fast").ok, true);

      // 監査の等級は spec-daemon-core §3.5 の固定値（reasoning）。上限では下がらない
      // ——下げられる形にすると「安くするために検査を弱める」ができてしまう（決定57）
      const source = fs.readFileSync(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          "..",
          "..",
          "packages",
          "banto-daemon",
          "src",
          "daemon.ts"
        ),
        "utf-8"
      );
      assert.match(
        source,
        /role: "audit",[\s\S]{0,200}modelTier: "reasoning"/,
        "監査は reasoning 固定で起こされること"
      );
    } finally {
      await teardown(h);
    }
  });

  it("失敗駆動の昇格は上限で据え置かれる（積んだ後に止めない）", async () => {
    const h = await harness("limits:\n  max_model_tier: standard\n");
    try {
      assert.equal(enqueue(h, "standard").ok, true);
      // 昇格の判断は rework の起こし方に効く。上限を超える昇格は据え置く（拒否ではない）
      // ——積む時点で上限内だったタスクを途中で止めるのは筋が違う
      assert.equal(h.daemon.projectConfig(h.proj).limits.maxModelTier, "standard");
    } finally {
      await teardown(h);
    }
  });
});
