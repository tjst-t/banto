/**
 * **証拠のあるものだけを機械に通す**（realign 第3便・PO 裁定 2026-08-14）。
 *
 * `review.policy` の既定を「番頭の承認」から自動着地へ反転する。ただし条件つきで、
 * 自動で着地してよいのは次が**両方**揃ったものだけ:
 *
 *   1. `audit_verdict` に刻みが付いている（`contractVersion` / `checklistVersion`）と、
 *      ゲート側の刻み（`baseCommit` / `environmentDigest`）
 *   2. 契約が `acceptance[].verify` を1つ以上持ち、マージ前ゲートでそれが通っている
 *
 * どちらかを欠くものは、今までどおり人（番頭または PO）の承認を通す。
 *
 * ## なぜこの条件なのか
 *
 * 帳簿にある過去の監査 pass は、**判定基準が監査人に一度も届いていない状態**で、
 * **D1 を知らない実装役**の成果に対して出されたもので、品質の証拠として使えない
 * （realign 第2便で両方塞いだ）。刻みを要求した意味は「証拠のあるものだけを機械に
 * 通させる」ことなので、証拠が無いものを黙って通すなら要求した意味がなくなる。
 * → `spec-daemon-core` §2.4・`events.ts` の `AuditVerdictEvent.contractVersion`
 *
 * ## 刻みは2か所に分かれて出る
 *
 * `contractVersion` / `checklistVersion` は監査の判定と同時に手に入るが、
 * `baseCommit` / `environmentDigest` は**ゲートの出力**で、ゲートが回るのは
 * `merging` に入ったあと。だから前者は分岐の入力、後者は**ゲートの成立条件**として扱う
 * （番頭裁定 2026-08-14：状態機械は作り替えない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  autoLandBlockers,
  gateEvidenceBlockers,
  landedWithoutHumanApproval,
  DEFAULT_REVIEW_STAGE,
} from "../../packages/banto-daemon/src/review-policy.js";
import { runMergeGate } from "../../packages/banto-daemon/src/merge-gate.js";
import { EventLog } from "../../packages/banto-core/src/index.js";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── 1. 既定が反転していること ────────────────────────────────────────────────

describe("[realign-3] 既定は自動着地", () => {
  it("`DEFAULT_REVIEW_STAGE` は `auto`", () => {
    assert.equal(DEFAULT_REVIEW_STAGE, "auto");
  });
});

// ── 2. 監査の側の証拠（分岐の入力）──────────────────────────────────────────

describe("[realign-3] 自動着地を止める理由（監査の側）", () => {
  const marked = { contractVersion: 42, checklistVersion: "abc123def456" };
  const withVerify = [{ id: "a1", text: "動くこと", verify: "npm test" }];

  it("刻みが両方あって検査もあるなら止めない", () => {
    assert.deepEqual(autoLandBlockers({ ...marked, acceptance: withVerify }), []);
  });

  it("`contractVersion` が無ければ止める（どの契約に対しての判定か分からない）", () => {
    const blockers = autoLandBlockers({
      checklistVersion: marked.checklistVersion,
      acceptance: withVerify,
    });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /contractVersion/, "何が無くて止めたのかが読めること");
  });

  it("`checklistVersion` が無ければ止める（どの基準で見たか分からない）", () => {
    const blockers = autoLandBlockers({
      contractVersion: marked.contractVersion,
      acceptance: withVerify,
    });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /checklistVersion/);
  });

  /**
   * **検査ゼロの契約はゲートが素通りする。** ゲートは契約が書いた `verify` を回すだけなので、
   * 1本も無ければ「何も確かめずに passed」になる。帳簿の契約72本中50本がこれだった。
   */
  it("契約に検査コマンドが1本も無ければ止める", () => {
    const blockers = autoLandBlockers({
      ...marked,
      acceptance: [{ id: "a1", text: "動くこと" }],
    });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /verify/, "検査が無いことが理由として読めること");
  });

  it("受け入れ条件そのものが空でも止める", () => {
    assert.equal(autoLandBlockers({ ...marked, acceptance: [] }).length, 1);
  });

  it("空文字の `verify` は「有る」に数えない", () => {
    const blockers = autoLandBlockers({
      ...marked,
      acceptance: [{ id: "a1", text: "動くこと", verify: "" }],
    });
    assert.equal(blockers.length, 1);
  });

  it("1本でも検査があれば、検査を理由には止めない", () => {
    const blockers = autoLandBlockers({
      ...marked,
      acceptance: [{ id: "a1", text: "見た目" }, { id: "a2", text: "動く", verify: "npm test" }],
    });
    assert.deepEqual(blockers, []);
  });

  it("欠けが複数あれば理由も複数出る（1つ直せば通ると読ませない）", () => {
    const blockers = autoLandBlockers({ acceptance: [] });
    assert.equal(blockers.length, 3, `理由: ${blockers.join(" / ")}`);
  });
});

// ── 3. ゲートの側の証拠 ──────────────────────────────────────────────────────

describe("[realign-3] 自動着地を止める理由（ゲートの側）", () => {
  it("両方刻めていれば止めない", () => {
    assert.deepEqual(
      gateEvidenceBlockers({ baseCommit: "0123456789ab", environmentDigest: "deadbeef" }),
      []
    );
  });

  it("`baseCommit` を刻めなければ止める", () => {
    const blockers = gateEvidenceBlockers({ environmentDigest: "deadbeef" });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /baseCommit/);
  });

  it("`environmentDigest` を刻めなければ止める", () => {
    const blockers = gateEvidenceBlockers({ baseCommit: "0123456789ab" });
    assert.equal(blockers.length, 1);
    assert.match(blockers[0]!, /environmentDigest/);
  });
});

// ── 4. 「人が見たか」を帳簿から導く ──────────────────────────────────────────

describe("[realign-3] 人の承認を経たかどうかは帳簿から導く", () => {
  const proj = "proj-land";

  /** `state_transitioned` だけを並べた最小の帳簿。 */
  function events(pairs: Array<[string, string]>, taskId = "task-1"): never {
    return pairs.map(([from, to], i) => ({
      type: "state_transitioned",
      projectTag: proj,
      taskId,
      from,
      to,
      eventId: i + 1,
      timestamp: new Date(2026, 7, 14).toISOString(),
    })) as never;
  }

  it("`auditing → merging` は人を経ていない（自動着地）", () => {
    assert.equal(
      landedWithoutHumanApproval(events([["implementing", "auditing"], ["auditing", "merging"]]), proj, "task-1"),
      true
    );
  });

  it("`approved → merging` は人が通している", () => {
    assert.equal(
      landedWithoutHumanApproval(
        events([["auditing", "review-ready"], ["review-ready", "in-review"], ["in-review", "approved"], ["approved", "merging"]]),
        proj,
        "task-1"
      ),
      false
    );
  });

  /**
   * 一度落ちて番頭が差し戻し、次は自動で着地した場合。**直近の入り方**で決める
   * ——過去に一度承認されたことを、いまの着地の証拠に流用しない。
   */
  it("承認歴があっても、直近が `auditing → merging` なら自動着地として扱う", () => {
    assert.equal(
      landedWithoutHumanApproval(
        events([
          ["in-review", "approved"],
          ["approved", "merging"],
          ["merging", "failed"],
          ["failed", "implementing"],
          ["implementing", "auditing"],
          ["auditing", "merging"],
        ]),
        proj,
        "task-1"
      ),
      true
    );
  });

  it("他のタスクの遷移に引きずられない", () => {
    const mixed = [
      ...(events([["auditing", "merging"]], "task-other") as unknown as unknown[]),
      ...(events([["approved", "merging"]], "task-1") as unknown as unknown[]),
    ] as never;
    assert.equal(landedWithoutHumanApproval(mixed, proj, "task-1"), false);
  });

  it("まだ `merging` に入っていなければ自動着地ではない", () => {
    assert.equal(landedWithoutHumanApproval(events([["implementing", "auditing"]]), proj, "task-1"), false);
  });
});

// ── 5. ゲートの非対称（本物の runMergeGate を回す）──────────────────────────

describe("[realign-3] ゲートは自動着地のときだけ刻みを要求する", () => {
  let repoDir: string;
  let dataDir: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-land-repo-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-land-data-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
    };
    git("init", "-b", "main");
    git("config", "user.email", "test@banto-test.local");
    git("config", "user.name", "banto-test");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "main.ts"), "// initial\n");
    git("add", "-A");
    git("commit", "-m", "initial");
    git("checkout", "-b", "task-branch");
    fs.writeFileSync(path.join(repoDir, "src", "work.ts"), "// work\n");
    git("add", "-A");
    git("commit", "-m", "feat");
  });

  after(() => {
    for (const log of openLogs) log.close();
    for (const d of [repoDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  });

  const proj = "proj-gate-asym";

  /** 開いた帳簿。**最後に必ず閉じる**（開きっぱなしにすると全量走行の負荷になる）。 */
  const openLogs: EventLog[] = [];

  /** 帳簿を1本用意し、そのタスクが `merging` へどう入ったかを刻む。 */
  function logWith(taskId: string, from: "auditing" | "approved"): EventLog {
    const dir = fs.mkdtempSync(path.join(dataDir, "log-"));
    const log = EventLog.open(dir);
    openLogs.push(log);
    log.append({ type: "state_transitioned", projectTag: proj, taskId, from, to: "merging", reason: "test" } as never);
    return log;
  }

  function task(id: string): Record<string, unknown> {
    return {
      id,
      projectTag: proj,
      status: "merging",
      title: `自動着地 ${id}`,
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動くこと", verify: "true" }],
    };
  }

  const gateOpts = { base: "main", branch: "task-branch", verifyProfile: "test" };

  it("自動着地で、環境の指紋が返らなければ通さない（理由が読める）", async () => {
    const log = logWith("task-auto-nodigest", "auditing");
    const result = await runMergeGate(log, task("task-auto-nodigest") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      // 指紋を返さない環境プール
      verifyRunner: hostVerifyRunner(),
    });

    assert.equal(result.passed, false, "刻めていないのに通っている");
    const reason = result.reasons.join(" ");
    assert.match(reason, /environmentDigest/, "何が無くて落ちたのかが帳簿から読めること");
    assert.doesNotMatch(reason, /verify_failed/, "検査は通っている（落ちた理由を取り違えない）");
  });

  it("自動着地で、刻みが両方揃えば通る", async () => {
    const log = logWith("task-auto-marked", "auditing");
    const result = await runMergeGate(log, task("task-auto-marked") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: hostVerifyRunner({ profileDigest: "env-digest-1" }),
    });

    assert.equal(result.passed, true, `通らなかった: ${result.reasons.join(" / ")}`);
    assert.equal(result.environmentDigest, "env-digest-1");
    assert.ok(result.baseCommit, "baseCommit も刻まれること");
  });

  /**
   * **この厳しさは auto 経路にだけ効かせる**（番頭裁定 2026-08-14）。人が見たものまで
   * 同じ基準にすると、既存の緑が理由なく落ちる。非対称は意図。
   */
  it("人の承認を経た経路は、環境の指紋が返らなくても落とさない", async () => {
    const log = logWith("task-human-nodigest", "approved");
    const result = await runMergeGate(log, task("task-human-nodigest") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: hostVerifyRunner(),
    });

    assert.equal(result.passed, true, `人が見た経路まで落ちている: ${result.reasons.join(" / ")}`);
  });

  it("自動着地でも、検査が落ちていれば理由は検査の失敗（刻みの話にすり替えない）", async () => {
    const log = logWith("task-auto-verifyfail", "auditing");
    const failing = task("task-auto-verifyfail");
    failing["acceptance"] = [{ id: "a1", text: "動くこと", verify: "exit 1" }];
    const result = await runMergeGate(log, failing as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: hostVerifyRunner({ profileDigest: "env-digest-1" }),
    });

    assert.equal(result.passed, false);
    assert.match(result.reasons.join(" "), /verify_failed/);
  });
});
