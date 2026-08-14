/**
 * AC-Scc9152-1-3 の**書き直し**（第4便）: 積んだ後は記録ファイルを更新しない。
 *
 * ## 何が変わったか
 *
 * もとは「watcher が取り込んだ md に、daemon が実行時状態を書き戻さないこと」だった。
 * 第4便で watcher は無くなり、**md は Kobo が書く記録**になった——書き手が入れ替わった
 * ので、試験の言い方も入れ替える。**趣旨は変わらない**：
 *
 *   **状態の真実は帳簿だけ**（D3）。タスクが queued → ready → … と進んでも、
 *   記録ファイルは積んだ時点の契約のまま**1バイトも動かない**。
 *
 * ここが崩れると、記録ファイルと帳簿という2つの「現在の状態」ができ、
 * 食い違ったときどちらが正しいか決められなくなる。
 *
 * **書き直すのは改訂のときだけ**（`kobo.amend`）。それも「状態」ではなく「契約」で、
 * 帳簿に `task_contract_amended` が残る——黙っては動かない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

const PROJ = "nw-proj";

describe("[AC-Scc9152-1-3] 積んだ後、記録ファイルは動かない（状態は帳簿だけ）", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let taskId: string;
  let recordPath: string;
  let originalContent: string;
  let originalMtimeMs: number;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-nw-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-nw-repo-"));
    fs.mkdirSync(path.join(tmpRepoDir, "work", "tasks"), { recursive: true });

    daemon = Daemon.create({
      port: 0,
      dataDir: tmpDataDir,
      tickIntervalMs: 100_000,
      disableAutoSpawn: true,
    });
    await daemon.start();
    daemon.registerProject(PROJ, tmpRepoDir, "default");

    const result = daemon.enqueueTask(
      PROJ,
      {
        title: "書き戻さないことの確認",
        kind: "fix",
        body: "積んだ後にファイルが動かないことを確かめる。",
        scope: { paths: ["src/**"] },
        acceptance: [{ text: "動かない" }],
      },
      { originRef: "試験" }
    );
    if (!result.ok) throw new Error(`積めなかった: ${result.reason}`);

    taskId = result.taskId;
    recordPath = path.join(tmpRepoDir, result.path);
    originalContent = fs.readFileSync(recordPath, "utf-8");
    originalMtimeMs = fs.statSync(recordPath).mtimeMs;
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("積んだ直後の記録には、積んだ時点の契約が載っている（status は queued のまま）", () => {
    assert.match(originalContent, /^status: queued$/m);
    assert.match(originalContent, /^id: task-\d{4}$/m);
  });

  it("状態が進んでも記録ファイルは1バイトも変わらない", () => {
    for (const to of ["ready", "planning", "implementing"]) {
      const r = daemon.transition(PROJ, taskId, to, "test");
      assert.equal(r.ok, true, `${to} へ進められること`);
    }
    assert.equal(daemon.getTask(PROJ, taskId)?.status, "implementing", "帳簿は進んでいること");

    assert.equal(fs.readFileSync(recordPath, "utf-8"), originalContent, "中身が変わっていない");
    assert.equal(fs.statSync(recordPath).mtimeMs, originalMtimeMs, "触ってもいない");
  });

  it("進んだ後も、記録の status は queued のまま（実行時状態を書き戻さない）", () => {
    assert.match(fs.readFileSync(recordPath, "utf-8"), /^status: queued$/m);
  });

  it("**契約の改訂だけ**は書き直す。ただし帳簿に残る（黙っては動かない）", () => {
    const r = daemon.amendTask(
      PROJ,
      taskId,
      { acceptance: [{ id: "a1", text: "動かない", verify: "npm test" }] },
      { reason: "検証コマンドを付け忘れていた", by: "banto" }
    );
    assert.equal(r.ok, true, r.ok ? "" : r.reason);

    const after = fs.readFileSync(recordPath, "utf-8");
    assert.notEqual(after, originalContent, "改訂は記録に反映される");
    assert.match(after, /verify: npm test/);
    // それでも状態は書かれない
    assert.match(after, /^status: queued$/m);

    const amended = daemon
      .getTaskEvents(PROJ, taskId)
      .filter((e) => e.type === "task_contract_amended");
    assert.equal(amended.length, 1, "改訂が帳簿に1件残ること");
  });
});
