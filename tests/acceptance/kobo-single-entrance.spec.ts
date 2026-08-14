/**
 * 第4便：入口の一本化（PO 指示 2026-08-13）。
 *
 * **Kobo へ仕事が入る口は `kobo.enqueue` ひとつだけ**にした。
 *   - watcher（`work/tasks/*.md` を読んで積む）は廃止
 *   - 採番は Kobo（番頭は `task-NNNN` を決めない）
 *   - 番頭は本文を渡し、**Kobo が記録ファイルを書く**（md は入力ではなく記録）
 *   - 契約は**道具の入力から凍る**（決定62c）。ファイルを読み戻して作らない
 *   - 積む口の弁（`kobo.set_watch`）が閉じていれば、積めずに理由が返る
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";
import {
  nextTaskNumber,
  renderTaskRecord,
  verifyRoundTrip,
  checkWritable,
} from "@banto/daemon";
import type { TaskContractInput } from "@banto/daemon";

const PROJ = "proj";

function minimalInput(over: Partial<TaskContractInput> = {}): TaskContractInput {
  return {
    title: "何かを直す",
    kind: "fix",
    body: "## 背景\n\nここに依頼を書く。",
    scope: { paths: ["src/**"] },
    acceptance: [{ text: "直っている", verify: "npm test" }],
    ...over,
  };
}

describe("[第4便] 採番は Kobo がやる（ファイル名と帳簿の両方の最大＋1）", () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-num-"));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("空のディレクトリと空の帳簿なら task-0001", () => {
    assert.equal(nextTaskNumber(dir, []), "0001");
  });

  it("ファイル名の最大を見る（slug 付きも数える）", () => {
    fs.writeFileSync(path.join(dir, "task-0007-amendment-path.md"), "x", "utf-8");
    fs.writeFileSync(path.join(dir, "task-0003.md"), "x", "utf-8");
    assert.equal(nextTaskNumber(dir, []), "0008");
  });

  it("帳簿の最大も見る（ファイルが消えていても番号を再利用しない）", () => {
    assert.equal(nextTaskNumber(dir, ["task-0002", "task-0042"]), "0043");
  });

  it("task-NNNN の形でない id は数えない（試験の task-A など）", () => {
    assert.equal(nextTaskNumber(dir, ["task-A", "t-eager", "task-0009"]), "0010");
  });

  it("ディレクトリがまだ無くても落ちない", () => {
    assert.equal(nextTaskNumber(path.join(dir, "not-yet"), ["task-0005"]), "0006");
  });
});

describe("[第4便] Kobo が書いた記録は、そのまま読み戻せる", () => {
  it("引用符を含む verify が書けて、読み戻しても壊れない（inline object では壊れていた）", () => {
    const contract = {
      title: "検証コマンドに引用符が要る仕事",
      kind: "fix",
      body: "本文",
      scope: { paths: ["src/**"] },
      acceptance: [
        { id: "a1", text: "通る、こと（読点つき）", verify: 'npm test -- --grep "quoted, name"' },
        { id: "a2", text: "型が通る" },
      ],
    };
    const content = renderTaskRecord("task-0001", contract);
    const result = verifyRoundTrip("task-0001", contract, content);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
  });

  it("任意項目（hypothesis / review / governance / refs）も読み戻せる", () => {
    const contract = {
      title: "仮説つきの改善",
      kind: "improvement",
      body: "本文",
      scope: { paths: ["packages/**"] },
      acceptance: [{ id: "a1", text: "測れる" }],
      refs: ["task-0001"],
      governance: true,
      model_tier: "reasoning" as const,
      hypothesis: { expect: "落ちる回数が減る", metric: "failure_rate", horizon: "2週間" },
      review: { policy: "po" as const },
    };
    const content = renderTaskRecord("task-0009", contract);
    const result = verifyRoundTrip("task-0009", contract, content);
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
  });

  it("書けない値は**書く前に**断る（改行入りの title）", () => {
    const bad = checkWritable({
      title: "1行目\n2行目",
      kind: "fix",
      body: "本文",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "x" }],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? "" : bad.reason, /改行/);
  });
});

describe("[第4便] kobo.enqueue が唯一の入口", () => {
  let dataDir: string;
  let repoDir: string;
  let daemon: Daemon;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-se-data-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-se-repo-"));
    fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
    daemon = Daemon.create({ port: 0, dataDir, tickIntervalMs: 100_000 });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir, "default");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("積むと Kobo が採番し、記録ファイルを書き、queued になる", () => {
    const result = daemon.enqueueTask(PROJ, minimalInput(), {
      originRef: "PO の「入口を1つに」から",
      origin: "thread-1",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;

    assert.equal(result.taskId, "task-0001");
    assert.equal(result.path, path.join("work", "tasks", "task-0001.md"));
    assert.equal(result.status, "queued");

    // 記録ファイルが**実際に**在る
    const written = fs.readFileSync(path.join(repoDir, "work", "tasks", "task-0001.md"), "utf-8");
    assert.match(written, /^id: task-0001$/m);
    assert.match(written, /ここに依頼を書く/);
  });

  it("受け入れ基準の id は Kobo が a1, a2… と振る（番頭は書かない）", () => {
    const result = daemon.enqueueTask(
      PROJ,
      minimalInput({
        acceptance: [{ text: "ひとつめ" }, { text: "ふたつめ", verify: "npm run typecheck" }],
      }),
      { originRef: "経緯" }
    );
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    const task = daemon.getTask(PROJ, result.taskId);
    const acceptance = task?.["acceptance"] as Array<{ id: string; text: string }>;
    assert.deepEqual(acceptance.map((a) => a.id), ["a1", "a2"]);
  });

  it("契約は**入力から**凍る：あとから記録ファイルを直しても契約は変わらない（決定62c）", () => {
    const result = daemon.enqueueTask(PROJ, minimalInput({ title: "凍結の確認" }), {
      originRef: "経緯",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;

    const filePath = path.join(repoDir, "work", "tasks", `${result.taskId}.md`);
    fs.writeFileSync(
      filePath,
      fs.readFileSync(filePath, "utf-8").replace('paths: ["src/**"]', 'paths: ["**"]'),
      "utf-8"
    );

    const task = daemon.getTask(PROJ, result.taskId);
    const scope = task?.["scope"] as { paths: string[] };
    assert.deepEqual(scope.paths, ["src/**"], "ファイルを直しても契約は動かない");
  });

  it("宛先（origin）と経緯（originRef）が残る", () => {
    const result = daemon.enqueueTask(PROJ, minimalInput(), {
      originRef: "なぜ積むか",
      origin: "thread-9",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    if (!result.ok) return;
    const task = daemon.getTask(PROJ, result.taskId);
    assert.equal(task?.["origin"], "thread-9");
    assert.equal(task?.["originRef"], "なぜ積むか");
  });

  it("必須が欠けたら積まずに理由が返る（I2）", () => {
    const noScope = daemon.enqueueTask(
      PROJ,
      minimalInput({ scope: { paths: [] } }),
      { originRef: "経緯" }
    );
    assert.equal(noScope.ok, false);
    assert.match(noScope.ok ? "" : noScope.reason, /scope\.paths/);

    const noAcceptance = daemon.enqueueTask(PROJ, minimalInput({ acceptance: [] }), {
      originRef: "経緯",
    });
    assert.equal(noAcceptance.ok, false);
    assert.match(noAcceptance.ok ? "" : noAcceptance.reason, /acceptance/);

    const badKind = daemon.enqueueTask(PROJ, minimalInput({ kind: "chore" }), {
      originRef: "経緯",
    });
    assert.equal(badKind.ok, false);
    assert.match(badKind.ok ? "" : badKind.reason, /kind/);
  });

  it("知らないプロジェクトは、知っているものを添えて止まる", () => {
    const result = daemon.enqueueTask("shiranai", minimalInput(), { originRef: "経緯" });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /shiranai/);
  });

  it("記録ファイルが書けなかったら積まない（I2：黙って成功にしない）", async () => {
    // **書けなくする手は uid に依らないものを選ぶ。** `chmod` は root では効かない
    // ——器の中は root で走るので、そこだけ「書けてしまい」試験が割れる（実測）。
    // `work/tasks` を**ディレクトリではなく素のファイル**にすれば、誰であれ書けない
    const brokenRepo = fs.mkdtempSync(path.join(os.tmpdir(), "banto-se-broken-"));
    const brokenProj = "broken-proj";
    fs.mkdirSync(path.join(brokenRepo, "work"), { recursive: true });
    fs.writeFileSync(path.join(brokenRepo, "work", "tasks"), "これはディレクトリではない", "utf-8");

    const brokenDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-se-broken-data-"));
    const brokenDaemon = Daemon.create({ port: 0, dataDir: brokenDataDir, tickIntervalMs: 100_000 });
    await brokenDaemon.start();
    try {
      brokenDaemon.registerProject(brokenProj, brokenRepo, "default");

      const result = brokenDaemon.enqueueTask(brokenProj, minimalInput({ title: "書けない" }), {
        originRef: "経緯",
      });
      assert.equal(result.ok, false, "書けなかったのに積まれている");
      assert.match(result.ok ? "" : result.reason, /記録ファイル|採番/);

      // 帳簿にも載っていないこと
      assert.equal(brokenDaemon.getTasksByProject(brokenProj).length, 0);
    } finally {
      await brokenDaemon.stop();
      fs.rmSync(brokenRepo, { recursive: true, force: true });
      fs.rmSync(brokenDataDir, { recursive: true, force: true });
    }
  });
});

describe("[第4便] 積む口の弁（旧・取り込みの弁）", () => {
  let dataDir: string;
  let repoDir: string;
  let daemon: Daemon;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-valve-data-"));
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-valve-repo-"));
    fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
    daemon = Daemon.create({ port: 0, dataDir, tickIntervalMs: 100_000 });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir, "default");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("弁が閉じているプロジェクトへは積めない。**止めた理由がそのまま返る**", () => {
    const stopReason = "PO 指示（2026-08-13）: 番頭が直接管理する体制へ移す";
    const set = daemon.setProjectControl(PROJ, "watch", false, { reason: stopReason, by: "banto" });
    assert.equal(set.ok, true);

    const result = daemon.enqueueTask(PROJ, minimalInput(), { originRef: "経緯" });
    assert.equal(result.ok, false, "弁が閉じているのに積まれた");
    assert.match(result.ok ? "" : result.reason, /PO 指示/);

    // 弁を開ければ積める
    daemon.setProjectControl(PROJ, "watch", true, { reason: "確認のため", by: "banto" });
    const after = daemon.enqueueTask(PROJ, minimalInput(), { originRef: "経緯" });
    assert.equal(after.ok, true, after.ok ? "" : after.reason);
  });
});
