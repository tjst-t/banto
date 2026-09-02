import type {
  MockCredential,
  MockEffortLevel,
  MockModuleImplementation,
  MockProjectModuleLink,
  MockProjectOverrides,
  MockRole,
  MockRuntimeDefaults,
  MockVaultAlias,
  MockVaultGroup,
  MockVaultGroupBinding,
  ProjectId,
  RoleId,
} from "./types";
import { notifyMockStoreChange } from "./store-events";

// 設定のモックデータ（§2.10・§6.1）。実装は捨てる前提ではないが、UI を固める
// ことが目的——バックエンドとは繋がっていない（`mock/README.md`）。

export const mockRuntimeDefaults: MockRuntimeDefaults = {
  model: "claude-sonnet-5",
  effort: "medium",
  memoryLimitChars: 20000,
};

/** Agent SDK の Options.model が受け付ける文字列（選択肢はモック用の代表例） */
export const MOCK_MODELS: readonly string[] = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
];

/** Agent SDK の Options.effort が受け付ける5段階（低い順） */
export const MOCK_EFFORT_LEVELS: readonly MockEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * mcpServersJson を組み立てる（§5.1）——role の宣言は `_meta["dev.banto/module"]`
 * に乗せる、追加した Add Module ダイアログと同じ形。banto 組み込み実装も
 * 見た目上は普通の mcpServers エントリとして持つ（実際にどう起動するかは
 * 本実装の話、モックでは形だけ揃える）
 */
function sampleMcpServersJson(
  serverName: string,
  command: string,
  args: readonly string[],
  satisfies: readonly RoleId[],
): string {
  return JSON.stringify(
    { [serverName]: { command, args, _meta: { "dev.banto/module": { satisfies } } } },
    null,
    2,
  );
}

// item14「instance が新しい実装を知る」（§5.1）で増えるので mutable。
// projects.ts/threads.ts と同じパターン——`notifyMockStoreChange` で購読側に知らせる
let implementations: MockModuleImplementation[] = [
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
    mcpServersJson: sampleMcpServersJson("banto-fs", "node", ["./modules/fs/index.js"], ["filesystem"]),
  },
  {
    id: "banto.shell",
    roleId: "shell",
    name: "Shell（banto 標準・Landlock）",
    isolation: "subprocess",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["コマンド実行 tool", "alias 経由の秘密情報の注入"],
    mcpServersJson: sampleMcpServersJson("banto-shell", "node", ["./modules/shell/index.js"], ["shell"]),
  },
  {
    id: "banto.skills",
    roleId: "skills",
    name: "Skill（banto 標準）",
    isolation: "in-process",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["Skill の取り込み・配布"],
    mcpServersJson: sampleMcpServersJson("banto-skills", "node", ["./modules/skills/index.js"], ["skills"]),
  },
  {
    id: "community.skill-hub",
    roleId: "skills",
    name: "Skill Hub（第三者）",
    isolation: "subprocess",
    enabled: false,
    breaksIfDisabled: ["Skill Hub 経由で配られている Skill"],
    mcpServersJson: sampleMcpServersJson("skill-hub", "npx", ["-y", "skill-hub-mcp"], ["skills"]),
  },
  {
    id: "banto.subagent",
    roleId: "subagent",
    name: "Subagent（banto 標準）",
    isolation: "in-process",
    builtin: true,
    enabled: true,
    breaksIfDisabled: ["サブエージェントへの依頼"],
    mcpServersJson: sampleMcpServersJson("banto-subagent", "node", ["./modules/subagent/index.js"], ["subagent"]),
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
    mcpServersJson: sampleMcpServersJson("banto-vault-local", "node", ["./modules/vault-sops/index.js"], ["vault"]),
  },
  {
    id: "hashicorp.vault",
    roleId: "vault",
    name: "HashiCorp Vault",
    isolation: "subprocess",
    enabled: true,
    breaksIfDisabled: ["この接続を参照している alias（下記）"],
    hasConfigSurface: true,
    mcpServersJson: sampleMcpServersJson(
      "hashicorp-vault",
      "npx",
      ["-y", "@hashicorp/vault-mcp"],
      ["vault"],
    ),
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
    mcpServersJson: sampleMcpServersJson("banto-repo", "node", ["./modules/repo/index.js"], ["repo"]),
  },
  {
    id: "banto.vault-ui",
    roleId: "vault-ui",
    name: "VaultUI（横断管理）",
    isolation: "in-process",
    builtin: true,
    enabled: true,
    // 自身は秘密を持たない（vault役割には依存するだけ）ので in-process でよい——
    // 鍵を持つものだけ subprocess にする、という判定基準（requirements C8b）どおり
    breaksIfDisabled: ["Vault を横断して管理する画面"],
    launchers: [{ id: "manage", label: "Vault を管理", viewId: "manage" }],
    mcpServersJson: sampleMcpServersJson("banto-vault-ui", "node", ["./modules/vault-ui/index.js"], ["vault-ui"]),
  },
];

const roleDefs: readonly Omit<MockRole, "implementations">[] = [
  {
    id: "filesystem",
    name: "FileSystem",
    description: "ファイルを読む・書く。Project の根の外へ出さない。",
  },
  {
    id: "shell",
    name: "Shell",
    description: "コマンドを実行する。Landlock で Project の根に閉じ込める。",
  },
  {
    id: "skills",
    name: "Skill",
    description: "Skill を取り込む・作る・配る。複数の実装が同じ役割を名乗ってよい。",
  },
  {
    id: "subagent",
    name: "Subagent",
    description: "サブエージェントに仕事を頼む。どの backend で走らせるか選ぶだけの薄い層。",
  },
  {
    id: "vault",
    name: "Vault",
    description: "鍵・トークンを預かる。必須 Module——複数バックエンド可、組み込みローカルを同梱。",
  },
  {
    id: "repo",
    name: "Repo",
    description: "複数リポジトリの一覧・worktree・clone/branch/log。GitHub 身元の割り当て。",
  },
  {
    id: "vault-ui",
    name: "VaultUI",
    description:
      "複数の Vault 実装を横断して alias を確認・編集する。AI には公開せず、admin 可視性の tool を host 中継経由で呼ぶ（v4-modules.md §2.1）。",
  },
];

/** role → 実装 の辞書を毎回組み直す——`implementations` は増減するので、焼き込んだ配列にしない */
export function getRoles(): readonly MockRole[] {
  return roleDefs.map((role) => ({
    ...role,
    implementations: implementations.filter((i) => i.roleId === role.id),
  }));
}

export function getRole(roleId: RoleId): MockRole | undefined {
  return getRoles().find((r) => r.id === roleId);
}

export function getImplementation(id: string): MockModuleImplementation | undefined {
  return implementations.find((i) => i.id === id);
}

export function getRoleForImplementation(implementationId: string): MockRole | undefined {
  const impl = getImplementation(implementationId);
  return impl ? getRole(impl.roleId) : undefined;
}

/**
 * item14「instance が新しい実装を知る」（§5.1 の4つの発見元）で見つけた
 * 実装を、instance の辞書に足す。Project への接続は別（`mockProjectModuleLinks`）——
 * 「instance が知っている」と「この Project が使う」は別の操作（§6.1）
 */
export function createImplementation(
  input: Omit<MockModuleImplementation, "enabled" | "breaksIfDisabled" | "mcpServersJson"> &
    Partial<Pick<MockModuleImplementation, "enabled" | "breaksIfDisabled" | "mcpServersJson">>,
): MockModuleImplementation {
  const impl: MockModuleImplementation = {
    enabled: true,
    breaksIfDisabled: [],
    // レジストリ／server.json 由来（mcpServers の生JSONを人が書いていない経路）
    // は、この場で mcpServers 形式に変換して持つ——§5.1「mcpServersが唯一の
    // 真実」を、取り込み元によらず維持する
    mcpServersJson: sampleMcpServersJson(input.id, "npx", ["-y", input.name], [input.roleId]),
    ...input,
  };
  implementations = [...implementations, impl];
  notifyMockStoreChange();
  return impl;
}

/**
 * 取り込み済みの実装の起動設定を書き換える（§6.1「インストール済み Module の
 * 設定を変える」）。mcpServersJson を直接編集する——banto 独自の構造化編集
 * フォームは持たない（§5.1、`AddModuleDialog` の mcpServers タブと同じ形）。
 * JSON から role（`_meta["dev.banto/module"].satisfies`）と表示名（最初の
 * キー）を再度導出し、`roleId`/`name` も一緒に更新する
 */
export function updateImplementationMcpServersJson(id: string, mcpServersJson: string): MockModuleImplementation | null {
  const idx = implementations.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const parsed = JSON.parse(mcpServersJson) as Record<string, unknown>;
  const [serverName, entry] = Object.entries(parsed)[0] ?? [];
  if (!serverName) return null;
  const meta = (entry as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const moduleMeta = meta?.["dev.banto/module"] as { satisfies?: readonly string[] } | undefined;
  const roleId = moduleMeta?.satisfies?.[0];
  if (!roleId) return null;
  const updated: MockModuleImplementation = {
    ...implementations[idx],
    name: serverName,
    roleId,
    mcpServersJson,
  };
  implementations = implementations.map((i) => (i.id === id ? updated : i));
  notifyMockStoreChange();
  return updated;
}

/**
 * instance の辞書から実装を削除する（アンインストール）。banto 組み込み
 * （`builtin`）は削除できない——同梱物を消せると「起動直後から候補が必ず
 * 1つある」という Vault の前提（§2.8）等が崩れる
 */
export function removeImplementation(id: string): void {
  const impl = getImplementation(id);
  if (!impl || impl.builtin) return;
  implementations = implementations.filter((i) => i.id !== id);
  mockProjectModuleLinks = mockProjectModuleLinks.filter((l) => l.implementationId !== id);
  notifyMockStoreChange();
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
    { label: "暗号化方式", value: "SOPS（age鍵）" },
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
let mockProjectOverrides: MockProjectOverrides[] = [
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

/** createProject（projects.ts）専用。新規 Project の Advanced で選んだ上書きを保存する */
export function setProjectOverrides(overrides: MockProjectOverrides): void {
  const exists = mockProjectOverrides.some((o) => o.projectId === overrides.projectId);
  mockProjectOverrides = exists
    ? mockProjectOverrides.map((o) => (o.projectId === overrides.projectId ? overrides : o))
    : [...mockProjectOverrides, overrides];
}

let mockProjectModuleLinks: MockProjectModuleLink[] = [
  { projectId: "banto", implementationId: "banto.fs" },
  { projectId: "banto", implementationId: "banto.shell" },
  { projectId: "banto", implementationId: "banto.skills" },
  { projectId: "banto", implementationId: "banto.subagent" },
  { projectId: "banto", implementationId: "banto.vault-local" },
  { projectId: "banto", implementationId: "banto.repo" },
  { projectId: "banto", implementationId: "banto.vault-ui" },
  { projectId: "home", implementationId: "banto.fs" },
  { projectId: "home", implementationId: "banto.shell" },
  { projectId: "home", implementationId: "banto.subagent" },
  { projectId: "home", implementationId: "hashicorp.vault" },
  { projectId: "home", implementationId: "banto.vault-ui" },
  { projectId: "hermes", implementationId: "banto.fs" },
  { projectId: "hermes", implementationId: "banto.skills" },
  { projectId: "hermes", implementationId: "banto.subagent" },
  { projectId: "hermes", implementationId: "banto.vault-local" },
  { projectId: "hermes", implementationId: "banto.repo" },
  { projectId: "hermes", implementationId: "banto.vault-ui" },
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

// VaultUI（横断管理、§2.1 C節）で編集するので mutable。他の mock ストアと
// 同じパターン——`notifyMockStoreChange` で購読側に知らせる
let vaultAliases: MockVaultAlias[] = [
  {
    id: "alias.github-token",
    scope: "project",
    projectId: "banto",
    name: "github-token",
    kind: "secret",
    implementationId: "banto.vault-local",
    path: "github/identityA/token",
    note: "GitHub identityA への push 用トークン",
    usedBy: ["Repo: identityA の push"],
    lastUsedAt: "12分前",
  },
  {
    id: "alias.identityA-ssh",
    scope: "project",
    projectId: "banto",
    name: "identityA-ssh",
    kind: "ssh-identity",
    implementationId: "banto.vault-local",
    path: "github/identityA",
    note: "GitHub identityA の SSH 鍵（ssh-agent 経由、鍵そのものは出さない）",
    usedBy: ["Repo: identityA の clone / push"],
    lastUsedAt: "12分前",
  },
  {
    id: "alias.npm-token",
    scope: "project",
    projectId: "banto",
    name: "npm-token",
    kind: "secret",
    implementationId: "banto.vault-local",
    path: "npm/publish-token",
    note: "npm publish 用トークン",
    usedBy: ["Shell: npm publish"],
    lastUsedAt: "3日前",
    expiresAt: "30日後に失効",
  },
  {
    id: "alias.claude-work-oauth",
    scope: "instance",
    name: "claude-work-oauth",
    kind: "secret",
    implementationId: "banto.vault-local",
    path: "claude/work-oauth",
    note: "Claude Max（仕事用）の資格情報。§2.8——instance 全体で共有",
    usedBy: ["core: Runner の資格情報選択"],
    lastUsedAt: "5時間前",
  },
  {
    id: "alias.home-mqtt",
    scope: "project",
    projectId: "home",
    name: "mqtt-password",
    kind: "secret",
    implementationId: "hashicorp.vault",
    path: "secret/home/mqtt",
    note: "自宅 MQTT ブローカーへの publish パスワード",
    usedBy: ["Shell: mosquitto_pub"],
    lastUsedAt: "1時間前",
  },
];

export function getVaultAliasesForProject(projectId: ProjectId): readonly MockVaultAlias[] {
  return vaultAliases.filter((a) => a.projectId === projectId);
}

/** VaultUI（横断管理）向け——scope・Project を問わず全 alias を返す */
export function getAllVaultAliases(): readonly MockVaultAlias[] {
  return vaultAliases;
}

/** `vault` role を満たす実装だけ（VaultUI が横断表示する対象、§2.1） */
export function getVaultImplementations(): readonly MockModuleImplementation[] {
  return implementations.filter((i) => i.roleId === "vault");
}

/**
 * alias の新規登録（v4-modules.md §2.1 C節）。**値はこの関数の引数に含めない**
 * ——実際の値は VaultUI の画面から host 中継を経由して backend へ渡るだけで、
 * banto のどのストアにも残らない（D3・§2.5 の中継規律）。ここではその後に残る
 * メタデータだけを保存する
 */
export function createVaultAlias(
  input: Omit<MockVaultAlias, "id" | "usedBy" | "lastUsedAt">,
): MockVaultAlias {
  const alias: MockVaultAlias = {
    ...input,
    id: `alias.${input.name}-${Date.now()}`,
    usedBy: [],
  };
  vaultAliases = [...vaultAliases, alias];
  notifyMockStoreChange();
  return alias;
}

/** note の書き換え（C節「note の記入」） */
export function updateVaultAliasNote(id: string, note: string): void {
  vaultAliases = vaultAliases.map((a) => (a.id === id ? { ...a, note } : a));
  notifyMockStoreChange();
}

export function deleteVaultAlias(id: string): void {
  vaultAliases = vaultAliases.filter((a) => a.id !== id);
  notifyMockStoreChange();
}

// Project ↔ backend グループの紐付け（v4-modules.md §2.1）。既存グループは
// backend ごとに元々あるものとして持たせ、`createVaultGroup` で人が増やせる
let vaultGroups: MockVaultGroup[] = [
  { implementationId: "banto.vault-local", name: "banto" },
  { implementationId: "banto.vault-local", name: "home" },
  { implementationId: "banto.vault-local", name: "hermes" },
  { implementationId: "banto.vault-local", name: "instance-shared" },
  { implementationId: "hashicorp.vault", name: "secret/home" },
];

let vaultGroupBindings: MockVaultGroupBinding[] = [
  { implementationId: "banto.vault-local", target: "banto", groupName: "banto" },
  { implementationId: "banto.vault-local", target: "instance", groupName: "instance-shared" },
  { implementationId: "hashicorp.vault", target: "home", groupName: "secret/home" },
];

/** ある backend が持つグループの一覧（既存グループから選ぶ側の選択肢） */
export function getVaultGroups(implementationId: string): readonly MockVaultGroup[] {
  return vaultGroups.filter((g) => g.implementationId === implementationId);
}

/** Project（または `"instance"`）が、ある backend のどのグループを使っているか */
export function getVaultGroupBinding(
  implementationId: string,
  target: "instance" | ProjectId,
): MockVaultGroupBinding | undefined {
  return vaultGroupBindings.find((b) => b.implementationId === implementationId && b.target === target);
}

/**
 * 新しいグループを作る（v4-modules.md §2.1「既存グループを使い回すだけでなく、
 * 新しくグループを作る仕組みも要る」）。backend によっては事前の作成 API 呼び
 * 出しが要る（Infisical の Folder 等）——このモックでは一覧に足すだけで表現する
 */
export function createVaultGroup(implementationId: string, name: string): MockVaultGroup {
  const group: MockVaultGroup = { implementationId, name };
  vaultGroups = [...vaultGroups, group];
  notifyMockStoreChange();
  return group;
}

/** 紐付けを設定・上書きする。2台のホストで同じ backend・同じグループを割り当てれば、それが共有の合図になる */
export function setVaultGroupBinding(
  implementationId: string,
  target: "instance" | ProjectId,
  groupName: string,
): void {
  const exists = vaultGroupBindings.some((b) => b.implementationId === implementationId && b.target === target);
  vaultGroupBindings = exists
    ? vaultGroupBindings.map((b) =>
        b.implementationId === implementationId && b.target === target ? { ...b, groupName } : b,
      )
    : [...vaultGroupBindings, { implementationId, target, groupName }];
  notifyMockStoreChange();
}
