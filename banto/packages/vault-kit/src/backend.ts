// docs/specs/v4-modules.md §2.1 D節「バックエンド実装者向けの内部インターフェース」。
// 各backend実装（今回はSOPS）はこれだけを書けばよい——alias管理・Elicitation
// 文言・Event Store記録・A/B/Cのtool/resource配線は共有ロジック（vault-kit.ts）が持つ。

export type AliasKind = "secret" | "ssh-identity" | "file";

export interface VaultBackend {
  getSecret(path: string): Promise<string | Buffer>;
  putSecret(path: string, value: string | Buffer): Promise<void>;
  deleteSecret(path: string): Promise<void>;
  listPaths(prefix?: string): Promise<string[]>;
  generateKeypair(kind: "ssh"): Promise<{ publicKey: string; privateKeyRef: string }>;
  loadIntoAgent(privateKeyRef: string): Promise<{ socketPath: string }>;
  listGroups(): Promise<string[]>;
  createGroup(name: string): Promise<void>;
}
