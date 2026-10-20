// **別のサーバの Project の git と、1本のブランチの中身をやり取りする口**（決定・2026-10-20、Backlog #466、
// `docs/specs/v4-modules.md` §2.4「ブランチを送る口」の「別のサーバの Project」）。
//
// Repositories（banto 本体で動き、資格情報を持つ）は別のサーバの根に触れない。core が実行場所の接続（SSH の多重化した接続。
// containers ではコンテナの中で `incus exec`）を通して、向こうの git で bundle を作る・取り込むだけをする。資格情報は向こうへ
// 出ない——Repositories は host の使い捨ての置き場で、受け取った bundle を origin へ送り、origin から取ってきたものを bundle に
// して渡す。口の名前・ブランチ名の決まり・運ぶ大きさの上限は core と Repositories の両方が使う（写さない、規則3）。

/** origin の設定を読む（呼び出し元の Project の根のリポジトリ。どの Project かは host の台帳が決める） */
export const RELAY_PROJECT_GIT_ORIGIN_TOOL = "relayProjectGitOrigin";
/** そのブランチの bundle を作って返す（`refs/heads/<branch>` だけ） */
export const RELAY_PROJECT_GIT_BUNDLE_TOOL = "relayProjectGitBundle";
/** 渡した bundle のそのブランチを `refs/remotes/origin/<branch>` に取り込む */
export const RELAY_PROJECT_GIT_UNBUNDLE_TOOL = "relayProjectGitUnbundle";
/**
 * `refs/remotes/origin/<branch>` を、向こうにもうあるコミットに合わせる（送り終えたあと——この機械のリポジトリで `git push origin`
 * が追跡の ref を進めるのと同じ。Backlog は追跡の ref で「まだ送っていない」を数える）
 */
export const RELAY_PROJECT_GIT_TRACK_TOOL = "relayProjectGitTrack";

/**
 * **その tool を処理している間だけ、Project の git の口（上の4本）を呼べる**と名乗る印（`_meta` に `true`。追加・2026-10-20、
 * レビュー L2）。host は中継でその tool を呼んだ呼び出しに印を付け、`relayProjectGit*` は呼び出しの印（`dev.banto/callId`）が
 * 指す呼び出しに印があるときだけ受ける——同梱の Module の別の仕事（一覧を作る等）から、Project の中身に届かないように。
 * 信じるのは同梱の宛先の名乗りだけ
 */
export const PROJECT_GIT_META_KEY = "dev.banto/projectGit";

/**
 * 運ぶ bundle の上限（バイト、base64 にする前）。中継の本文は 10MB まで（`RELAY_BODY_MAX_BYTES`）で、base64 は 4/3 倍
 * ——取り込みの頼みが本文に収まる大きさ。Backlog の一覧のブランチ（690 コミットで 1.3MB、2026-10-20 の banto で実測）には足りる
 */
export const PROJECT_GIT_BUNDLE_MAX_BYTES = 6 * 1024 * 1024;

/**
 * 向こうのリポジトリの origin の設定（向こうの中のユーザーで、**リポジトリの段だけ**を読んだ値）。中の AI が書けるので申告として
 * 扱う——送り先は Repositories が `urls` から GitHub の場所を読んで host で決める
 */
export type ProjectGitOrigin =
  /** 根が git のリポジトリではない */
  | { kind: "not-repo" }
  | {
      kind: "repo";
      /** `remote.origin.url` の値（書かれた形のまま。`insteadOf` は当てない） */
      urls: string[];
      /** 送り先を変える設定の名前（`remote.origin.pushurl`・`url.<x>.insteadof`・`url.<x>.pushinsteadof`） */
      redirects: string[];
    };

/** コミットの名前（SHA-1 か SHA-256 の16進） */
export function isCommitId(id: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id);
}

/**
 * ブランチ名として受けるか。**git の決まり（`check-ref-format`）のうち、ここで要るものだけ**を見る——引数として
 * git に渡すので、`-` で始まるもの・refspec の記号（`:` `+` `*` 等）・`..`・`@{` は通さない
 */
export function isSafeBranchName(name: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("/.") || name.includes("@{")) return false;
  return !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock");
}
