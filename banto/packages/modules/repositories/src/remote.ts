// フォルダの origin の URL を読む（docs/specs/v4-modules.md §2.4）。
//
// 台帳が覚えるリモートの場所は2通り——**GitHub なら owner/name、GitHub の外（gitlab 等）は URL**。
// 読み方はここの1箇所（規則3）。読めない形は GitHub の外として URL のまま扱う——黙って捨てない。

export interface GithubLocation {
  owner: string;
  name: string;
}

export type RemoteLocation =
  | ({ kind: "github" } & GithubLocation)
  /** GitHub の外。URL はそのまま（台帳にもこのまま書く） */
  | { kind: "elsewhere"; url: string }
  /** origin が無い——このマシンにだけある */
  | { kind: "none" };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** `owner/name(.git)` の部分を読む。形が違えば undefined */
function ownerAndName(path: string): GithubLocation | undefined {
  const m = path.replace(/^\/+/, "").replace(/\/+$/, "").match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!m) return undefined;
  return { owner: m[1]!, name: m[2]! };
}

/**
 * origin の URL から場所を読む。受ける形：
 * `https://github.com/o/n(.git)`・`git@github.com:o/n(.git)`・`ssh://git@github.com(:22)/o/n(.git)`・`git://github.com/o/n`。
 * ほかは GitHub の外として URL のまま
 */
export function parseRemoteUrl(url: string): RemoteLocation {
  const text = url.trim();
  // scp 形式（`git@host:path`）——URL として読めないので先に見る
  const scp = text.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = scp[1]!.toLowerCase();
    const loc = GITHUB_HOSTS.has(host) ? ownerAndName(scp[2]!) : undefined;
    return loc ? { kind: "github", ...loc } : { kind: "elsewhere", url: text };
  }
  try {
    const u = new URL(text);
    const loc = GITHUB_HOSTS.has(u.hostname.toLowerCase()) ? ownerAndName(u.pathname) : undefined;
    return loc ? { kind: "github", ...loc } : { kind: "elsewhere", url: text };
  } catch {
    return { kind: "elsewhere", url: text };
  }
}

/** origin の URL からホスト名だけ（`git@gitlab.com:…` → `gitlab.com`）。画面の短い言い方に使う */
export function remoteHost(url: string): string {
  const scp = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return scp[1]!;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** GitHub の場所が同じか（持ち主も名前も大文字小文字を区別しない——GitHub がそう扱う） */
export function sameGithubLocation(a: GithubLocation | undefined, b: GithubLocation | undefined): boolean {
  if (!a || !b) return a === b;
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}
