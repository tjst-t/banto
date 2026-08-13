/**
 * banto-core public API
 *
 * Consumer-style tests and daemon code import ONLY from this file.
 * Internal module paths must NOT be imported directly from outside this package.
 */

// Event types
export type {
  OrchestrationEvent,
  EventBase,
  TaskStatus,
  TaskCreatedEvent,
  StateTransitionedEvent,
  AgentSpawnedEvent,
  AgentExitedEvent,
  GateEvaluatedEvent,
  TaskApprovedEvent,
  TaskRejectedEvent,
  PoOperationEvent,
  CardGeneratedEvent,
  EnvProvisionedEvent,
  EnvTornDownEvent,
  TaskMergedEvent,
  TransitionRejectedEvent,
  TaskPausedEvent,
  TaskResumedEvent,
  TaskFailedEvent,
  TaskSupersededEvent,
  TaskIngestRejectedEvent,
  TickJobFailedEvent,
  MergeGateEvaluatedEvent,
  AuditStartedEvent,
  AuditVerdictEvent,
  AuditSpawnDisabledEvent,
  DaemonConfigEvent,
  EnvProfileRejectedEvent,
  EnvProvisionFailedEvent,
} from "./events.js";

// Environment profile parser (spec-environment §1)
export { parseEnvProfiles, validateProfile, parseTtl } from "./env-profile-parser.js";
// 検証環境を外から見えるようにする口（決定39・imp-0008）。配置で手段が変わるので差し替え可能
export type { EnvExposer, ExposedEnv, ExposeRequest } from "./env-exposer.js";
// モジュールが設定画面に自分の設定を出す契約（決定41）。GUI ではなく項目の宣言を渡す
export type {
  SettingField,
  SettingFieldType,
  SettingsFields,
  ModuleSettingsSpec,
  SettingsSection,
  SettingsWriteResult,
} from "./module-settings.js";
// 別プロセスのモジュールが設定を届けるための橋（task-0066）
export {
  createSettingsTools,
  createFileSettingsSection,
  resolveSettingsFields,
} from "./module-settings.js";
export type {
  EnvProfile,
  ProfileValidation,
  ParseEnvProfilesResult,
} from "./env-profile-parser.js";

// Task frontmatter parser + validator
export { validateTaskFrontmatter, extractFrontmatter, parseYamlFrontmatter } from "./task-frontmatter.js";
export type { TaskFrontmatter, FrontmatterValidation } from "./task-frontmatter.js";

// EventLog
export { EventLog } from "./event-log.js";
export type {
  EventPayload,
  ReplayStats,
  Snapshot,
  SnapshotState,
  TaskRecord,
} from "./event-log.js";

// StateStore (replay engine + in-memory derived state)
export { StateStore } from "./state-store.js";

// EventIndex (in-memory task/project history views)
export { EventIndex } from "./event-index.js";

// StateMachine (task state machine: transition table + cross-cutting transitions)
export { StateMachine } from "./state-machine.js";
export type { TransitionResult } from "./state-machine.js";

// DaemonClient (fetch-based HTTP client for banto-daemon REST API)
export { DaemonClient, DaemonConnectionError, DaemonApiError } from "./daemon-client.js";
export type { ProjectEntry, HealthResponse } from "./daemon-client.js";

// RuntimeDriver contract — runtime-neutral session lifecycle abstraction (spec §3.5)
export { RuntimeDriverRegistry } from "./runtime-driver.js";
export type {
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
  DriverEvent,
  DriverEventHandler,
  DriverId,
} from "./runtime-driver.js";

/**
 * BantoHarness — 番頭の**会話の契約**（ADR-0020 決定88・89）。
 *
 * `RuntimeDriver`（上）と併置する。あちらは**プロセスの監督＝関所**、こちらは
 * **会話のやり方＝差し替えるもの**。層が違うので流用しない。
 */
export type {
  BantoHarness,
  HarnessEvent,
  HarnessImage,
  HarnessPromptOptions,
  ChapterOpening,
} from "./banto-harness.js";

// Executor + audit tool definitions (runtime-neutral; no pi/agent-sdk imports)
// Tool 契約（ランタイム中立・決定1／task-0025）。契約の型はこの1つだけ
export { defineBantoTool, defineNamespacedTool } from "./banto-tool.js";
export type {
  BantoToolDefinition,
  NamespacedToolDefinition,
  AnyBantoTool,
  BantoToolResult,
  BantoToolTextContent,
  BantoToolContext,
} from "./banto-tool.js";

// LLM Catalog — プロバイダ・モデル・キーの一元管理（ADR-0004 / spec §3.5）
export {
  LlmCatalog,
  MODEL_TIERS,
  TIER_LABELS,
  DEFAULT_TIER_DESCRIPTIONS,
  CONSTRAINT_KEYS,
  isModelTier,
  // 役割ごとの束縛（ADR-0020 決定94）。束縛の表はこれ1つ
  LLM_ROLES,
  isLlmRole,
  workerRoleOf,
  // ハーネスに依存しないモデル解決（task-0066）。工房が独立サービスとして立つのに要る
  MODEL_ALIASES,
  createFileModelResolver,
  piAgentDir,
} from "./llm-registry.js";
export type {
  LlmRole,
  LlmRoleBindings,
  LlmModelRef,
  ModelTier,
  ModelConstraints,
  KeyScope,
  KeyState,
  LlmKeyInfo,
  LlmProviderInfo,
  LlmModelInfo,
  LlmTierInfo,
  LlmDefaults,
  LlmFileState,
  LlmResolution,
  LlmCatalogData,
  LlmCatalogOptions,
  LlmModelResolver,
  ResolvedModel,
} from "./llm-registry.js";

// 場所（Place）— 番頭が作業してよい場所の契約（決定36c）
// 親子関係（PO裁定 2026-08-05）：ワークツリーは親リポジトリを指し、記憶の層は親で決まる
export type { Place, PlaceProvider } from "./place.js";
export { projectIdOf, projectScopesOf, resolveProjects } from "./place.js";
export type { ProjectResolution } from "./place.js";

// Tool 名前空間の規約（決定9・決定22）。モジュールが banto-host 抜きで名乗れるよう core に置く
export {
  isNamespacedToolName,
  assertNamespacedToolName,
  toolDomain,
  toWireToolName,
  fromWireToolName,
} from "./tool-namespace.js";
export type { NamespacedToolName } from "./tool-namespace.js";

// 職人・監査セッション向けの Tool。依存（DaemonClient）は引数で受ける
export { createExecutorTools, createAuditTools } from "./tools.js";

// Prompt asset loader (reads from skills/ directory at repo root)
export { loadPromptAsset } from "./prompt-assets.js";

// Environment driver contract types — spec-environment §2
// D1: field names in input/output shapes are FIXED to spec §2. Do NOT rename without ADR.
export type {
  EnvDriverVerb,
  EnvHandle,
  ProvisionInput,
  DeployInput,
  HealthcheckInput,
  RunInput,
  CollectInput,
  TeardownInput,
  ListInput,
  ProvisionOutput,
  DeployOutput,
  HealthcheckOutput,
  RunOutput,
  CollectOutput,
  TeardownOutput,
  ListItem,
  ListOutput,
  EnvDriverInput,
} from "./env-driver.js";
export { ENV_DRIVER_VERBS } from "./env-driver.js";

// 番頭の記憶（第一層：好み・習慣）— ADR-0010 決定10 / D11
// 注入の予算（提案3.3）と二層（ADR-0003）もここから出す
export {
  JsonlMemoryStore,
  ScopedMemory,
  selectMemoriesForBudget,
  estimateMemoryTokens,
  DEFAULT_MEMORY_TOKEN_BUDGET,
} from "./memory.js";
export type {
  MemoryStore,
  MemoryRecord,
  MemoryInput,
  MemoryQuery,
  MemorySearchQuery,
  MemoryKind,
  MemoryOrigin,
  MemoryScope,
  MemoryBudgetResult,
} from "./memory.js";

// モジュール間呼び出し（ADR-0010 決定27b）。Kobo など banto-host に依存できない側からも使う
export {
  moduleRegistryPath,
  loadModuleRegistryConfig,
  resolveModuleEndpoint,
  createModuleClient,
  longCallFetch,
} from "./module-invocation.js";
export {
  MODULE_TOOL_PATH,
  type ModuleToolRequest,
  type ModuleToolResult,
  type ModuleToolError,
} from "./module-protocol.js";
export type {
  ModuleRegistryEntry,
  ModuleRegistryConfig,
  ModuleClient,
} from "./module-invocation.js";
