/**
 * デプロイゲートの検証実行が maxBuffer を超えても壊れない（task-0299）。
 *
 * ## 背景
 *
 * `runDeployVerify` は `execFile` を maxBuffer 未指定（既定 1MiB）で呼んでいた。
 * `npm test` の通常出力は実測 1.74MiB で、1件も落ちていなくても出力サイズだけで
 * `system.deploy` が機械的に拒否していた（journal に deploy-pass が一件も無い）。
 * さらに失敗抽出の目印が広すぎて、意図的な `Error: connect ECONNREFUSED`（package.json
 * の test スクリプトが到達不能アドレスへ向けている）や合格行の説明文にヒットしていた。
 *
 * ## この試験が固定すること
 *
 * [a1] 1MiBを超える出力を出す検証コマンドが成功したら passed:true を返す。
 * [a2] 合格行だけのログ（✔ ... error: not_found / Error: connect ECONNREFUSED を含む）
 *      からは「落ちた箇所」を何も拾わない。
 * [a3] 本物の not ok 行がログの後方（30行目以降）にあっても報告に現れる。
 * [a4] maxBuffer超過・テスト失敗が、報告の文面で区別できる。
 * [a5] 失敗時の生ログがファイルへ残り、そのパスが report に含まれる。
 *
 * ## 限界（隠さない・I1）
 *
 * maxBuffer超過の再現に `yes`（coreutils）を使う。CI/検証環境に無ければこの一件だけ
 * 落ちる——固定しているのは「64MiBを実際に超えたときの分岐」であって `yes` そのものの
 * 存在ではない。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDeployVerify } from "../../packages/banto-host/src/deploy-verify.js";

/** 使い捨ての node スクリプトを作り、パスを返す。 */
function writeScript(body: string): string {
  const file = path.join(
    os.tmpdir(),
    `deploy-verify-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(file, body, "utf8");
  return file;
}

describe("[task-0299] runDeployVerify は maxBuffer を正しく扱う", () => {
  it("1MiBを超える出力を出すコマンドが成功したら passed:true を返す（a1）", async () => {
    const script = writeScript(
      `const chunk = "x".repeat(1024 * 1024);\nfor (let i = 0; i < 3; i++) process.stdout.write(chunk);\nprocess.exit(0);\n`
    );
    const result = await runDeployVerify(`node ${script}`, process.cwd());
    assert.equal(result.passed, true, `passed:true を期待したが: ${JSON.stringify(result)}`);
    fs.unlinkSync(script);
  });

  it("合格行だけのログからは落ちた箇所を何も拾わない（a2）", async () => {
    const script = writeScript(
      [
        `console.log("✔ [AC-1] GET non-existent task returns 404 with error: not_found");`,
        `console.log("Error: connect ECONNREFUSED 127.0.0.1:1");`,
        `console.log("Error: connect ECONNREFUSED 127.0.0.1:1");`,
        `process.exit(1);`,
      ].join("\n")
    );
    const result = await runDeployVerify(`node ${script}`, process.cwd());
    assert.equal(result.passed, false);
    assert.ok(
      !result.report.includes("落ちた箇所"),
      `合格行だけなのに「落ちた箇所」を拾っています: ${result.report}`
    );
    fs.unlinkSync(script);
  });

  it("本物の not ok 行がログの後方（30行目以降）にあっても報告に現れる（a3）", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 35; i++) lines.push(`console.log("info line ${i}");`);
    lines.push(`console.log("not ok 1 - real failure happened here");`);
    lines.push("process.exit(1);");
    const script = writeScript(lines.join("\n"));
    const result = await runDeployVerify(`node ${script}`, process.cwd());
    assert.equal(result.passed, false);
    assert.ok(
      result.report.includes("real failure happened here"),
      `後方の本物の失敗が報告に現れていません: ${result.report}`
    );
    fs.unlinkSync(script);
  });

  it("maxBuffer超過とテスト失敗は文面で区別できる（a4）", async () => {
    const failScript = writeScript(`console.log("not ok 1 - x");\nprocess.exit(1);\n`);
    const failResult = await runDeployVerify(`node ${failScript}`, process.cwd());
    const overflowResult = await runDeployVerify("yes", process.cwd());

    assert.equal(failResult.passed, false);
    assert.equal(overflowResult.passed, false);
    assert.notEqual(failResult.report, overflowResult.report);
    assert.ok(
      overflowResult.report.includes("上限"),
      `maxBuffer超過の文言がありません: ${overflowResult.report}`
    );
    assert.ok(
      !failResult.report.includes("上限"),
      `テスト失敗なのに上限の文言が混ざっています: ${failResult.report}`
    );
    fs.unlinkSync(failScript);
  });

  it("失敗時の生ログがファイルへ残り、パスが report に含まれる（a5）", async () => {
    const script = writeScript(`console.log("not ok 1 - x");\nprocess.exit(1);\n`);
    const result = await runDeployVerify(`node ${script}`, process.cwd());
    const match = result.report.match(/生ログ: (\S+)/);
    assert.ok(match, `生ログのパスが report に含まれていません: ${result.report}`);
    assert.ok(fs.existsSync(match![1]!), `生ログファイルが存在しません: ${match![1]}`);
    fs.unlinkSync(script);
  });
});
