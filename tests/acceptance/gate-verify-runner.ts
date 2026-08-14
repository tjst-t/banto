/**
 * **試験専用**の検証ランナー（task-0075）。
 *
 * 本番の Kobo は検証を**必ず検証環境の中で**回す（`Daemon.gateVerifyRunner()`）。
 * ホストで走らせない理由は inc-0032：ホストの状態（入っている道具・空いているポート）が
 * 検証結果に混ざり、**受け持つプロジェクトのテストが理由も分からず落ちる**。
 *
 * ここがホストで走らせるのは、**ゲートの筋道そのもの**（スコープ検査・時間切れの扱い・
 * ログの写し）を見たいときに、docker を毎回立てていられないため。**この口を本番のコードが
 * 使ってはいけない**——だから `tests/` に置き、`packages/` からは import できない場所にある。
 *
 * 「検証環境が無ければゲートは通らない」という不変条件そのものは
 * `merge-gate-env-required.spec.ts` が見る（この偽物を渡さずに）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { VERIFY_TIMEOUT_EXIT, type GateVerifyRunner } from "../../packages/banto-daemon/src/merge-gate.js";

const execFileAsync = promisify(execFile);

/** 立てた「環境」＝ただの作業ディレクトリ。畳んだかどうかを試験から見られるようにする。 */
export interface HostVerifyRunner extends GateVerifyRunner {
  /** 立てた envId の一覧（順番どおり）。 */
  readonly provisioned: string[];
  /** 畳んだ envId の一覧。**立てた数と一致すること**が I3 の確認になる。 */
  readonly tornDown: string[];
  /** 走らせたコマンド（envId ごと）。 */
  readonly ran: Array<{ envId: string; cmd: string; timeoutMs: number }>;
}

/**
 * ホストの worktree でそのまま走らせる偽の検証環境（試験専用）。
 *
 * @param options.failProvision 立てるのに失敗させる（「環境が無い」経路の検査用）
 * @param options.profileDigest 立てた環境の指紋を返す。**既定は返さない**——本物の
 *   Environment Pool も返さないことがあり（`profileDigest?`）、そのときゲートが
 *   自動着地を止められるかを見たいのが既定の側だから
 */
export function hostVerifyRunner(
  options: { failProvision?: string; profileDigest?: string } = {}
): HostVerifyRunner {
  const provisioned: string[] = [];
  const tornDown: string[] = [];
  const ran: Array<{ envId: string; cmd: string; timeoutMs: number }> = [];
  /** envId → 走らせる場所。 */
  const workdirs = new Map<string, string>();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-fake-env-"));
  let counter = 0;

  return {
    provisioned,
    tornDown,
    ran,

    async provision(opts) {
      if (options.failProvision) throw new Error(options.failProvision);
      counter += 1;
      const envId = `fake-env-${counter}`;
      provisioned.push(envId);
      workdirs.set(envId, opts.workdir);
      return { envId, ...(options.profileDigest ? { profileDigest: options.profileDigest } : {}) };
    },

    async run(opts) {
      ran.push({ envId: opts.envId, cmd: opts.cmd, timeoutMs: opts.timeoutMs });
      const cwd = workdirs.get(opts.envId);
      if (!cwd) throw new Error(`畳んだ環境で走らせようとしています: ${opts.envId}`);

      const logPath = path.join(logDir, `${opts.envId}-${ran.length}.log`);
      let exit: number;
      let output: string;
      try {
        const result = await execFileAsync("sh", ["-c", opts.cmd], {
          cwd,
          timeout: opts.timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        });
        exit = 0;
        output = `${result.stdout}${result.stderr}`;
      } catch (err) {
        const e = err as { killed?: boolean; code?: number | string; stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        if (e.killed) {
          exit = VERIFY_TIMEOUT_EXIT;
          output += `\n[fake-env] timed out after ${opts.timeoutMs}ms`;
        } else if (typeof e.code === "number") {
          exit = e.code;
        } else {
          exit = 1;
        }
      }
      fs.writeFileSync(logPath, output, "utf-8");
      return { exit, logPath, logTail: output.split("\n").slice(-200).join("\n") };
    },

    async teardown(envId) {
      tornDown.push(envId);
      workdirs.delete(envId);
    },
  };
}
