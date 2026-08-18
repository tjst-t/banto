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

const execFileAsync = promisify(execFile);

/** 失敗した spec を拾う目印（node:test / 一般のテストランナー双方）。 */
const FAILURE_MARKERS =
  /(fail [0-9]+|# fail|not ok|✗|FAILED|AssertionError|Error:|npm ERR!|failing tests?)/i;

/** 失敗内容を取り出す（誤検知を避けるために末尾へは触らない）。 */
function extractFailures(output: string, exitCode: number): string {
  const lines = output.split("\n");
  const hit = lines.filter((line) => FAILURE_MARKERS.test(line.trim())).slice(0, 30);
  if (hit.length > 0) return `落ちた箇所:\n${hit.join("\n")}`;
  return `終了コード ${exitCode} で失敗（fail 行は拾えなかった）`;
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
    const { stdout } = await execFileAsync(exe, argv, { cwd, timeout: 20 * 60_000 });
    return { passed: true, report: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const output = [e.stdout ?? "", e.stderr ?? ""].join("\n");
    const code = typeof e.code === "number" ? e.code : 1;
    return { passed: false, report: extractFailures(output, code) };
  }
}
