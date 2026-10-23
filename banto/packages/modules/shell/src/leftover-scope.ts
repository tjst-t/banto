// **待つ形の runCommand のあとに、仕事の組（scope）に残ったプロセス**（追加・2026-10-23、Backlog #527。
// docs/specs/v4-modules.md §2.3「待つ形のあとに残ったプロセス」）。
//
// 待つ形が見ているのは、起こした `/bin/sh` の終わりだけ。`(setsid cmd &)`・`nohup cmd &` で後ろに回したものは、sh が
// 0 で終わったあとも同じ組（cgroup）の中で動き続ける——setsid はセッションを抜けても cgroup は抜けない。以前はそれが
// どの一覧にも出ず、止める口も無かった（別の Project で wrangler が 7 組・3.5GB 残った）。組を見れば、残っているかが分かる。

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/** 止めるとき SIGTERM のあと待つ上限（過ぎれば SIGKILL）。待たない形の `cancelCommand` と同じ 10 秒 */
const STOP_GRACE_MS = 10_000;

export interface ScopeControl {
  /** 組にまだプロセスが居れば、その cgroup のパス（`/sys/fs/cgroup` からの相対）。居ない・組がもう無ければ undefined */
  leftover(unit: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  /** cgroup にまだプロセスが居るか（中の cgroup も含む）。組が消えていれば false */
  populated(cgroup: string): boolean;
  /** 組を丸ごと止める（SIGTERM、残れば SIGKILL）。返ったら止まっている。止められなければ投げる */
  stop(unit: string, cgroup: string, env: NodeJS.ProcessEnv): Promise<void>;
}

function systemctl(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") });
    });
  });
}

/** 本物：ユーザーの systemd と cgroup v2 のファイル */
export class SystemdScopes implements ScopeControl {
  constructor(private readonly cgroupRoot = "/sys/fs/cgroup") {}

  async leftover(unit: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const r = await systemctl(["show", "--property=ControlGroup", "--value", unit], env);
    if (r.code !== 0) throw new Error(`仕事の組 ${unit} を確かめられませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
    const cgroup = r.stdout.trim();
    // 中が空になった組は `--collect` で片づき、ControlGroup が空になる
    if (cgroup === "" || !this.populated(cgroup)) return undefined;
    return cgroup;
  }

  populated(cgroup: string): boolean {
    let events: string;
    try {
      events = readFileSync(`${this.cgroupRoot}${cgroup}/cgroup.events`, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    return /^populated 1$/m.test(events);
  }

  async stop(unit: string, cgroup: string, env: NodeJS.ProcessEnv): Promise<void> {
    // `systemctl stop` は単位の既定（90 秒）まで待つので、自分で SIGTERM → 待つ → SIGKILL
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const r = await systemctl(["kill", `--signal=${signal}`, unit], env);
      if (r.code !== 0 && !/not loaded|not found/i.test(r.stderr)) {
        throw new Error(`仕事の組 ${unit} を止められませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
      }
      for (let waited = 0; waited < STOP_GRACE_MS; waited += 100) {
        if (!this.populated(cgroup)) return;
        await new Promise((res) => setTimeout(res, 100));
      }
    }
    if (this.populated(cgroup)) throw new Error(`仕事の組 ${unit} に SIGKILL を送っても、プロセスが残っています`);
  }
}
