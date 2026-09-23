// 取り込み元の書き方（アーキ仕様 §5.7「取り込み口が対応する形」）。
//
// 実態は「git リポジトリの、あるパス」と「圧縮ファイル」の2つ。git はいまは
// **GitHub だけ**を読む（`anthropics/skills` も `awesome-*` の一覧が指す先の大半も
// GitHub）。人が GitHub の画面からコピーする URL をそのまま受ける。

export interface GithubLocation {
  owner: string;
  repo: string;
  /** リポジトリの中の Skill のフォルダ（`""` はリポジトリの直下）。 */
  path: string;
  /** 省略されたら `undefined`——取り込むときに commit へ解決して固定する（§5.7）。 */
  ref?: string;
}

/** 取り込んだものの出所。**更新に追随するために要る**（元が動いたかを判定する、§5.7）。 */
export type SkillSource =
  | {
      kind: "github";
      repo: string;
      path: string;
      /** 人が指定した ref（無ければ `null`＝そのときの既定のブランチ）。 */
      ref: string | null;
      /** 実際に取ってきた commit。**`HEAD` のまま持たない**（§5.7、決定・2026-09-23）。 */
      commit: string;
      url: string;
    }
  | { kind: "zip"; fileName: string; sha256: string };

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * GitHub の場所を読む。受ける形：
 *
 * - `https://github.com/<owner>/<repo>/tree/<ref>/<path>`（フォルダを開いた画面の URL）
 * - `https://github.com/<owner>/<repo>/blob/<ref>/<path>/SKILL.md`（ファイルの画面の URL）
 * - `https://github.com/<owner>/<repo>`（リポジトリの直下が Skill）
 * - `<owner>/<repo>/<path>` に `@<ref>` を付けてもよい
 *
 * **tree/blob の URL の ref は、最初の1区切りとして読む**——`feature/x` のような
 * `/` を含むブランチは URL からは見分けられないので、そのときは `@<ref>` の形で書く。
 */
export function parseGithubLocation(input: string): GithubLocation {
  const text = input.trim();
  if (text === "") throw new Error("取り込み元が空です");
  const url = text.match(/^https?:\/\/(?:www\.)?github\.com\/(.+)$/i);
  if (url) {
    const parts = url[1]!.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/");
    const [owner, repoRaw, kind, ref, ...rest] = parts;
    const repo = repoRaw?.replace(/\.git$/, "");
    if (!owner || !repo) throw new Error(`GitHub の URL からリポジトリが読めません: ${text}`);
    if (kind === undefined) return checked({ owner, repo, path: "" }, text);
    if ((kind !== "tree" && kind !== "blob") || !ref) {
      throw new Error(`GitHub の URL の形が分かりません（…/tree/<ブランチ>/<フォルダ> の形で）: ${text}`);
    }
    let path = rest.join("/");
    if (kind === "blob") {
      if (!/(^|\/)SKILL\.md$/.test(path)) throw new Error(`ファイルの URL は SKILL.md を指してください: ${text}`);
      path = path.replace(/\/?SKILL\.md$/, "");
    }
    return checked({ owner, repo, path: decodeURIComponent(path), ref: decodeURIComponent(ref) }, text);
  }
  if (/^[a-z]+:\/\//i.test(text)) {
    throw new Error(`いま取り込めるのは GitHub だけです: ${text}`);
  }
  const at = text.lastIndexOf("@");
  const [location, ref] = at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text, undefined];
  const [owner, repo, ...rest] = location.replace(/\/+$/, "").split("/");
  if (!owner || !repo) throw new Error(`「<owner>/<repo>/<フォルダ>」の形で書いてください: ${text}`);
  return checked({ owner, repo, path: rest.join("/"), ...(ref ? { ref } : {}) }, text);
}

function checked(loc: GithubLocation, original: string): GithubLocation {
  if (!SEGMENT.test(loc.owner) || !SEGMENT.test(loc.repo)) {
    throw new Error(`リポジトリの名前が読めません: ${original}`);
  }
  // パスに `..` を入れさせない——API に渡す前に弾く
  if (loc.path.split("/").some((s) => s === ".." || s === ".")) {
    throw new Error(`フォルダの指定に「..」は使えません: ${original}`);
  }
  if (loc.ref !== undefined && (loc.ref === "" || /\s|\.\./.test(loc.ref))) {
    throw new Error(`ブランチ・タグ・commit の指定が読めません: ${original}`);
  }
  return loc;
}
