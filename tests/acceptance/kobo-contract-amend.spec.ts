/**
 * 契約は改訂できる。ただし**黙っては起きず、依存するものが差し戻る**
 * （task-0082・**決定64 の改訂**・PO 裁定 2026-08-08）。
 *
 * **なぜ改訂したか。** もとの裁定は「訂正は新しいタスクを積み、元を superseded にする」。
 * 守ろうとしたもの（「何に対して監査したのか」）は本物だが、守り方が「凍結」だった。
 * 実機で起きたこと：
 *
 *   loamium/task-0005 の受け入れ条件 a3
 *     text:   「UI の型チェックが通る」          ← **正しい**
 *     verify: `npm ci --include=dev && npm run lint` ← **ここだけ間違い**
 *
 * 基準は合っているのに確かめ方が壊れている。凍結はこの2つを区別しないので、
 * **実装のやり直し一式**を払う羽目になり、運用が「新しいタスクを立てる」に逃げて
 * **経緯が別 id に分かれた**（task-0004 → task-0005）。凍結が守ろうとしたものを
 * 凍結が壊していた。
 *
 * いまの決まり：
 *   - `verify` **だけ**の訂正 → 基準は動いていないので**監査は有効のまま**
 *   - 基準（`text`）・スコープの変更 → 監査は無効。`implementing` へ戻る
 *   - **緩める方向は PO だけ**（スコープを広げる・基準を変える・条件を消す）
 *   - 改訂は**明示的にだけ**起きる（ファイルを書き換えただけでは効かない）
 *
 * 直しを戻すと落ちることを確認済み。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const PROJ = "amendproj";
let daemon: Daemon;
let tmpDir: string;
let repoDir: string;
let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** 定義ファイルを書く。`verify` と `scope` と基準文を差し替えられる。 */
function writeTask(
  taskId: string,
  opts: { scope?: string; a1Text?: string; a1Verify?: string; extra?: string } = {}
): void {
  const {
    scope = "src/**",
    a1Text = "テストが通る",
    a1Verify = "npm test",
    extra = "",
  } = opts;
  fs.writeFileSync(
    path.join(repoDir, "work", "tasks", `${taskId}.md`),
    [
      "---",
      `id: ${taskId}`,
      "type: task",
      "kind: feature",
      `title: "${taskId}"`,
      "status: queued",
      "scope:",
      "  paths:",
      `    - ${scope}`,
      "acceptance:",
      `  - { id: a1, text: "${a1Text}", verify: "${a1Verify}" }`,
      ...(extra ? [extra] : []),
      "---",
      "",
      "本文。",
    ].join("\n"),
    "utf-8"
  );
}

/** 積んで、監査済み（approved）まで進める。 */
function enqueueAndApprove(taskId: string): void {
  const r = daemon.enqueueTaskFile(PROJ, taskId, {});
  assert.equal(r.ok, true, `積めなかった: ${JSON.stringify(r)}`);
  for (const to of ["ready", "planning", "implementing", "auditing", "review-ready", "in-review", "approved"]) {
    const t = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(t.ok, true, `${taskId} → ${to}: ${JSON.stringify(t)}`);
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-amend-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(path.join(repoDir, "work", "tasks"), { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const tools = createKoboTools(daemon);
  call = async (name, args) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool: ${name}`);
    const r = await t.execute(args as never, { toolCallId: "t" });
    return (r.details ?? {}) as Record<string, unknown>;
  };
});

after(async () => {
  await daemon.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[task-0082] 検証コマンドだけの訂正は、監査をやり直さない", () => {
  it("verify を直すと契約に反映され、**監査は有効のまま**（実装をやり直さない）", async () => {
    const id = "task-2001";
    writeTask(id, { a1Verify: "npm ci --include=dev && npm test" });
    enqueueAndApprove(id);

    // 実機の loamium/task-0005 と同じ形：基準は正しく、確かめ方だけ壊れている
    writeTask(id, { a1Verify: "npm test" });
    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "環境の用意は setup に移ったので、検証コマンドから npm ci を外す",
    });

    assert.equal(r["auditInvalidated"], false, "基準は変わっていないのに監査を無効にしている");
    assert.match((r["changes"] as string[]).join(" "), /検証コマンドを変更/);

    // **契約に実際に反映されていること**（記録だけ残って中身が古いままでは意味がない）
    const acc = daemon.getTask(PROJ, id)!["acceptance"] as Array<Record<string, unknown>>;
    assert.equal(acc[0]!["verify"], "npm test");

    // **状態は動かない**——approved のままマージ前ゲートへ進める（実装も監査もやり直さない）
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
  });

  it("改訂は経緯に残る（「何に対して監査したか」を版で答える）", async () => {
    const id = "task-2001";
    const d = await call("kobo.task", { projectTag: PROJ, taskId: id });
    const history = d["history"] as Array<{ type: string; detail: string }>;
    const amended = history.find((h) => h.type === "task_contract_amended");
    assert.ok(amended, "改訂が経緯に出ていない");
    assert.match(amended.detail, /契約を改訂/);
    assert.match(amended.detail, /監査は有効のまま/);
  });
});

describe("[task-0082] 基準やスコープが動いたら監査は無効", () => {
  it("受け入れ条件を増やすと監査は無効になり implementing へ戻る", async () => {
    const id = "task-2002";
    writeTask(id);
    enqueueAndApprove(id);

    writeTask(id, { extra: '  - { id: a2, text: "型検査も通る", verify: "npm run typecheck" }' });
    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "型検査も見ることにした",
    });

    // 増やすのは厳しくする方向だが、**監査はその条件を見ていない**
    assert.equal(r["auditInvalidated"], true);
    assert.equal(
      daemon.getTask(PROJ, id)?.status,
      "implementing",
      "基準が増えたのに approved のまま——誰も見ていない条件でマージされる"
    );
  });

  it("**中身が同じなら改訂しない**（帳簿に嘘の改訂を残さない）", async () => {
    const id = "task-2003";
    writeTask(id, { scope: "src/**" });
    enqueueAndApprove(id);

    // 一字一句同じものを書き直す
    writeTask(id, { scope: "src/**" });
    await assert.rejects(
      () => call("kobo.amend", { projectTag: PROJ, taskId: id, reason: "変えていない" }),
      /同じです/,
      "差分が無いのに改訂を記録すると、あとから「何が変わったのか」を辿れなくなる"
    );
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved", "何もしていないのに状態が動いている");
  });

  it("スコープから**パスを取り除く**のは番頭でよい（触れる範囲が確実に減る）", async () => {
    const id = "task-2009";
    writeTask(id, { scope: "src/**\n    - docs/**" });
    enqueueAndApprove(id);

    writeTask(id, { scope: "src/**" });
    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "docs は触らないことにした",
    });
    assert.match((r["changes"] as string[]).join(" "), /スコープを変更/);
    // 減らしてもスコープが動いた以上、監査は無効（見ていた範囲が違う）
    assert.equal(r["auditInvalidated"], true);
    assert.deepEqual(
      (daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths,
      ["src/**"]
    );
  });

  it("**意味としては狭いスコープでも、新しい文字列なら PO 扱い**（glob は文字列で解けない）", async () => {
    const id = "task-2010";
    writeTask(id, { scope: "src/**" });
    enqueueAndApprove(id);

    // `src/narrow/**` は `src/**` より狭いが、機械には判定させない
    writeTask(id, { scope: "src/narrow/**" });
    await assert.rejects(
      () => call("kobo.amend", { projectTag: PROJ, taskId: id, reason: "絞れると分かった" }),
      /緩める方向|PO の判断/,
      "包含関係を機械に推させると、必ずどこかで緩い側に取り違える——厳しすぎる側に倒す"
    );
  });
});

describe("[task-0082] 緩める方向は PO だけ", () => {
  it("**スコープを広げる改訂は番頭では通らない**（範囲外を事後に正当化できてしまう）", async () => {
    const id = "task-2004";
    writeTask(id, { scope: "src/**" });
    enqueueAndApprove(id);

    writeTask(id, { scope: "'**'" });
    await assert.rejects(
      () => call("kobo.amend", { projectTag: PROJ, taskId: id, reason: "全部触りたい" }),
      /緩める方向|PO の判断/,
      "番頭がスコープを広げられると、マージ前ゲートの検査が意味を失う"
    );
    // 拒否したら契約は動いていないこと
    assert.deepEqual(
      (daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths,
      ["src/**"]
    );
  });

  it("**基準そのものを変える改訂も番頭では通らない**（厳しくしたか緩めたか機械には読めない）", async () => {
    const id = "task-2005";
    writeTask(id, { a1Text: "テストが通る" });
    enqueueAndApprove(id);

    writeTask(id, { a1Text: "だいたい動く" });
    await assert.rejects(
      () => call("kobo.amend", { projectTag: PROJ, taskId: id, reason: "基準を見直した" }),
      /緩める方向|PO の判断/
    );
  });

  it("PO なら緩める改訂も通る（そのかわり監査は無効）", () => {
    const id = "task-2006";
    writeTask(id, { scope: "src/**" });
    enqueueAndApprove(id);

    writeTask(id, { scope: "'**'" });
    const r = daemon.amendTask(PROJ, id, { reason: "PO が範囲を広げると決めた", by: "po" });
    assert.equal(r.ok, true, `PO なら通るはず: ${JSON.stringify(r)}`);
    assert.equal((r as { ok: true; auditInvalidated: boolean }).auditInvalidated, true);
    assert.equal(daemon.getTask(PROJ, id)?.status, "implementing");
  });
});

describe("[task-0082] 改訂と reopen の噛み合わせ", () => {
  it("**承認のあとに基準が変わったら reverify は通らない**（変わった基準を誰も見ていない）", async () => {
    const id = "task-2007";
    writeTask(id);
    enqueueAndApprove(id);
    // 落ちた形にする
    daemon.transition(PROJ, id, "merging", "テスト");
    daemon.transition(PROJ, id, "failed", "テスト：ゲートで落ちる");

    // failed のまま基準を増やす（監査は無効になるが、終端なので状態は動かさない）
    writeTask(id, { extra: '  - { id: a2, text: "別の条件", verify: "true" }' });
    const amended = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "条件が足りていなかった",
    });
    assert.equal(amended["auditInvalidated"], true);
    assert.equal(daemon.getTask(PROJ, id)?.status, "failed", "終端のものを勝手に動かさない");

    // **ここが要点**：承認の実績はあるが、そのあと基準が動いている
    await assert.rejects(
      () => call("kobo.reopen", { projectTag: PROJ, taskId: id, mode: "reverify", reason: "環境のせい" }),
      /基準が変わって/,
      "基準が変わったあとに検証だけやり直すと、変わった基準を誰も見ないままマージされる"
    );
  });

  it("verify だけの改訂なら、承認は生きていて reverify で進める", async () => {
    const id = "task-2008";
    writeTask(id, { a1Verify: "npm ci && npm test" });
    enqueueAndApprove(id);
    daemon.transition(PROJ, id, "merging", "テスト");
    daemon.transition(PROJ, id, "failed", "テスト：ゲートで落ちる");

    writeTask(id, { a1Verify: "npm test" });
    const amended = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "環境の用意は setup に移った",
    });
    assert.equal(amended["auditInvalidated"], false);

    // **実装も監査もやり直さずに、マージ待ちへ戻せる**——これが決定64 改訂の狙い
    const r = await call("kobo.reopen", {
      projectTag: PROJ,
      taskId: id,
      mode: "reverify",
      reason: "検証コマンドを直したので、もう一度ゲートを回す",
    });
    assert.equal(r["to"], "approved");
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
  });
});
