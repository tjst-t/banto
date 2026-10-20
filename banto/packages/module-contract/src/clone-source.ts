// **clone の元を読む決まり**（決定・2026-10-20、`docs/specs/v4-frontend.md` §6.49）。Repositories の clone（この機械）と、
// core が別のサーバの Project の Shell で流す clone の両方が使う——断る決まりを2つ持たない（写さない、規則3）。
//
// - 受けるもの：`owner/repo`（GitHub）・`https://…`・`git@host:path`・`ssh://…`。GitHub の外も受ける
// - 断るもの：手元のパス・`file://`・`git://`（暗号化されない）・`http://`（行き先を替えた GitHub だけは受ける——試験の偽物）・
//   `ext::` 等・`-` で始まるもの・URL に資格情報を書いたもの（clone 先の `.git/config` に残る）・空白・改行・制御文字

/** GitHub の行き先（Repositories の `GithubEndpoints` のうち、ここで要る分） */
export interface CloneSourceGithub {
  /** ログインの口・HTTPS の clone の口（`https://github.com`） */
  web: string;
  /** SSH で clone するときの相手（`github.com`）。無ければ web の host */
  ssh?: string;
}

export type CloneSource =
  | { kind: "github"; owner: string; name: string }
  | { kind: "elsewhere"; url: string; host: string; name: string };

const NAME = /^[A-Za-z0-9._-]+$/;

/** フォルダ名（＝リポジトリ名）に使えるか。英数字と - _ .、ドットだけは不可 */
export function isValidFolderName(name: string): boolean {
  return NAME.test(name) && !/^\.+$/.test(name);
}

const stripGit = (s: string) => s.replace(/\.git$/, "");

/** パスの最後の段（`node:path` の basename と同じ——末尾の / は除く） */
const lastSegment = (path: string) => path.split("/").filter(Boolean).pop() ?? "";

/** GitHub と見なす host（本物と、行き先を替えたときの偽物） */
function githubHosts(github: CloneSourceGithub): Set<string> {
  const hosts = new Set(["github.com", "www.github.com"]);
  try {
    hosts.add(new URL(github.web).host.toLowerCase());
  } catch {
    // 行き先が URL でない——本物の名前だけで見る
  }
  if (github.ssh) hosts.add(github.ssh.toLowerCase());
  return hosts;
}

/** 行き先を替えた GitHub（`web`）そのものか——http はこれだけ受ける */
function isConfiguredWeb(github: CloneSourceGithub, u: URL): boolean {
  try {
    const web = new URL(github.web);
    return web.protocol === u.protocol && web.host.toLowerCase() === u.host.toLowerCase();
  } catch {
    return false;
  }
}

function ownerName(path: string): { owner: string; name: string } | undefined {
  const m = path.replace(/^\/+/, "").replace(/\/+$/, "").match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) return undefined;
  const name = stripGit(m[2]!);
  return isValidFolderName(name) ? { owner: m[1]!, name } : undefined;
}

/**
 * clone の元を読む。読めなければ理由を返す（打っている途中は画面が例を出すだけで、押したときに断る）
 */
export function parseCloneSource(text: string, github: CloneSourceGithub): CloneSource | { kind: "invalid"; reason: string } {
  // 空白・改行・制御文字が1つでもあれば断る（前後の空白は除く）。URL の読み手は改行やタブを黙って落とすので、読む前に見る
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(text.trim())) return { kind: "invalid", reason: "URL に空白・改行・制御文字は入れられません" };
  return readCloneSource(text, github);
}

function readCloneSource(text: string, github: CloneSourceGithub): CloneSource | { kind: "invalid"; reason: string } {
  const invalid = (reason: string) => ({ kind: "invalid" as const, reason });
  const t = text.trim().replace(/\/+$/, "");
  if (t === "") return invalid("URL を入れてください");
  if (t.startsWith("-")) return invalid("URL として読めません");
  const hosts = githubHosts(github);
  const short = ownerName(t.replace(/^(?:www\.)?github\.com\//i, ""));
  if (short && !t.includes(":")) return { kind: "github", ...short };
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== "https" && scheme !== "http" && scheme !== "ssh") {
      return invalid(scheme === "git" ? "git:// は暗号化されないので受けません（https か ssh の URL にしてください）" : `${scheme}:// の URL は受けません（https か ssh の URL にしてください）`);
    }
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return invalid("URL として読めません");
    }
    // https://user:token@host/… は clone 先の .git/config に残る（そこから AI が読める）
    if (u.password || (scheme !== "ssh" && u.username)) return invalid("URL に資格情報を書かないでください（アカウントは下で選びます）");
    const host = u.host.toLowerCase();
    // http は暗号化されない（git:// を断るのと同じ理由）。受けるのは行き先を替えた GitHub（試験の偽物）だけ
    if (scheme === "http" && !isConfiguredWeb(github, u)) {
      return invalid("http:// は暗号化されないので受けません（https か ssh の URL にしてください）");
    }
    if (hosts.has(host) || hosts.has(u.hostname.toLowerCase())) {
      const loc = ownerName(u.pathname);
      if (!loc) return invalid("GitHub の URL は github.com/owner/repo の形で入れてください");
      return { kind: "github", ...loc };
    }
    const name = stripGit(lastSegment(u.pathname));
    if (!name || u.pathname.replace(/\/+/g, "/") === "/") return invalid("リポジトリの場所（パス）がありません");
    if (!isValidFolderName(name)) return invalid(`リポジトリ名「${name}」はフォルダ名に使えません`);
    return { kind: "elsewhere", url: t, host, name };
  }
  // scp の形（`git@host:path`）
  const scp = t.match(/^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost):(?!\/\/)(.+)$/);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    if (hosts.has(host)) {
      const loc = ownerName(scp[2]!);
      if (!loc) return invalid("GitHub の URL は git@github.com:owner/repo.git の形で入れてください");
      return { kind: "github", ...loc };
    }
    const name = stripGit(lastSegment(scp[2]!));
    if (!isValidFolderName(name)) return invalid(`リポジトリ名「${name}」はフォルダ名に使えません`);
    return { kind: "elsewhere", url: t, host, name };
  }
  if (t.startsWith("/") || t.startsWith("~") || t.startsWith(".")) {
    return invalid("手元のフォルダは clone しません（そのまま使うなら「フォルダを Import」を使ってください）");
  }
  return invalid("URL として読めません");
}
