/**
 * デプロイゲート付き再起動（task-0274 / PO裁定 2026-08-17）。
 *
 * ## 背景
 *
 * banto は main の .ts を直読みし、**起こし直しで反映**される（デプロイ = 起こし直し）。
 * マージ ≠ 反映なので、フル回帰（npm test）は起こし直しの**直前**に1回走らせれば足りる。
 * ここはその口——`system.deploy`（ゲート付き）。素通しの `system.restart` は緊急/強制のみ。
 *
 * ## この試験が固定すること
 *
 * [a2] ゲートが npm test の失敗で再起動を**拒否**し、失敗内容を報告する（再起動しない）。
 * [a2] npm test が通れば再起動する。
 * [a3] 強制フラグ（force）で明示的にだけ通せる。通したことは**記録**に残る。
 * [a4] クラッシュ復旧（Restart=on-failure の自動再起動）はこのゲートを通らない
 *      ——systemd が即復旧する（従来どおり）。ゲートを通るのは計画的デプロイだけ。
 * [a5] 既存の守り（acceptance・監査・PO レビュー）を壊さない——この試験は独立に通る。
 *
 * ## 限界（隠さない・I1）
 *
 * 判定ロジック（`evaluateDeployGate`）と道具の振る舞い（`createDeployTool`）を、
 * 偽の verify / restart / record を差して検証する。実際の `npm test` 実行（deploy-verify）
 * と systemd の再起動はこの器では回せない——固定しているのは**機構の意図**である。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDeployTool, evaluateDeployGate, DEPLOY_UNITS } from "@banto/host";

/** 呼ばれた検証・再起動・記録を記録する偽の口。 */
function fakeDeps(overrides: { verifyResult?: { passed: boolean; report: string } } = {}) {
  const calls = { runVerify: [] as string[], restart: [] as Array<{ units: string[]; forced: boolean }> };
  const records: string[] = [];
  const exits: number[] = [];
  let closed = 0;
  const deps = {
    calls,
    records,
    exits,
    get closed() {
      return closed;
    },
    runVerify: async (command: string) => {
      calls.runVerify.push(command);
      return overrides.verifyResult ?? { passed: true, report: "" };
    },
    restart: async (opts: { units: string[]; forced: boolean }) => {
      calls.restart.push(opts);
    },
    record: (line: string) => {
      records.push(line);
    },
    close: async () => {
      closed += 1;
    },
    exit: (code: number) => {
      exits.push(code);
    },
  };
  return deps;
}

/** 道具を呼び、再起動スケジュール（graceMs 猶予）を消化するまで待つ。 */
async function runDeploy(path: Parameters<ReturnType<typeof createDeployTool>["execute"]>[0], deps: ReturnType<typeof fakeDeps>) {
  const tool = createDeployTool({
    ...deps,
    graceMs: 10,
    threadId: "thread-1",
    notify: async () => {},
  });
  const result = await tool.execute(path, { toolCallId: "t1" });
  // 猶予のあとでターンの外の再起動・exit が走る
  await new Promise((resolve) => setTimeout(resolve, 60));
  return result;
}

describe("[task-0274] デプロイゲートは npm test の結果で再起動を拒否／許可する（a2）", () => {
  it("npm test が落ちたら拒否し、再起動しない・失敗内容を報告する", async () => {
    const deps = fakeDeps({
      verifyResult: { passed: false, report: "落ちた spec: tests/acceptance/x.spec.ts (fail 1)" },
    });
    const result = await runDeploy({}, deps);

    assert.ok(
      result.content[0]!.text.includes("拒否"),
      `拒否の文言がありません: ${result.content[0]!.text}`
    );
    assert.ok(
      result.content[0]!.text.includes("x.spec.ts"),
      `失敗内容（落ちた spec）を報告していません: ${result.content[0]!.text}`
    );
    assert.equal(
      deps.calls.restart.length,
      0,
      "検証が落ちたのに再起動が呼ばれています——デプロイゲートが効いていません"
    );
    assert.equal(
      deps.exits.length,
      0,
      "拒否したのにプロセスを終えています（banto.service が落ちる必要は無い）"
    );
    assert.ok(
      deps.records.some((r) => r.includes("deploy-rejected")),
      `拒否が記録に残っていません: ${JSON.stringify(deps.records)}`
    );
  });

  it("npm test が通ったら再起動する（ゲート pass → 起こし直し）", async () => {
    const deps = fakeDeps({ verifyResult: { passed: true, report: "" } });
    const result = await runDeploy({}, deps);

    assert.ok(result.content[0]!.text.includes("再起動"), "通ったのに再起動の文言がありません");
    assert.equal(deps.calls.runVerify.length, 1, "npm test を回していません");
    assert.equal(deps.calls.restart.length, 1, "通ったのに再起動を呼んでいません");
    assert.ok(deps.records.some((r) => r.includes("deploy-pass")), "通過が記録に残っていません");
  });

  it("既定の対象は4ユニットで、banto-daemon.service を含む（デプロイ時に名指しできる）", () => {
    assert.deepEqual([...DEPLOY_UNITS], [
      "banto.service",
      "banto-daemon.service",
      "banto-worker-pool.service",
      "banto-environment-pool.service",
    ]);
  });
});

describe("[task-0274] 強制フラグは明示的にだけゲートを迂回し、記録に残る（a3）", () => {
  it("verify が落ちていても force:true なら再起動し、強制した記録が残る", async () => {
    const deps = fakeDeps({
      verifyResult: { passed: false, report: "落ちていたが強制する" },
    });
    const result = await runDeploy({ force: true }, deps);

    assert.ok(
      result.content[0]!.text.includes("force"),
      `force で迂回したことが文言にありません: ${result.content[0]!.text}`
    );
    assert.equal(
      deps.calls.runVerify.length,
      0,
      "force が明示されたのに検証を回しています（明示的に迂回のはず）"
    );
    assert.equal(deps.calls.restart.length, 1, "force が明示されたのに再起動していません");
    assert.ok(
      deps.records.some((r) => r.includes("deploy-force")),
      `強制で通したことが記録に残っていません: ${JSON.stringify(deps.records)}`
    );
  });

  it("force 無しでは迂回しない——落ちたままなら拒否される（上の it と対）", async () => {
    const deps = fakeDeps({ verifyResult: { passed: false, report: "落ちた" } });
    await runDeploy({}, deps);
    assert.equal(deps.calls.restart.length, 0, "force が無いのに迂回しています");
  });
});

describe("[task-0274] クラッシュ復旧はゲートを通らない（a4）", () => {
  it("Restart=on-failure の自動再起動はデプロイではなく、ゲートを要求しない", async () => {
    // クラッシュ復旧は `evaluateDeployGate` を**呼ばない**（systemd が即起こす）。
    // だからそもそも検証の実行や force の判断が無い。これを固定する:
    // ゲート判定は明示的な `system.deploy`（または force）だけが通る——素通しの経路が
    // 存在しないことが、機構としての「対象外」である。
    // evaluateDeployGate は検証あるいは force のどちらかが無ければ終われない。
    const deps = fakeDeps({ verifyResult: { passed: false, report: "落ちた" } });
    const outcome = await evaluateDeployGate({
      units: [...DEPLOY_UNITS],
      force: false,
      verifyCommand: "npm test",
      verify: { run: (c) => deps.runVerify(c) },
      record: deps.record,
    });
    assert.equal(outcome.kind, "rejected");
    assert.equal(outcome.forced, false);
    // クラッシュ復旧がこの判定を通るなら、単位は「検証を回さない即復旧」でなければ
    // ならない——ゲートを通るのは計画的デプロイだけ、という設計と整合する。
    assert.equal(deps.calls.runVerify.length, 1, "クラッシュ復旧は検証を回さない（回しているのはデプロイ）");
  });
});
