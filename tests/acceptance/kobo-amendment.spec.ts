/**
 * task-0062: 積んだ後の訂正（ADR-0013 決定64・inc-0028）。
 *
 * **改訂（2026-08-08・task-0082・prop-0002）。** もとの裁定は「訂正は新しいタスクを積み、
 * 元を `superseded` にする」だった。守ろうとしたもの（「何に対して監査したのか」）は
 * 本物だが、**間違いが直せないので運用が「新しいタスクを立てる」に逃げ、経緯が別 id に
 * 分かれて追跡性がむしろ落ちた**（実機の loamium task-0004 → 0005）。
 *
 * いまの裁定：**契約は改訂できる。ただし黙っては起きず、依存するものが差し戻る**。
 *
 * ここで見るのは**据え置いた側**（`kobo.amend` を呼ばない限り、契約は動かない）と、
 * **置き換え**（`kobo.supersede`）。改訂そのものは `kobo-contract-amend.spec.ts`。
 *
 * **第4便で砦が変わった。** 以前これを守っていたのは「watcher が取り込み済みのファイルを
 * 読み飛ばすこと」で、書き換えを検知したら拒否イベントを積んでいた。いまは watcher が
 * 無く、**そもそもファイルを読む経路が無い**——記録ファイルは Kobo が書くもので、
 * 契約は `kobo.enqueue` の入力から凍る（決定62c）。砦は「読み飛ばす」から
 * 「読まない」に変わり、守るものは変わっていない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";

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

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

describe("[task-0062] 積んだ後、記録ファイルを直しても契約は動かない（決定64・第4便）", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let tools: ReturnType<typeof createKoboTools>;
  const proj = "amend-proj";
  const taskFile = (id: string): string => path.join(repoDir, "work", "tasks", `${id}.md`);
  let firstId: string;
  let secondId: string;

  /** 積む（第4便：入口は道具だけ）。**id は Kobo が振る**。 */
  const enqueue = (scope: string): string => {
    const r = daemon.enqueueTask(
      proj,
      {
        title: "訂正の試験",
        kind: "feature",
        body: "依頼の本文。",
        scope: { paths: [scope] },
        acceptance: [{ text: "動くこと" }],
      },
      { originRef: "試験" }
    );
    if (!r.ok) throw new Error(`積めなかった: ${r.reason}`);
    return r.taskId;
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-amend-"));
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "t@e"], repoDir);
    git(["config", "user.name", "t"], repoDir);
    fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
    git(["add", "."], repoDir);
    git(["commit", "-m", "init"], repoDir);

    daemon = Daemon.create({
      port: await freePort(),
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 200,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });
    await daemon.start();
    daemon.registerProject(proj, repoDir);
    tools = createKoboTools(daemon);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool: ${name}`);
    const result = await tool.execute(args as never, { toolCallId: "t" });
    return (result.details ?? {}) as Record<string, unknown>;
  };

  it("[a1] 記録ファイルを書き換えても契約は動かない——**読む経路が無い**", async () => {
    firstId = enqueue("src/narrow/**");
    await until(() => daemon.getTask(proj, firstId) !== undefined);

    // 契約を広げようとする（マージ前ゲートを緩める典型）
    const before = fs.readFileSync(taskFile(firstId), "utf-8");
    fs.writeFileSync(taskFile(firstId), before.replace('paths: ["src/narrow/**"]', 'paths: ["**"]'), "utf-8");

    // tick を何周か回す。**何も起きない**ことがここでの正しさ
    await new Promise((r) => setTimeout(r, 800));

    assert.deepEqual(
      (daemon.getTask(proj, firstId)!["scope"] as { paths: string[] }).paths,
      ["src/narrow/**"],
      "記録を書き換えただけで scope が広がってはいけない（改訂は kobo.amend でだけ起きる）"
    );
  });

  it("[a2] 書き換えを拾う経路が無いので、拒否イベントも積まれない（黙って動く経路が無い）", () => {
    const rejections = daemon
      .getProjectEvents(proj)
      .filter((e) => e.type === "task_ingest_rejected");
    assert.equal(
      rejections.length,
      0,
      "取り込みの拒否は watcher の産物だった。入口が1つになった以上、出るはずがない"
    );
  });

  it("[a3] 訂正の経路：新しいタスクを積み、元を superseded にする", async () => {
    secondId = enqueue("src/wider/**");
    await until(() => daemon.getTask(proj, secondId) !== undefined);

    await call("kobo.supersede", { projectTag: proj, taskId: firstId, by: secondId });

    assert.equal(daemon.getTask(proj, firstId)?.status, "superseded");
    const superseded = daemon
      .getTaskEvents(proj, firstId)
      .find((e) => e.type === "task_superseded") as { supersededBy?: string } | undefined;
    assert.equal(superseded?.supersededBy, secondId, "何に置き換わったかが帳簿に残る");
    assert.equal(daemon.getTask(proj, secondId)?.status !== "superseded", true, "新しい方は生きている");
  });

  it("[a4] 置き換えた元タスクの後始末が走る（終端状態の扱いに乗る）", () => {
    // superseded は終端。職人・検証環境の畳みは終端状態の共通経路が受け持つ
    const events = daemon.getTaskEvents(proj, firstId).map((e) => e.type);
    assert.ok(events.includes("state_transitioned"));
    assert.equal(daemon.getTask(proj, firstId)?.status, "superseded");
  });
});
