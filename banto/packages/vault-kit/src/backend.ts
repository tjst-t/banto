// docs/specs/v4-modules.md §2.1 D節「バックエンド実装者向けの内部インターフェース」。
// 各backend実装（今回はSOPS）はこれだけを書けばよい——alias管理・Elicitation
// 文言・Event Store記録・A/B/Cのtool/resource配線は共有ロジック（vault-kit.ts）が持つ。

export type AliasKind = "secret" | "ssh-identity" | "file";

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
  loadIntoAgent(privateKeyRef: string): Promise<{ socketPath: string }>;
  listGroups(): Promise<string[]>;
  createGroup(name: string): Promise<void>;
}
