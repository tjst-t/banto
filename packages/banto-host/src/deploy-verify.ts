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
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/** stdout/stderr の上限（既定 1MiB は `npm test` の通常出力（実測 1.74MiB）で恒常的に超える）。 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** 報告に出す失敗行の上限（除外を済ませたあとに掛ける——打ち切ったら件数を報告に出す）。 */
const MAX_SHOWN_FAILURES = 30;

/** 失敗した spec を拾う目印（node:test / 一般のテストランナー双方）。素の `Error:` は
 *  意図的な接続失敗（例 `Error: connect ECONNREFUSED`）にもヒットするため含めない。 */
const FAILURE_MARKERS = /(fail [0-9]+|# fail|not ok|✗|FAILED|AssertionError|npm ERR!|failing tests?)/i;

/** 合格行（✔/✓ 始まり、TAP の `ok ` 始まり）は本文に何が書いてあっても失敗行とみなさない。
 *  `ok ` は前方一致——`not ok` を巻き込まないよう `trim` 済みの行頭でのみ判定する。 */
function isPassLine(trimmedLine: string): boolean {
  return trimmedLine.startsWith("✔") || trimmedLine.startsWith("✓") || trimmedLine.startsWith("ok ");
}

/** 既知のノイズ（環境未到達など、実失敗ではない定型行）。増えたらここに足す。 */
const KNOWN_NOISE_PATTERNS: RegExp[] = [
  /Failed to reach module/,
  /ECONNREFUSED 127\.0\.0\.1:1/,
  /への接続に失敗/,
  /verify_env_unavailable/,
];

function isKnownNoise(line: string): boolean {
  return KNOWN_NOISE_PATTERNS.some((pattern) => pattern.test(line));
}

/** 失敗内容を取り出す（合格行・既知ノイズを除いたあとで上限に絞る——本物の失敗を押し出さない）。 */
function extractFailures(output: string, exitCode: number): string {
  const lines = output.split("\n");
  const hit = lines.filter((line) => {
    const trimmed = line.trim();
    if (isPassLine(trimmed)) return false;
    if (isKnownNoise(line)) return false;
    return FAILURE_MARKERS.test(trimmed);
  });
  if (hit.length === 0) {
    return `終了コード ${exitCode} で失敗（fail 行は拾えなかった）`;
  }
  const shown = hit.slice(0, MAX_SHOWN_FAILURES);
  const omitted = hit.length - shown.length;
  const omittedLine = omitted > 0 ? `\n他に ${omitted} 件` : "";
  return `落ちた箇所:\n${shown.join("\n")}${omittedLine}`;
}

/** 生ログの既定の置き場所。`BANTO_DATA_DIR`（既定 /var/lib/banto）配下の deploy-verify/。 */
function defaultRawLogDir(): string {
  return path.join(process.env["BANTO_DATA_DIR"] ?? "/var/lib/banto", "deploy-verify");
}

type PersistResult = { logPath: string } | { error: string };

/** 失敗時の生ログを永続ディレクトリへ残す。書き込みに失敗しても例外は投げず理由を返す（I2）。 */
function persistRawLog(output: string, rawLogDir: string): PersistResult {
  try {
    fs.mkdirSync(rawLogDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, "-");
    const file = path.join(rawLogDir, `deploy-verify-${stamp}.log`);
    fs.writeFileSync(file, output, "utf8");
    return { logPath: file };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function rawLogLine(persisted: PersistResult): string {
  return "logPath" in persisted ? `生ログ: ${persisted.logPath}` : `生ログの保存に失敗: ${persisted.error}`;
}

/** 生ログの置き場所を差し替えるための任意オプション。省略時は defaultRawLogDir()。 */
export interface RunDeployVerifyOptions {
  rawLogDir?: string;
}

/** 既定は npm test 一式（フル回帰。起こし直し前に1回だけ回す）。 */
export async function runDeployVerify(
  cmd: string,
  cwd: string,
  options?: RunDeployVerifyOptions
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
    const rawLogDir = options?.rawLogDir ?? defaultRawLogDir();
    const logLine = rawLogLine(persistRawLog(output, rawLogDir));

    if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return {
        passed: false,
        report: `検証コマンドの出力が上限（${MAX_BUFFER_BYTES}バイト）を超えて打ち切られました（合否は不明のため拒否）。${logLine}`,
      };
    }
    if (e.killed && e.signal) {
      return {
        passed: false,
        report: `検証コマンドが時間切れで打ち切られました（signal ${e.signal}）。${logLine}`,
      };
    }

    const code = typeof e.code === "number" ? e.code : 1;
    return { passed: false, report: `${extractFailures(output, code)}\n${logLine}` };
  }
}
