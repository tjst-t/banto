// Incus を呼ぶ口（決定・2026-09-25、`docs/specs/v4-security.md` §1）。
//
// **CLI（`incus`）を通す**——REST の口に直接つなぐより、どちらの口（`incus-admin` 用・権限を絞った
// `incus` 用）に繋ぐかの判断と認証を Incus 自身に任せられる。JSON が要るときは `incus query`
// （REST をそのまま引く CLI の口）を使う。依存は足さない（規則10）。

import { execFile } from "node:child_process";

export interface IncusResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `incus` を1回呼ぶ。試験では差し替える */
export type RunIncus = (args: string[], opts?: { timeoutMs?: number }) => Promise<IncusResult>;

/** `incus` が無いとき（起動できなかった）に投げる——「呼んだが失敗した」と混ぜない（規則2） */
export class IncusMissingError extends Error {
  override name = "IncusMissingError";
}

/** 上限を過ぎて止めたときの終了コード（`timeout(1)` と同じ） */
export const TIMED_OUT = 124;

export const runIncus: RunIncus = (args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile("incus", args, { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new IncusMissingError("incus のコマンドが見つかりません"));
        return;
      }
      // 上限を過ぎて止めたときは、そう分かる形で返す（「失敗した」と混ぜない）
      if (err && (err as { killed?: boolean }).killed) {
        resolve({ code: TIMED_OUT, stdout: String(stdout), stderr: `${(opts.timeoutMs ?? 60_000) / 1000} 秒で返らなかった ${String(stderr)}`.trim() });
        return;
      }
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    // **標準入力は必ず閉じる**。`incus init` は標準入力がターミナルでないとき、そこから設定（YAML）を読む——
    // 開いたままだと入力の終わりを待ち続けて返らない（実測・2026-09-25：開いたまま＝時間切れ、空＝4 秒）
    child.stdin?.end();
  });

/** `incus query <path>` の JSON を返す。失敗は Incus の言葉のまま投げる */
export async function queryIncus<T>(run: RunIncus, path: string): Promise<T> {
  const r = await run(["query", path]);
  if (r.code !== 0) throw new Error(`incus query ${path} が失敗しました：${r.stderr.trim() || `終了コード ${r.code}`}`);
  return JSON.parse(r.stdout) as T;
}
