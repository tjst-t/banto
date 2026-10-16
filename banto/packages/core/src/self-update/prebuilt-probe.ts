// **最新の release の組み立て済みがあるか**を GitHub に聞く（決定・2026-10-15、アーキ仕様 §2.5「組み立て済みのものを使う」の
// 「画面」）。画面の「更新」の節に「組み立て済みの版を使います／GitHub で組み立て中です／GitHub でのテストが落ちています／
// ありません」を出すため。聞くのは `check`（人が「確かめる」を押した・画面を開いて取り直した）のときだけで、結果は
// `SelfUpdate` がメモリに持つ——`GET` のたびに聞くと、鍵なしの API の回数制限（IP あたり 1 時間 60 回、`update.mjs` と分け合う）
// に当たる。
//
// **写し**：tag・ファイル名・origin の読み方・回の状態の見方は `banto/scripts/prebuilt.mjs`（update.mjs が使う側）と同じ。
// 片方を変えたら、もう片方も（core は scripts を import しない——scripts は版のフォルダの外に写されて動くことがある）

export type PrebuiltAvailability = "available" | "building" | "tests-failed" | "cancelled" | "none" | "unknown";

export interface PrebuiltProbe {
  status: PrebuiltAvailability;
  /** Actions の実行の URL（`https://github.com/<o>/<r>/actions/runs/<数字>` の形のときだけ） */
  run?: string;
  /** 人に見せる補足（GitHub 以外・聞けなかった理由など） */
  detail?: string;
  /** 確かめた時刻。まだ確かめていなければ null */
  checkedAt: string | null;
}

export interface PrebuiltProbeOptions {
  /** 試験の差し替え：download の口（`releases/download` のタグの手前まで） */
  base?: string;
  /** 試験の差し替え：runs の口を丸ごと */
  api?: string;
  fetch?: typeof fetch;
  arch?: string;
  now?: () => number;
}

const WAITING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const RUN_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+$/;

/** origin の URL から GitHub の `<owner>/<repo>`（写し：prebuilt.mjs の githubRepoOf） */
export function githubRepoOf(url: string | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const m =
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url) ??
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

interface Run {
  status?: string;
  conclusion?: string | null;
  run_number?: number;
  run_attempt?: number;
  html_url?: string;
}

/** その commit の組み立て済みの様子 */
export async function probePrebuilt(commit: string, originUrl: string | undefined, opts: PrebuiltProbeOptions = {}): Promise<PrebuiltProbe> {
  const doFetch = opts.fetch ?? fetch;
  const checkedAt = new Date((opts.now ?? Date.now)()).toISOString();
  if ((opts.arch ?? process.arch) !== "x64") return { status: "none", detail: `この機械は ${opts.arch ?? process.arch} です（組み立て済みは x64 だけ）`, checkedAt };
  let base: string;
  let runsUrl: string;
  if (opts.base && opts.api) {
    base = opts.base.replace(/\/$/, "");
    runsUrl = opts.api;
  } else {
    const repo = githubRepoOf(originUrl);
    if (!repo) return { status: "none", detail: `取り込み元が GitHub ではありません（${originUrl ?? "origin がありません"}）`, checkedAt };
    base = `https://github.com/${repo}/releases/download`;
    runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/prebuilt.yml/runs`;
  }
  const asset = `${base}/build-${commit.slice(0, 12)}/banto-${commit}-linux-x64.tar.zst`;
  try {
    const head = await doFetch(asset, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (head.ok) return { status: "available", checkedAt };
  } catch {
    // 届かない——下の API で様子を見る
  }
  let runs: Run[];
  try {
    const url = `${runsUrl}${runsUrl.includes("?") ? "&" : "?"}head_sha=${commit}&per_page=20`;
    const res = await doFetch(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) runs = [];
    else if (!res.ok) {
      const limited = res.status === 403 || res.status === 429;
      return { status: "unknown", detail: limited ? `GitHub の回数制限です（${res.status}）。少し置いて確かめ直してください` : `GitHub が ${res.status} を返しました`, checkedAt };
    } else {
      const body = (await res.json()) as { workflow_runs?: Run[] };
      runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    }
  } catch (err) {
    return { status: "unknown", detail: `GitHub に聞けません：${err instanceof Error ? err.message : String(err)}`, checkedAt };
  }
  const runOf = (r: Run | undefined) => (r?.html_url && RUN_URL.test(r.html_url) ? { run: r.html_url } : {});
  const busy = runs.find((r) => WAITING.has(r.status ?? ""));
  if (busy) return { status: "building", ...runOf(busy), checkedAt };
  // 成功した回があるのにファイルが無い——消された（update.mjs もその場で組み立てる）
  if (runs.length === 0 || runs.some((r) => r.status === "completed" && r.conclusion === "success")) return { status: "none", checkedAt };
  const last = [...runs].sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) || (b.run_attempt ?? 0) - (a.run_attempt ?? 0))[0];
  if (last?.conclusion === "failure") return { status: "tests-failed", ...runOf(last), checkedAt };
  return { status: "cancelled", ...runOf(last), checkedAt };
}
