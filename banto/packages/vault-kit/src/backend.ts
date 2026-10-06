// docs/specs/v4-modules.md §2.1 D節「バックエンド実装者向けの内部インターフェース」。
// 各backend実装（今回はSOPS）はこれだけを書けばよい——alias管理・Elicitation
// 文言・Event Store記録・A/B/Cのtool/resource配線は共有ロジック（vault-kit.ts）が持つ。

import { tmpdir } from "node:os";
/**
 * 秘密の種別。**`oauth-token` だけは banto 自身が置くもの**（追加・2026-09-18）
 * ——人は登録画面から作らないが、一覧では見えて消せる（規則13）。
 */
export type AliasKind = "secret" | "ssh-identity" | "file" | "oauth-token";

export interface VaultBackend {
  getSecret(path: string): Promise<string | Buffer>;
  putSecret(path: string, value: string | Buffer): Promise<void>;
  deleteSecret(path: string): Promise<void>;
  listPaths(prefix?: string): Promise<string[]>;
  /**
   * 鍵ペアを作って**指定された置き場**に預ける（改訂・2026-09-13）。
   *
   * **置き場を決めるのは呼び出し側**——以前は backend が `ssh-identities` を
   * 決め打ちしていたので、鍵だけがどのグループにも紐付かなかった（＝誰も
   * 使えない）うえ、Infisical では **alias 名が公開鍵の断片に化けていた**。
   *
   * 返す `privateKeyRef` は `path` と同じでなければならない。**置けないなら
   * 例外**——黙って別の場所に置かない（規則2）。秘密鍵そのものは返さない
   * （backend によっては一度もプロセスに出てこない）。
   */
  generateKeypair(kind: "ssh", path: string): Promise<{ publicKey: string; privateKeyRef: string }>;
  /**
   * その鍵ペアの**公開鍵**（追加・2026-09-13、ユーザー指摘）。
   *
   * **公開鍵は秘密ではない**——相手方に登録するためのものなので、むしろ
   * 出せないと使えない。作った直後の1回しか返していなかったので、
   * 画面を閉じたら二度と見られなかった。
   *
   * 秘密鍵からは `ssh-keygen -y` で導ける（規則12——名前のある解を使う）。
   * **保存しない**（規則3——導出できる値を持たない）。
   */
  publicKeyOf(privateKeyRef: string): Promise<string>;
  /**
   * `socketDir` があれば窓口（ssh-agent のソケット）をそこに立てる——host が刻んだ、コンテナの中の呼び出し元にも
   * 見えるフォルダ（`SOCKET_DIR_META_KEY`、追加・2026-09-27）。無ければ今までどおり一時フォルダ
   */
  loadIntoAgent(privateKeyRef: string, opts?: { socketDir?: string }): Promise<{ socketPath: string }>;
  /**
   * **既定の版のグループだけ**を返す（版付きのグループ `<グループ>@<版>` は並べない、2026-10-06）。
   */
  listGroups(): Promise<string[]>;
  /** `name` は版付き（`<グループ>@<版>`）でもよい——版を名乗る backend はその版に作る。冪等。 */
  createGroup(name: string): Promise<void>;
  /**
   * **版を名乗る**（任意、決定・2026-10-06。仕様 §2.1「グループの『版』」）。同じグループに版違いの値が
   * 並ぶ backend（Infisical の環境等）だけが実装する。**kit は版の意味を知らない**——呼び名と選択肢を
   * 画面に出し、紐付けを `<グループ>@<版>` で書くだけ。実装しない backend には版の選択が出ない
   */
  variants?(): Promise<VariantAxis>;
  /** 版ごとの「値が入っている秘密の数／全部の数」（版を選ぶ欄に添える）。`variants` を持つなら持つ。 */
  countByVariant?(group: string): Promise<VariantCount[]>;
  /**
   * **グループ名をいまの形に揃える**（同期、`variants` を持つなら持つ。2026-10-06、レビュー）。いまの既定の版を
   * 指す `g@<既定>` は `g` に直す——既定の版を後から変えると、台帳の紐付け `g@prod` と素の `g` が同じ置き場を
   * 指すようになるため。kit は紐付けと置き場を比べる前に必ずこれを通す
   */
  canonicalGroup?(groupId: string): string;
}

/** backend が名乗る版の軸。 */
export interface VariantAxis {
  /** 人に見せる呼び名（Infisical なら「環境」）。 */
  label: string;
  /** 選べる版。 */
  options: string[];
  /** 既定の版——`@` の付かないグループはこれを指す。 */
  default: string;
}

export interface VariantCount {
  variant: string;
  /** 値が入っている秘密の数。 */
  filled: number;
  /** 全部の数（名前だけの空欄も含む）。 */
  total: number;
}

/**
 * 版付きのグループの書き方 `<グループ>@<版>`（kit の決まった書き方、2026-10-06）。
 * **kit が読むのはこの書き方だけ**——版の意味は backend だけが知る。グループ名に `@` は使えない
 */
export const VARIANT_SEPARATOR = "@";

export function splitVariant(groupId: string): { group: string; variant?: string } {
  const at = groupId.indexOf(VARIANT_SEPARATOR);
  if (at === -1) return { group: groupId };
  return { group: groupId.slice(0, at), variant: groupId.slice(at + 1) };
}

/** 既定の版なら `@` を付けない（今までのグループと置き場がそのまま既定の版を指すように）。 */
export function joinVariant(group: string, variant: string | undefined, defaultVariant?: string): string {
  if (group.includes(VARIANT_SEPARATOR)) throw new Error(`グループ名に "${VARIANT_SEPARATOR}" は使えません: ${group}`);
  if (variant === undefined || variant === "" || variant === defaultVariant) return group;
  if (variant.includes(VARIANT_SEPARATOR) || variant.includes("/")) throw new Error(`版の名前が正しくありません: ${variant}`);
  return `${group}${VARIANT_SEPARATOR}${variant}`;
}

/**
 * 窓口（ssh-agent のソケット）の置き場所。`socketDir` があればそこに短い名前で、無ければ一時フォルダに
 * `fallbackName` で。**Unix ソケットのパスは 107 バイトまで**——超えると ssh-agent が黙って立たないので、
 * 先に理由を言って断る（規則2）
 */
export function agentSocketPath(socketDir: string | undefined, fallbackName: string): string {
  const path = socketDir
    ? `${socketDir.replace(/\/+$/, "")}/a-${Math.random().toString(36).slice(2, 8)}`
    : `${tmpdir()}/${fallbackName}`;
  if (Buffer.byteLength(path) > 107) {
    throw new Error(`鍵の窓口のパスが長すぎて作れません（Unix ソケットは 107 バイトまで）: ${path}`);
  }
  return path;
}
