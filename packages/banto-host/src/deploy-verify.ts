/**
 * デプロイゲートの検証一式を実行する（task-0274）。
 *
 * main のチェックアウト（cwd）に対して `npm test` を回し、pass したかと失敗内容
 * （落ちた spec の行・終了コード）を返す。シェルを介さず引数配列で呼ぶ（D6・
 * git-tools.ts と同じ方針——注入の余地を作らない）。
 *
 * ホストは main の .ts を直読して走っているので、起こし直しの**直前**にこの回帰を
 * 1回回すのがデプロイゲートの趣旨（マージ前は変更対象 spec + typecheck だけ）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/** stdout/stderr の上限（既定 1MiB は `npm test` の通常出力（実測 1.74MiB）で恒常的に超える）。 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** 失敗した spec を拾う目印（node:test / 一般のテストランナー双方）。素の `Error:` は
 *  意図的な接続失敗（例 `Error: connect ECONNREFUSED`）にもヒットするため含めない。 */
const FAILURE_MARKERS = /(fail [0-9]+|# fail|not ok|✗|FAILED|AssertionError|npm ERR!|failing tests?)/i;

/** 失敗内容を取り出す（ノイズを除いたあとで先頭30件に絞る——本物の失敗を押し出さない）。 */
function extractFailures(output: string, exitCode: number): string {
  const lines = output.split("\n");
  const hit = lines.filter((line) => FAILURE_MARKERS.test(line.trim()));
  const shown = hit.slice(0, 30);
  if (shown.length > 0) return `落ちた箇所:\n${shown.join("\n")}`;
  return `終了コード ${exitCode} で失敗（fail 行は拾えなかった）`;
}

/** 失敗時の生ログをファイルへ残し、そのパスを返す。 */
function persistRawLog(output: string): string {
  const file = path.join(os.tmpdir(), `banto-deploy-verify-${Date.now()}.log`);
  fs.writeFileSync(file, output, "utf8");
  return file;
}

/** 既定は npm test 一式（フル回帰。起こし直し前に1回だけ回す）。 */
export async function runDeployVerify(
  cmd: string,
  cwd: string
): Promise<{ passed: boolean; report: string }> {
  // `npm test` のような `npm <script>` 形式を argv へ分解する（シェル不要）
  const argv = cmd.trim().split(/\s+/);
  const exe = argv.shift() ?? "npm";
  try {
    await execFileAsync(exe, argv, { cwd, timeout: 20 * 60_000, maxBuffer: MAX_BUFFER_BYTES });
    return { passed: true, report: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string | null };
    const output = [e.stdout ?? "", e.stderr ?? ""].join("\n");
    const logPath = persistRawLog(output);

    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        passed: false,
        report: `検証コマンドの出力が上限（${MAX_BUFFER_BYTES}バイト）を超えて打ち切られました（合否は不明のため拒否）。生ログ: ${logPath}`,
      };
    }
    if (e.killed && e.signal) {
      return {
        passed: false,
        report: `検証コマンドが時間切れで打ち切られました（signal ${e.signal}）。生ログ: ${logPath}`,
      };
    }

    const code = typeof e.code === "number" ? e.code : 1;
    return { passed: false, report: `${extractFailures(output, code)}\n生ログ: ${logPath}` };
  }
}
