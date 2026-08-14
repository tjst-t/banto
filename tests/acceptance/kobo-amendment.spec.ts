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
 * ここで見るのは**据え置いた側**（`kobo.amend` を呼ばない限り、ファイルの書き換えは
 * 反映されない）。改訂そのものは `kobo-contract-amend.spec.ts`。
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

const FM = (id: string, scope: string) =>
  [
    "---",
    `id: ${id}`,
    "type: task",
    "kind: feature",
    `title: ${id}`,
    "status: queued",
    "scope:",
    "  paths:",
    `    - ${scope}`,
    "acceptance:",
    '  - { id: a1, text: "動くこと" }',
    "---",
    "",
    "依頼の本文。",
    "",
  ].join("\n");

describe("[task-0062] 積んだ後にファイルを直しても反映されない。**そのことが分かる**（決定64）", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let tools: ReturnType<typeof createKoboTools>;
  const proj = "amend-proj";
  const taskFile = (id: string): string => path.join(repoDir, "work", "tasks", `${id}.md`);

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
      // watcher を**速く**回す：ここで見たいのは「書き換えを検知したときに何が残るか」
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

  it("[a1] 取り込み済みのファイルを書き換えると、反映しないことがイベントに残る", async () => {
    fs.writeFileSync(taskFile("task-0100"), FM("task-0100", "src/narrow/**"), "utf-8");
    await until(() => daemon.getTask(proj, "task-0100") !== undefined);

    // 契約を広げようとする（マージ前ゲートを緩める典型）
    fs.writeFileSync(taskFile("task-0100"), FM("task-0100", "**"), "utf-8");

    await until(() =>
      daemon
        .getProjectEvents(proj)
        .some((e) => e.type === "task_ingest_rejected" && /already_ingested/.test(e.reason))
    );
    const rejected = daemon
      .getProjectEvents(proj)
      .find((e) => e.type === "task_ingest_rejected") as { reason: string };
    assert.match(rejected.reason, /反映されません/, "何が起きなかったのかが書いてある");
    // **どうすればよいかが書いてある**。決定64 改訂でここが変わった
    // ——以前は「新しいタスクを積め」だったが、いまは「kobo.amend を呼べ」
    assert.match(rejected.reason, /kobo\.amend/, "訂正の道が書いてある（決定64 改訂）");
  });

  it("[a2] `kobo.amend` を呼ばない限り、契約は取り込み時点のまま（黙って改訂されない）", () => {
    const task = daemon.getTask(proj, "task-0100")!;
    assert.deepEqual(
      (task["scope"] as { paths: string[] }).paths,
      ["src/narrow/**"],
      "ファイルを書き換えただけで scope が広がってはいけない（改訂は明示的にだけ起きる）"
    );
  });

  it("初めて見るファイルは黙って取り込む（「書き換え」と混同しない）", () => {
    const rejections = daemon
      .getProjectEvents(proj)
      .filter((e) => e.type === "task_ingest_rejected");
    assert.equal(rejections.length, 1, `余計な拒否が出ていないこと: ${rejections.length}`);
  });

  it("[a3] 訂正の経路：新しいタスクを積み、元を superseded にする", async () => {
    fs.writeFileSync(taskFile("task-0101"), FM("task-0101", "src/wider/**"), "utf-8");
    await until(() => daemon.getTask(proj, "task-0101") !== undefined);

    await call("kobo.supersede", { projectTag: proj, taskId: "task-0100", by: "task-0101" });

    assert.equal(daemon.getTask(proj, "task-0100")?.status, "superseded");
    const superseded = daemon
      .getTaskEvents(proj, "task-0100")
      .find((e) => e.type === "task_superseded") as { supersededBy?: string } | undefined;
    assert.equal(superseded?.supersededBy, "task-0101", "何に置き換わったかが帳簿に残る");
    assert.equal(daemon.getTask(proj, "task-0101")?.status !== "superseded", true, "新しい方は生きている");
  });

  it("[a4] 置き換えた元タスクの後始末が走る（終端状態の扱いに乗る）", () => {
    // superseded は終端。職人・検証環境の畳みは終端状態の共通経路が受け持つ
    const events = daemon.getTaskEvents(proj, "task-0100").map((e) => e.type);
    assert.ok(events.includes("state_transitioned"));
    assert.equal(daemon.getTask(proj, "task-0100")?.status, "superseded");
  });
});
