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
 *   - 改訂は**明示的にだけ**起きる
 *
 * **第4便で入口が変わった。** 定義ファイルを直してから `kobo.amend` を呼ぶ形はやめ、
 * **変えたい中身を引数で渡す**——記録ファイルは Kobo が書き直す。書き手を2人にすると、
 * どちらが契約なのかが決められなくなる（D3）。守るものは変わっていない。
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

interface Acceptance {
  id: string;
  text: string;
  verify?: string;
}

/** 積んで、監査済み（approved）まで進める。**id は Kobo が振る**ので返す。 */
function enqueueAndApprove(
  opts: {
    scope?: string[];
    a1Text?: string;
    a1Verify?: string;
    review?: { policy: "auto" | "banto" | "po" };
    environment?: string;
    model_tier?: "reasoning" | "standard" | "fast";
  } = {}
): string {
  const { scope = ["src/**"], a1Text = "テストが通る", a1Verify = "npm test" } = opts;
  const r = daemon.enqueueTask(
    PROJ,
    {
      title: "改訂の試験",
      kind: "feature",
      body: "本文。",
      scope: { paths: scope },
      acceptance: [{ text: a1Text, verify: a1Verify }],
      ...(opts.review !== undefined ? { review: opts.review } : {}),
      ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
      ...(opts.model_tier !== undefined ? { model_tier: opts.model_tier } : {}),
    },
    { originRef: "試験" }
  );
  if (!r.ok) throw new Error(`積めなかった: ${r.reason}`);
  for (const to of ["ready", "planning", "implementing", "auditing", "review-ready", "in-review", "approved"]) {
    const t = daemon.transition(PROJ, r.taskId, to, "テスト：進める");
    assert.equal(t.ok, true, `${r.taskId} → ${to}: ${JSON.stringify(t)}`);
  }
  return r.taskId;
}

/** いまの受け入れ条件（改訂は**全件**を渡すので、下敷きに使う）。 */
function acceptanceOf(taskId: string): Acceptance[] {
  return (daemon.getTask(PROJ, taskId)!["acceptance"] as Acceptance[]).map((a) => ({ ...a }));
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
  let firstId: string;

  it("verify を直すと契約に反映され、**監査は有効のまま**（実装をやり直さない）", async () => {
    // 実機の loamium/task-0005 と同じ形：基準は正しく、確かめ方だけ壊れている
    firstId = enqueueAndApprove({ a1Verify: "npm ci --include=dev && npm test" });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: firstId,
      reason: "環境の用意は setup に移ったので、検証コマンドから npm ci を外す",
      acceptance: [{ id: "a1", text: "テストが通る", verify: "npm test" }],
    });

    assert.equal(r["auditInvalidated"], false, "基準は変わっていないのに監査を無効にしている");
    assert.match((r["changes"] as string[]).join(" "), /検証コマンドを変更/);

    // **契約に実際に反映されていること**（記録だけ残って中身が古いままでは意味がない）
    assert.equal(acceptanceOf(firstId)[0]!.verify, "npm test");

    // **状態は動かない**——approved のままマージ前ゲートへ進める（実装も監査もやり直さない）
    assert.equal(daemon.getTask(PROJ, firstId)?.status, "approved");
  });

  it("記録ファイルも Kobo が書き直す（番頭が md を直す必要はない）", () => {
    const record = fs.readFileSync(path.join(repoDir, "work", "tasks", `${firstId}.md`), "utf-8");
    assert.match(record, /verify: npm test$/m);
    assert.doesNotMatch(record, /npm ci/, "古い検証コマンドが記録に残っている");
  });

  it("改訂は経緯に残る（「何に対して監査したか」を版で答える）", async () => {
    const d = await call("kobo.task", { projectTag: PROJ, taskId: firstId });
    const history = d["history"] as Array<{ type: string; detail: string }>;
    const amended = history.find((h) => h.type === "task_contract_amended");
    assert.ok(amended, "改訂が経緯に出ていない");
    assert.match(amended.detail, /契約を改訂/);
    assert.match(amended.detail, /監査は有効のまま/);
  });
});

describe("[task-0082] 基準やスコープが動いたら監査は無効", () => {
  it("受け入れ条件を増やすと監査は無効になり implementing へ戻る", async () => {
    const id = enqueueAndApprove();
    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "型検査も見ることにした",
      acceptance: [
        ...acceptanceOf(id),
        { id: "a2", text: "型検査も通る", verify: "npm run typecheck" },
      ],
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
    const id = enqueueAndApprove({ scope: ["src/**"] });

    // 一字一句同じものを渡す
    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "変えていない",
          scope: { paths: ["src/**"] },
          acceptance: acceptanceOf(id),
        }),
      /同じです/,
      "差分が無いのに改訂を記録すると、あとから「何が変わったのか」を辿れなくなる"
    );
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved", "何もしていないのに状態が動いている");
  });

  it("スコープから**パスを取り除く**のは番頭でよい（触れる範囲が確実に減る）", async () => {
    const id = enqueueAndApprove({ scope: ["src/**", "docs/**"] });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "docs は触らないことにした",
      scope: { paths: ["src/**"] },
    });
    assert.match((r["changes"] as string[]).join(" "), /スコープを変更/);
    // 減らしてもスコープが動いた以上、監査は無効（見ていた範囲が違う）
    assert.equal(r["auditInvalidated"], true);
    assert.deepEqual((daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths, ["src/**"]);
  });

  /**
   * **[task-0209] ここは task-0082 から向きを変えた。**
   * 元は「新しい文字列なら意味が狭くても PO 扱い」——`src/**` → `src/narrow/**` を
   * 断っていた。だが `src/narrow/**` に当たるファイルは1本残らず `src/**` にも当たる。
   * 「覆われている＝そのパターンで許される範囲の中にある」なら、触れる範囲は増えていない。
   * 断る理由が無いのに断ると、番頭が絞り込みを通せない（実測・task-0203 で2回）。
   * 機械で読めない形はいままでどおり PO へ倒す——下の「読めない glob」の試験がその境目。
   */
  it("[task-0209] **配下へ絞る glob は番頭でよい**（`src/**` → `src/narrow/**` は範囲が増えない）", async () => {
    const id = enqueueAndApprove({ scope: ["src/**"] });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "絞れると分かった",
      scope: { paths: ["src/narrow/**"] },
    });
    assert.match((r["changes"] as string[]).join(" "), /スコープを変更/);
    assert.equal(r["auditInvalidated"], true, "狭めてもスコープが動いた以上、監査は無効");
    assert.deepEqual((daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths, [
      "src/narrow/**",
    ]);
  });
});

describe("[task-0082] 緩める方向は PO だけ", () => {
  it("**スコープを広げる改訂は番頭では通らない**（範囲外を事後に正当化できてしまう）", async () => {
    const id = enqueueAndApprove({ scope: ["src/**"] });

    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "全部触りたい",
          scope: { paths: ["**"] },
        }),
      /緩める方向|PO の判断/,
      "番頭がスコープを広げられると、マージ前ゲートの検査が意味を失う"
    );
    // 拒否したら契約は動いていないこと
    assert.deepEqual((daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths, ["src/**"]);
  });

  it("**基準そのものを変える改訂も番頭では通らない**（厳しくしたか緩めたか機械には読めない）", async () => {
    const id = enqueueAndApprove({ a1Text: "テストが通る" });

    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "基準を見直した",
          acceptance: [{ id: "a1", text: "だいたい動く", verify: "npm test" }],
        }),
      /緩める方向|PO の判断/
    );
  });

  it("PO なら緩める改訂も通る（そのかわり監査は無効）", () => {
    const id = enqueueAndApprove({ scope: ["src/**"] });

    const r = daemon.amendTask(
      PROJ,
      id,
      { scope: { paths: ["**"] } },
      { reason: "PO が範囲を広げると決めた", by: "po" }
    );
    assert.equal(r.ok, true, `PO なら通るはず: ${JSON.stringify(r)}`);
    assert.equal((r as { ok: true; auditInvalidated: boolean }).auditInvalidated, true);
    assert.equal(daemon.getTask(PROJ, id)?.status, "implementing");
  });
});

/**
 * [task-0209] スコープの改訂を「文字列が一覧に無いか」で裁いていたので、
 * `["tests/acceptance/**"]` → `["tests/acceptance/kobo-contract-amend.spec.ts"]` という
 * **明らかな絞り込み**まで「緩める方向」に落ちて番頭が通せなかった（実測・task-0203 で2回）。
 * 読み方を変えた：**新しいパスがいまのどれかのパターンに覆われているなら広げていない**。
 * 覆われないパスが1本でもあれば、いままでどおり PO の判断。
 */
describe("[task-0209] スコープの絞り込みは番頭でよい（覆われているかで読む）", () => {
  it("**広い glob → その配下の名指しファイル**は通る（task-0203 の実測そのまま）", async () => {
    const id = enqueueAndApprove({ scope: ["tests/acceptance/**"] });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "触るのはこの1本だけだと分かった",
      scope: { paths: ["tests/acceptance/kobo-contract-amend.spec.ts"] },
    });
    assert.match((r["changes"] as string[]).join(" "), /スコープを変更/);
    // 性質3：狭めても「何に対して監査したか」は動くので、監査は無効のまま据え置き
    assert.equal(r["auditInvalidated"], true, "狭めたら監査は無効のまま据え置くこと");
    assert.deepEqual((daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths, [
      "tests/acceptance/kobo-contract-amend.spec.ts",
    ]);
  });

  it("総取り `**` の下へ絞るのも通る（どのパスも覆われている）", async () => {
    const id = enqueueAndApprove({ scope: ["**"] });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "範囲が見えたので絞る",
      scope: { paths: ["packages/banto-daemon/src/**", "docs/notes/handoff.md"] },
    });
    assert.match((r["changes"] as string[]).join(" "), /スコープを変更/);
    assert.deepEqual((daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths, [
      "packages/banto-daemon/src/**",
      "docs/notes/handoff.md",
    ]);
  });

  it("**どのパターンにも覆われないパスを足すのは、いままでどおり PO 判断**", async () => {
    const id = enqueueAndApprove({ scope: ["src/**"] });

    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "docs も触りたい",
          scope: { paths: ["src/**", "docs/**"] },
        }),
      /緩める方向|PO の判断/,
      "覆われていないパスが増えるのは、番頭がマージ前ゲートを緩めるのと同じ"
    );
    assert.deepEqual((daemon.getTask(PROJ, id)!["scope"] as { paths: string[] }).paths, ["src/**"]);
  });

  it("**1本でも覆われないものが混ざれば PO 判断**（残りが絞り込みでも通さない）", async () => {
    const id = enqueueAndApprove({ scope: ["src/**"] });

    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "src は絞るが docs を1枚だけ足したい",
          scope: { paths: ["src/daemon.ts", "docs/x.md"] },
        }),
      /緩める方向|PO の判断/,
      "絞り込みに紛れて範囲外が1本入ると、事後に正当化できてしまう"
    );
  });

  it("**機械で読めない glob 同士は覆われていない扱い**（保守側に倒す）", async () => {
    const id = enqueueAndApprove({ scope: ["src/**/*.ts"] });

    // 人が読めば `src/deep/**/*.ts` は `src/**/*.ts` の内側だが、glob 同士の包含は
    // 一般には解けない。読めないものを「覆われている」と言い張ると必ず緩い側で外す
    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "deep だけだと分かった",
          scope: { paths: ["src/deep/**/*.ts"] },
        }),
      /緩める方向|PO の判断/,
      "読めない形は PO へ回す——緩い側に取り違えるより止まる方が安全"
    );
  });

  it("スコープ以外の訂正の扱いは変えていない（検証コマンドは監査を無効にしない）", async () => {
    const id = enqueueAndApprove({ scope: ["src/**"], a1Verify: "npm ci && npm test" });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "検証コマンドだけ直す",
      acceptance: [{ id: "a1", text: "テストが通る", verify: "npm test" }],
    });
    assert.equal(r["auditInvalidated"], false, "スコープを触っていないのに監査を無効にしている");
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
  });
});

describe("[task-0082] 改訂と reopen の噛み合わせ", () => {
  it("**承認のあとに基準が変わったら reverify は通らない**（変わった基準を誰も見ていない）", async () => {
    const id = enqueueAndApprove();
    // 落ちた形にする
    daemon.transition(PROJ, id, "merging", "テスト");
    daemon.transition(PROJ, id, "failed", "テスト：ゲートで落ちる");

    // failed のまま基準を増やす（監査は無効になるが、終端なので状態は動かさない）
    const amended = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "条件が足りていなかった",
      acceptance: [...acceptanceOf(id), { id: "a2", text: "別の条件", verify: "true" }],
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
    const id = enqueueAndApprove({ a1Verify: "npm ci && npm test" });
    daemon.transition(PROJ, id, "merging", "テスト");
    daemon.transition(PROJ, id, "failed", "テスト：ゲートで落ちる");

    const amended = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "環境の用意は setup に移った",
      acceptance: [{ id: "a1", text: "テストが通る", verify: "npm test" }],
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

/**
 * **渡せるのに効かない項目が3つあった**（imp-0039・実機 dentaku task-0015 / task-0016）。
 *
 * `amendTask` は `review` / `environment` / `model_tier` を契約へ重ねていたが、差分を
 * 数える `classifyAmendment` は acceptance / scope / title / body しか見ていなかった。
 * よって `changes` が空になり、**中身は違うのに「渡された中身と同じです」**で断られる
 * ——理由が嘘になっていた。断り文が嘘だと、番頭は取次へ上げる判断ができない。
 */
describe("[imp-0039] review / environment / model_tier も差分として読む", () => {
  it("**`po` → `auto` は「緩める方向」で断る**（「同じ中身です」ではない）", async () => {
    const id = enqueueAndApprove({ review: { policy: "po" } });

    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "PO の方針が変わり、連作は自動着地でよくなった",
          review: { policy: "auto" },
        }),
      (err: Error) => {
        assert.match(err.message, /緩める方向|PO の判断/, "断る理由が「緩める方向」になっていない");
        assert.doesNotMatch(
          err.message,
          /同じです/,
          "違うものを「同じ」と言っている——番頭はこれを読んでも取次へ上げられない"
        );
        return true;
      }
    );
    // 断ったなら契約は動いていないこと
    assert.equal(
      (daemon.getTask(PROJ, id)!["review"] as { policy: string }).policy,
      "po"
    );
  });

  it("同じ改訂を **PO として**渡すと通り、契約も記録ファイルも `auto` になる", () => {
    const id = enqueueAndApprove({ review: { policy: "po" } });

    const r = daemon.amendTask(
      PROJ,
      id,
      { review: { policy: "auto" } },
      { reason: "PO が「連作は自動着地でよい」と決めた", by: "po" }
    );
    assert.equal(r.ok, true, `PO なら通るはず: ${JSON.stringify(r)}`);
    assert.match((r as { ok: true; changes: string[] }).changes.join(" "), /レビュー方針/);

    assert.equal((daemon.getTask(PROJ, id)!["review"] as { policy: string }).policy, "auto");
    const record = fs.readFileSync(path.join(repoDir, "work", "tasks", `${id}.md`), "utf-8");
    assert.match(record, /^ {2}policy: auto$/m, "記録ファイルが古い方針のまま");
  });

  it("**`auto` → `po`（厳しくする向き）は番頭でも通る**。監査は無効にしない", async () => {
    const id = enqueueAndApprove({ review: { policy: "auto" } });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "統治に触るので PO に見てもらう",
      review: { policy: "po" },
    });
    assert.match((r["changes"] as string[]).join(" "), /レビュー方針を変更/);
    // 何に対して監査したかは変わっていない——やり直させない
    assert.equal(r["auditInvalidated"], false);
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
  });

  it("方針を名乗っていない契約へ `po` を足すのも番頭でよい（いま効いている段より厳しい）", async () => {
    const id = enqueueAndApprove();

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "PO に見てもらうことにした",
      review: { policy: "po" },
    });
    assert.match((r["changes"] as string[]).join(" "), /レビュー方針/);
    assert.equal((daemon.getTask(PROJ, id)!["review"] as { policy: string }).policy, "po");
  });

  it("**`environment` は番頭が通せるが、監査は無効**（前の監査は別の環境で取った証拠）", async () => {
    const id = enqueueAndApprove({ environment: "test" });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "docker の要る検証なのでプロファイルを変える",
      environment: "test-docker",
    });
    assert.match((r["changes"] as string[]).join(" "), /検証環境を変更/);
    assert.equal(r["auditInvalidated"], true);
    assert.equal(
      daemon.getTask(PROJ, id)?.status,
      "implementing",
      "別の環境で取った証拠のまま approved に残ると、誰も見ていない環境でマージされる"
    );
    assert.equal(daemon.getTask(PROJ, id)!["environment"], "test-docker");
  });

  it("**`model_tier` は通るが監査は無効にしない**（何を確かめるかは変わらない）", async () => {
    const id = enqueueAndApprove({ model_tier: "standard" });

    const r = await call("kobo.amend", {
      projectTag: PROJ,
      taskId: id,
      reason: "難しい仕事だったので段を上げる",
      model_tier: "reasoning",
    });
    assert.match((r["changes"] as string[]).join(" "), /モデルの段を変更/);
    assert.equal(r["auditInvalidated"], false);
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
    assert.equal(daemon.getTask(PROJ, id)!["model_tier"], "reasoning");
  });

  it("3項目のどれも実際には変わらないなら、これまでどおり「同じです」で断る（I2）", async () => {
    const id = enqueueAndApprove({
      review: { policy: "banto" },
      environment: "test",
      model_tier: "standard",
    });

    await assert.rejects(
      () =>
        call("kobo.amend", {
          projectTag: PROJ,
          taskId: id,
          reason: "変えていない",
          review: { policy: "banto" },
          environment: "test",
          model_tier: "standard",
        }),
      /同じです/,
      "差分が無いのに改訂を記録すると、帳簿に嘘の改訂が残る"
    );
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
  });
});
