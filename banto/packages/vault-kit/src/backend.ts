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
  listGroups(): Promise<string[]>;
  createGroup(name: string): Promise<void>;
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
