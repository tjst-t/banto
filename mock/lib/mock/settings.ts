import type {
  MockCredential,
  MockModuleImplementation,
  MockProjectModuleLink,
  MockProjectOverrides,
  MockRole,
  MockRuntimeDefaults,
  MockVaultAlias,
  ProjectId,
} from "./types";

// 設定のモックデータ（§2.10・§6.1）。実装は捨てる前提ではないが、UI を固める
// ことが目的——バックエンドとは繋がっていない（`mock/README.md`）。

export const mockRuntimeDefaults: MockRuntimeDefaults = {
  model: "claude-sonnet-5",
  effort: "medium",
  memoryLimitChars: 20000,
};

const implementations: readonly MockModuleImplementation[] = [
  {
    id: "banto.fs",
    roleId: "filesystem",
    name: "FileSystem（banto 標準）",
    isolation: "in-process",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["ファイルの読み書き tool", "Repo の worktree 操作"],
    hasConfigSurface: true,
    launchers: [{ id: "browser", label: "ファイルブラウザを開く", viewId: "browser" }],
  },
  {
    id: "banto.shell",
    roleId: "shell",
    name: "Shell（banto 標準・Landlock）",
    isolation: "subprocess",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["コマンド実行 tool", "alias 経由の秘密情報の注入"],
  },
  {
    id: "banto.skills",
    roleId: "skills",
    name: "Skill（banto 標準）",
    isolation: "in-process",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["Skill の取り込み・配布"],
  },
  {
    id: "community.skill-hub",
    roleId: "skills",
    name: "Skill Hub（第三者）",
    isolation: "subprocess",
    enabled: false,
    breaksIfDisabled: ["Skill Hub 経由で配られている Skill"],
  },
  {
    id: "banto.subagent",
    roleId: "subagent",
    name: "Subagent（banto 標準）",
    isolation: "in-process",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["サブエージェントへの依頼"],
  },
  {
    id: "banto.vault-local",
    roleId: "vault",
    name: "Vault（組み込みローカル）",
    isolation: "subprocess",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["資格情報の登録・切り替え", "alias 経由の秘密情報の注入"],
    hasConfigSurface: true,
  },
  {
    id: "hashicorp.vault",
    roleId: "vault",
    name: "HashiCorp Vault",
    isolation: "subprocess",
    enabled: true,
    breaksIfDisabled: ["この接続を参照している alias（下記）"],
    hasConfigSurface: true,
  },
  {
    id: "banto.repo",
    roleId: "repo",
    name: "Repo（banto 標準）",
    isolation: "subprocess",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["clone / worktree / GitHub 身元の割り当て"],
    hasConfigSurface: true,
    launchers: [{ id: "diff", label: "差分ビューを開く", viewId: "diff" }],
  },
];

export const mockRoles: readonly MockRole[] = [
  {
    id: "filesystem",
    name: "FileSystem",
    description: "ファイルを読む・書く。Project の根の外へ出さない（§3）。",
    implementations: implementations.filter((i) => i.roleId === "filesystem"),
  },
  {
    id: "shell",
    name: "Shell",
    description: "コマンドを実行する。Landlock で Project の根に閉じ込める（§2.7）。",
    implementations: implementations.filter((i) => i.roleId === "shell"),
  },
  {
    id: "skills",
    name: "Skill",
    description: "Skill を取り込む・作る・配る。複数の実装が同じ役割を名乗ってよい。",
    implementations: implementations.filter((i) => i.roleId === "skills"),
  },
  {
    id: "subagent",
    name: "Subagent",
    description: "サブエージェントに仕事を頼む。どの backend で走らせるか選ぶだけの薄い層。",
    implementations: implementations.filter((i) => i.roleId === "subagent"),
  },
  {
    id: "vault",
    name: "Vault",
    description:
      "鍵・トークンを預かる。必須 Module（決定・2026-09-01）——複数バックエンド可、組み込みローカルを同梱。",
    implementations: implementations.filter((i) => i.roleId === "vault"),
  },
  {
    id: "repo",
    name: "Repo",
    description: "複数リポジトリの一覧・worktree・clone/branch/log。GitHub 身元の割り当て。",
    implementations: implementations.filter((i) => i.roleId === "repo"),
  },
];

export function getImplementation(id: string): MockModuleImplementation | undefined {
  return implementations.find((i) => i.id === id);
}

export function getRoleForImplementation(implementationId: string): MockRole | undefined {
  const impl = getImplementation(implementationId);
  return impl ? mockRoles.find((r) => r.id === impl.roleId) : undefined;
}

/**
 * 階層1の左メニュー下段（iOS の「設定アプリ下部のアプリ一覧」と同じ形、
 * §6.2）に並ぶ Module。有効かつ `ui://<id>/config` を宣言しているものだけ
 * （決定・2026-09-01：無効化されているものは並べない）。
 */
export function getConfigurableImplementations(): readonly MockModuleImplementation[] {
  return implementations.filter((i) => i.enabled && i.hasConfigSurface);
}

/** Module 自身の設定面の中身（§6.2）。banto はこの値を持たない——モック限定のダミー */
export const mockModuleConfigFields: Readonly<
  Record<string, readonly { label: string; value: string }[]>
> = {
  "banto.fs": [
    { label: "隠しファイルを一覧に含める", value: "しない" },
    { label: "バイナリファイルの扱い", value: "diff を出さない" },
  ],
  "banto.vault-local": [
    { label: "暗号化方式", value: "age（X25519）" },
    { label: "バックアップ先", value: "~/.local/share/banto/vault-backup" },
  ],
  "hashicorp.vault": [
    { label: "エンドポイント", value: "https://vault.internal:8200" },
    { label: "名前空間", value: "banto/" },
    { label: "認証方式", value: "AppRole" },
  ],
  "banto.repo": [
    { label: "既定の clone 方式", value: "SSH" },
    { label: "worktree の置き場", value: "~/.local/share/banto/worktrees" },
  ],
};

export const mockCredentials: readonly MockCredential[] = [
  { id: "cred.personal", label: "Claude Pro（個人）", kind: "subscription", usagePercent: 62, resetsAt: "5時間窓：14:00" },
  { id: "cred.work", label: "Claude Max（仕事用）", kind: "subscription", usagePercent: 18, resetsAt: "7日窓：月曜" },
  { id: "cred.api", label: "API キー（従量課金）", kind: "api-key" },
];

// Project 単位の runtime config 上書き（§2.2「設定のカスケード」）。
// フィールドが無い項目は instance 既定を継承する。
export const mockProjectOverrides: readonly MockProjectOverrides[] = [
  {
    projectId: "banto",
    credentialId: "cred.personal",
    securityRoot: "~/worktrees/banto-v4",
  },
  {
    projectId: "home",
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    credentialId: "cred.work",
    vaultImplementationId: "hashicorp.vault",
    securityRoot: "~/srv/home-automation",
  },
  {
    projectId: "hermes",
    memoryLimitChars: 8000,
    credentialId: "cred.personal",
    securityRoot: "~/worktrees/hermes",
  },
];

export function getProjectOverrides(projectId: ProjectId): MockProjectOverrides {
  return (
    mockProjectOverrides.find((o) => o.projectId === projectId) ?? {
      projectId,
      securityRoot: "(未設定)",
    }
  );
}

export const mockProjectModuleLinks: readonly MockProjectModuleLink[] = [
  { projectId: "banto", implementationId: "banto.fs" },
  { projectId: "banto", implementationId: "banto.shell" },
  { projectId: "banto", implementationId: "banto.skills" },
  { projectId: "banto", implementationId: "banto.subagent" },
  { projectId: "banto", implementationId: "banto.vault-local" },
  { projectId: "banto", implementationId: "banto.repo" },
  { projectId: "home", implementationId: "banto.fs" },
  { projectId: "home", implementationId: "banto.shell" },
  { projectId: "home", implementationId: "banto.subagent" },
  { projectId: "home", implementationId: "hashicorp.vault" },
  { projectId: "hermes", implementationId: "banto.fs" },
  { projectId: "hermes", implementationId: "banto.skills" },
  { projectId: "hermes", implementationId: "banto.subagent" },
  { projectId: "hermes", implementationId: "banto.vault-local" },
  { projectId: "hermes", implementationId: "banto.repo" },
];

export function getProjectModuleLinks(projectId: ProjectId): readonly MockModuleImplementation[] {
  const ids = new Set(
    mockProjectModuleLinks.filter((l) => l.projectId === projectId).map((l) => l.implementationId),
  );
  return implementations.filter((i) => ids.has(i.id));
}

/**
 * この Project に繋がっている Module の launcher（§6.2「人が、AI を介さずに
 * 面を開く」）。Command Palette の「Module の入口」はここから出す
 * （§6.3——パレットは自分の索引を持たず、既にある Project の Module 集合から導出）
 */
export function getLaunchersForProject(
  projectId: ProjectId,
): readonly { implementationId: string; implementationName: string; id: string; label: string; viewId: string }[] {
  return getProjectModuleLinks(projectId).flatMap((impl) =>
    (impl.launchers ?? []).map((l) => ({
      implementationId: impl.id,
      implementationName: impl.name,
      ...l,
    })),
  );
}

export const mockVaultAliases: readonly MockVaultAlias[] = [
  {
    id: "alias.github-token",
    projectId: "banto",
    name: "github-token",
    implementationId: "banto.vault-local",
    path: "github/identityA/token",
    usedBy: ["Repo: identityA の push"],
  },
  {
    id: "alias.npm-token",
    projectId: "banto",
    name: "npm-token",
    implementationId: "banto.vault-local",
    path: "npm/publish-token",
    usedBy: ["Shell: npm publish"],
  },
  {
    id: "alias.home-mqtt",
    projectId: "home",
    name: "mqtt-password",
    implementationId: "hashicorp.vault",
    path: "secret/home/mqtt",
    usedBy: ["Shell: mosquitto_pub"],
  },
];

export function getVaultAliasesForProject(projectId: ProjectId): readonly MockVaultAlias[] {
  return mockVaultAliases.filter((a) => a.projectId === projectId);
}
