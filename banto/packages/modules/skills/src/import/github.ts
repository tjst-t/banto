// GitHub から Skill のフォルダを1つ取ってくる（アーキ仕様 §5.7）。
//
// **git は使わない**——この Module は閉じ込められていて（files-only）、外のプログラムを
// 起動できない。GitHub の REST API で commit と木を引き、中身は raw から取る。
//
// - **ref を省かれたら、そのときの commit に解決して固定する**（決定・2026-09-23）
//   ——`HEAD` のまま持つと、いつ時点のものかが消えて更新の検出ができなくなる
// - API は未認証で1時間に60回まで。1回の取り込みで使うのは「commit を引く1回＋
//   フォルダまでの木を辿る回数」だけで、中身（raw）は数に入らない

import type { GithubLocation, SkillSource } from "./source.js";
import { assertSafeRelativePath, assertWithinLimits, type ImportedFile } from "./limits.js";

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface GithubEndpoints {
  api: string;
  raw: string;
}

export const GITHUB: GithubEndpoints = { api: "https://api.github.com", raw: "https://raw.githubusercontent.com" };

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

/** 同時に取りに行く数。 */
const PARALLEL = 6;

export async function fetchGithubSkill(
  loc: GithubLocation,
  deps: { fetch: FetchLike; endpoints?: GithubEndpoints },
): Promise<{ files: ImportedFile[]; source: Extract<SkillSource, { kind: "github" }> }> {
  const ep = deps.endpoints ?? GITHUB;
  const repo = `${loc.owner}/${loc.repo}`;
  const api = async (path: string): Promise<unknown> => {
    const res = await deps.fetch(`${ep.api}/repos/${repo}${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "banto-skills" },
    });
    if (res.ok) return res.json();
    if (res.status === 404) throw new Error(`GitHub に見つかりません: ${repo}${loc.ref ? `（${loc.ref}）` : ""}`);
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const at = Number.isFinite(reset) ? `（${new Date(reset * 1000).toLocaleTimeString("ja-JP")} に戻ります）` : "";
      throw new Error(`GitHub の問い合わせの上限（未認証で1時間に60回）に達しました${at}`);
    }
    throw new Error(`GitHub が ${res.status} を返しました: ${repo}${path}`);
  };

  // ① ref を commit に解決する（省かれたら既定のブランチの先頭）
  const commit = (await api(`/commits/${encodeURIComponent(loc.ref ?? "HEAD")}`)) as {
    sha?: string;
    commit?: { tree?: { sha?: string } };
  };
  const commitSha = commit.sha;
  let treeSha = commit.commit?.tree?.sha;
  if (!commitSha || !treeSha) throw new Error(`GitHub の commit が読めません: ${repo}`);

  // ② フォルダまで木を辿る（深さの分だけ問い合わせる——大きいリポジトリで
  //    全体の木を引くと切り詰められるので、使う枝だけを見る）
  const segments = loc.path === "" ? [] : loc.path.split("/");
  for (const [i, segment] of segments.entries()) {
    const tree = (await api(`/git/trees/${treeSha}`)) as { tree?: TreeEntry[] };
    const next = tree.tree?.find((e) => e.path === segment && e.type === "tree");
    if (!next) throw new Error(`フォルダ「${segments.slice(0, i + 1).join("/")}」が ${repo} にありません`);
    treeSha = next.sha;
  }
  const subtree = (await api(`/git/trees/${treeSha}?recursive=1`)) as { tree?: TreeEntry[]; truncated?: boolean };
  if (subtree.truncated) throw new Error(`フォルダ「${loc.path || "/"}」が大きすぎて一覧を取り切れません`);
  const blobs = (subtree.tree ?? []).filter((e) => e.type === "blob");
  if (!blobs.some((b) => b.path === "SKILL.md")) {
    throw new Error(`「${loc.path || "/"}」に SKILL.md がありません——Skill のフォルダを指してください`);
  }
  for (const b of blobs) assertSafeRelativePath(b.path);
  // **取りに行く前に大きさを見る**（木が大きさを知っている）
  assertWithinLimits(blobs.map((b) => ({ path: b.path, size: b.size ?? 0 })));

  // ③ 中身は raw から（API の回数を使わない）。**解決した commit で取る**——
  //    途中でブランチが進んでも、1つの Skill の中身が2つの時点に跨らない
  const base = `${ep.raw}/${repo}/${commitSha}/${segments.map(encodeURIComponent).join("/")}`;
  const files: ImportedFile[] = [];
  for (let i = 0; i < blobs.length; i += PARALLEL) {
    const batch = await Promise.all(
      blobs.slice(i, i + PARALLEL).map(async (b) => {
        const url = `${base}${segments.length > 0 ? "/" : ""}${b.path.split("/").map(encodeURIComponent).join("/")}`;
        const res = await deps.fetch(url, { headers: { "user-agent": "banto-skills" } });
        if (!res.ok) throw new Error(`${b.path} を取れませんでした（${res.status}）`);
        return { path: b.path, bytes: new Uint8Array(await res.arrayBuffer()) };
      }),
    );
    files.push(...batch);
  }
  assertWithinLimits(files.map((f) => ({ path: f.path, size: f.bytes.byteLength })));

  const url = `https://github.com/${repo}/tree/${commitSha}${loc.path ? `/${loc.path}` : ""}`;
  return {
    files,
    source: { kind: "github", repo, path: loc.path, ref: loc.ref ?? null, commit: commitSha, url },
  };
}
