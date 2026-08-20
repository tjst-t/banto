/**
 * デプロイゲートの失敗抽出に残った穴を塞ぐ（task-0311）。
 *
 * ## 背景
 *
 * task-0299 は maxBuffer と、素の `Error:` を目印から外す直しを着地させた
 * （tests/acceptance/deploy-verify-maxbuffer.spec.ts）。しかしそれでもなお
 * 2026-08-20 08:15:34 の実デプロイ拒否では「落ちた箇所」がノイズ行ばかりで、
 * どの spec が落ちたのか分からなかった。実測（検証環境で `node -e` を実行）で
 * 確認した残りの穴は3つ：
 *
 * 1. `FAILED` の目印に `i` フラグが付いているため、`Failed to reach module ...`
 *    のようなノイズ行や `✔ ... returns FAILED status` のような合格行にも当たる。
 *    同様に `ok 3 - handles failing tests gracefully` は `failing tests?` に当たる。
 * 2. キャップ（先頭30件）が除外前に効くわけではないが、除外が不十分なせいで
 *    ノイズ・合格行がキャップを埋め、本物の失敗が押し出される。押し出されたことも
 *    報告に出ない。
 * 3. 生ログが `os.tmpdir()`（揮発する）に書かれ、置き場所を差し替える口も無い。
 * 4. `persistRawLog` の書き込み失敗が try/catch に包まれておらず、ログが書けない
 *    だけで `runDeployVerify` の外へ例外が抜ける。
 *
 * ## この試験が固定すること
 *
 * [a1] 合格行（✔/✓ 始まり、TAP の `ok ` 始まり）は本文に何が書いてあっても
 *      失敗行として抽出されない。
 * [a2] 既知ノイズ（Failed to reach module / ECONNREFUSED 127.0.0.1:1 /
 *      への接続に失敗 / verify_env_unavailable）は失敗行として抽出されない。
 * [a3] ノイズが数百行先行していても、後方の本物の失敗行（not ok /
 *      AssertionError）が報告に出る。上限で打ち切ったときは「他に N 件」が出る。
 * [a4] 生ログは BANTO_DATA_DIR 配下の deploy-verify/ へ、または runDeployVerify の
 *      第3引数オプションで差し替えた先へ保存される。ディレクトリが無ければ作られる。
 * [a5] 生ログの保存に失敗しても runDeployVerify は例外を投げず passed:false を返し、
 *      報告に「生ログの保存に失敗: <理由>」が1行載る。
 *
 * ## 限界（隠さない・I1）
 *
 * 生ログの保存失敗は、書き込み不能なパス（存在しないファイルをディレクトリとして
 * 指定する）を使って再現する。実ディスクの権限エラーそのものではない——固定して
 * いるのは「persistRawLog が投げても runDeployVerify が握って判定を返す」という
 * 分岐であって、失敗の起こり方の網羅ではない。
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
    `deploy-verify-extraction-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`
  );
  fs.writeFileSync(file, body, "utf8");
  return file;
}

/** テスト専用の一時ディレクトリを作り、後始末できるようパスを返す。 */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

describe("[task-0311] runDeployVerify の失敗抽出・生ログ保存", () => {
  it("合格行・既知ノイズを除いて本物の失敗行だけを報告する（a1・a2）", async () => {
    const rawLogDir = makeTempDir("deploy-verify-a1a2");
    const script = writeScript(
      [
        `console.log('[banto-daemon] 検証環境の写しを取り直せませんでした: Failed to reach module "environment-pool" at http://127.0.0.1:1/');`,
        `console.log('[banto] module "environment-pool" への接続に失敗（timeout）: Error: connect ECONNREFUSED 127.0.0.1:1');`,
        `console.log('  reason: verify_env_unavailable');`,
        `console.log('✔ [AC-S654396-3-1] returns FAILED status when not_found (12ms)');`,
        `console.log('ok 3 - handles failing tests gracefully');`,
        `console.log('not ok 2 - some spec');`,
        `process.exit(1);`,
      ].join("\n")
    );
    const result = await runDeployVerify(`node ${script}`, process.cwd(), { rawLogDir });
    assert.equal(result.passed, false);
    assert.ok(
      result.report.includes("not ok 2 - some spec"),
      `本物の失敗行が報告に出ていません: ${result.report}`
    );
    assert.ok(
      !result.report.includes("Failed to reach module"),
      `既知ノイズ（Failed to reach module）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("ECONNREFUSED"),
      `既知ノイズ（ECONNREFUSED）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("verify_env_unavailable"),
      `既知ノイズ（verify_env_unavailable）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("returns FAILED status"),
      `合格行（✔ ...FAILED...）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("handles failing tests gracefully"),
      `合格行（ok ...failing tests...）が報告に混ざっています: ${result.report}`
    );
    fs.unlinkSync(script);
  });

  it("ノイズが数百行先行していても後方の本物の失敗行が報告に出る（a3）", async () => {
    const rawLogDir = makeTempDir("deploy-verify-a3-noise");
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`console.log('[banto] module "environment-pool" への接続に失敗（${i}）');`);
    }
    lines.push(`console.log('not ok 1 - real failure behind the noise');`);
    lines.push("process.exit(1);");
    const script = writeScript(lines.join("\n"));
    const result = await runDeployVerify(`node ${script}`, process.cwd(), { rawLogDir });
    assert.equal(result.passed, false);
    assert.ok(
      result.report.includes("real failure behind the noise"),
      `ノイズに埋もれて本物の失敗が消えています: ${result.report}`
    );
    fs.unlinkSync(script);
  });

  it("本物の失敗行が上限を超えるとき「他に N 件」が報告に出る（a3）", async () => {
    const rawLogDir = makeTempDir("deploy-verify-a3-cap");
    const lines: string[] = [];
    const totalFailures = 35;
    for (let i = 0; i < totalFailures; i++) {
      lines.push(`console.log('not ok ${i} - failure number ${i}');`);
    }
    lines.push("process.exit(1);");
    const script = writeScript(lines.join("\n"));
    const result = await runDeployVerify(`node ${script}`, process.cwd(), { rawLogDir });
    assert.equal(result.passed, false);
    const omitted = totalFailures - 30;
    assert.ok(
      result.report.includes(`他に ${omitted} 件`),
      `打ち切った件数（他に ${omitted} 件）が報告に出ていません: ${result.report}`
    );
    fs.unlinkSync(script);
  });

  it("生ログはオプションで指定したディレクトリへ保存され、パスが報告に載る（a4）", async () => {
    const rawLogDir = makeTempDir("deploy-verify-a4-option");
    const script = writeScript(`console.log('not ok 1 - x');\nprocess.exit(1);\n`);
    const result = await runDeployVerify(`node ${script}`, process.cwd(), { rawLogDir });
    assert.equal(result.passed, false);
    const match = result.report.match(/生ログ: (\S+)/);
    assert.ok(match, `生ログのパスが報告に含まれていません: ${result.report}`);
    const logPath = match![1]!;
    assert.ok(
      logPath.startsWith(rawLogDir),
      `生ログが指定ディレクトリの外に書かれています: ${logPath} (期待: ${rawLogDir} 配下)`
    );
    assert.ok(fs.existsSync(logPath), `生ログファイルが存在しません: ${logPath}`);
    fs.unlinkSync(script);
  });

  it("オプション未指定なら BANTO_DATA_DIR 配下の deploy-verify/ へ保存される（a4）", async () => {
    const dataDir = makeTempDir("deploy-verify-a4-envvar");
    const previous = process.env["BANTO_DATA_DIR"];
    process.env["BANTO_DATA_DIR"] = dataDir;
    const script = writeScript(`console.log('not ok 1 - x');\nprocess.exit(1);\n`);
    try {
      const result = await runDeployVerify(`node ${script}`, process.cwd());
      assert.equal(result.passed, false);
      const match = result.report.match(/生ログ: (\S+)/);
      assert.ok(match, `生ログのパスが報告に含まれていません: ${result.report}`);
      const logPath = match![1]!;
      const expectedDir = path.join(dataDir, "deploy-verify");
      assert.ok(
        logPath.startsWith(expectedDir),
        `生ログが BANTO_DATA_DIR/deploy-verify の外に書かれています: ${logPath} (期待: ${expectedDir} 配下)`
      );
      assert.ok(fs.existsSync(logPath), `生ログファイルが存在しません: ${logPath}`);
    } finally {
      if (previous === undefined) delete process.env["BANTO_DATA_DIR"];
      else process.env["BANTO_DATA_DIR"] = previous;
      fs.unlinkSync(script);
    }
  });

  it("生ログの保存に失敗しても例外を投げず passed:false と保存失敗の1行を返す（a5）", async () => {
    // 既存のファイルをディレクトリとして使わせることで mkdir を必ず失敗させる
    // （書き込み不能なパスの再現——実ディスクの権限エラーそのものではない）。
    const blockerFile = path.join(os.tmpdir(), `deploy-verify-a5-blocker-${Date.now()}.txt`);
    fs.writeFileSync(blockerFile, "not a directory", "utf8");
    const unwritableRawLogDir = path.join(blockerFile, "deploy-verify");

    const script = writeScript(`console.log('not ok 1 - x');\nprocess.exit(1);\n`);
    try {
      const result = await runDeployVerify(`node ${script}`, process.cwd(), {
        rawLogDir: unwritableRawLogDir,
      });
      assert.equal(result.passed, false);
      assert.ok(
        result.report.includes("生ログの保存に失敗:"),
        `保存失敗の1行が報告に出ていません: ${result.report}`
      );
      assert.ok(
        !result.report.includes("生ログ: "),
        `保存に失敗したのに生ログパスがあるかのような文言が出ています: ${result.report}`
      );
    } finally {
      fs.unlinkSync(blockerFile);
      fs.unlinkSync(script);
    }
  });

  // task-0313: 2026-08-20 のデプロイ拒否の生ログ（13,566行）から採った実物の9行。
  // ノイズ3行・`▶` 見出し行・`✔` 合格行3行は落ち、`✖` の行と AssertionError の行だけが
  // 報告に残ることを固定する（`▶` の見出し誤検知と `✖`（U+2716）の目印漏れの穴塞ぎ）。
  it("実物の生ログ9行から ▶ 見出しと ✔ 合格行を除き、✖ の行だけを本物の失敗として報告する", async () => {
    const rawLogDir = makeTempDir("deploy-verify-heading-and-x-mark");
    const rawLines = [
      '[banto-daemon] 検証環境の写しを取り直せませんでした: Failed to reach module "environment-pool" at http://127.0.0.1:1/api/environment-pool/tools/env.list: Error: connect ECONNREFUSED 127.0.0.1:1',
      '[banto-daemon] audit-advisory-proj/task-a1-1: 前倒しの検証に到達できませんでした（verify_env_unavailable:test（Failed to reach module "environment-pool"',
      '[banto] module "environment-pool" への接続に失敗（connect、1回目）。50ms後に再試行します: Error: connect ECONNREFUSED 127.0.0.1:1',
      '▶ [a1・a4] 判定を出さずに報告しても failed にならず、次段へ進む',
      '  ✔ audit_report を呼ばずに done:true で報告 → failed にならず review.policy 通りに進む (290.158383ms)',
      '✔ [a1・a4] 判定を出さずに報告しても failed にならず、次段へ進む (409.852873ms)',
      '  ✔ 本物の not ok 行がログの後方（30行目以降）にあっても報告に現れる（a3） (50.204191ms)',
      '✖ BANTO_BROWSER_ALLOW_NO_SANDBOX が無ければ --no-sandbox は入らず、status も enabled (118.203175ms)',
      '  AssertionError [ERR_ASSERTION]: 既定なのに --no-sandbox が入っている',
    ];
    const script = writeScript(
      rawLines.map((line) => `console.log(${JSON.stringify(line)});`).join("\n") + "\nprocess.exit(1);\n"
    );
    const result = await runDeployVerify(`node ${script}`, process.cwd(), { rawLogDir });
    assert.equal(result.passed, false);

    assert.ok(
      !result.report.includes("Failed to reach module"),
      `既知ノイズ（Failed to reach module）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("verify_env_unavailable"),
      `既知ノイズ（verify_env_unavailable）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("への接続に失敗"),
      `既知ノイズ（への接続に失敗）が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("▶ [a1・a4] 判定を出さずに報告しても failed にならず、次段へ進む"),
      `▶ の見出し行が失敗として報告に混ざっています: ${result.report}`
    );
    assert.ok(
      !result.report.includes("✔"),
      `✔ の合格行が報告に混ざっています: ${result.report}`
    );
    assert.ok(
      result.report.includes(
        "✖ BANTO_BROWSER_ALLOW_NO_SANDBOX が無ければ --no-sandbox は入らず、status も enabled (118.203175ms)"
      ),
      `✖（U+2716）の失敗行が報告に出ていません: ${result.report}`
    );
    assert.ok(
      result.report.includes("AssertionError [ERR_ASSERTION]: 既定なのに --no-sandbox が入っている"),
      `AssertionError の行が報告に出ていません: ${result.report}`
    );
    fs.unlinkSync(script);
  });
});
