// 名前空間の規約は banto-core が持つ（task-0025）。既存の利用者のために再輸出する
export {
  isNamespacedToolName,
  assertNamespacedToolName,
  toolDomain,
  toWireToolName,
  fromWireToolName,
  type NamespacedToolName,
} from "@banto/core";
export {
  defineNamespacedTool,
  createToolRegistry,
  toPiTool,
  type NamespacedToolDefinition,
  type ToolRegistry,
} from "./tool-registry.js";
export { createBantoHostSession, type CreateBantoHostSessionOptions } from "./host-session.js";
export { createMemoryTools, renderMemoryForPrompt } from "./memory-tools.js";
export { createSkillTools } from "./skill-tools.js";
export {
  bantoSkillsDir,
  loadBantoSkills,
  renderSkillsForPrompt,
  readBantoSkill,
  type BantoSkill,
} from "./skills.js";
export { BantoHostServer, type BantoHostServerOptions, type HostSession } from "./server.js";
// 会話スレッド＝番頭の分身（決定2・task-0035）
export { Thread, ThreadRegistry, type ThreadFactory } from "./threads.js";
export { createThreadTools, bindToolArgs, type ThreadToolsOptions } from "./thread-tools.js";
// 場所の帳簿と砦（決定36・38）
export {
  PlaceRegistry,
  createStaticPlaceProvider,
  resolveInPlace,
  assertWritable,
  broadlyWritable,
  type PlaceGrantSource,
  type StaticPlaceConfig,
} from "./places.js";
export { placeScopedTools, guardPathArg, PLACE_PARAM } from "./place-scoped.js";
export { BantoHostClient, type ServerEventHandler } from "./client.js";
export {
  BANTO_WS_PATH,
  BANTO_DEFAULT_PORT,
  type ClientMessage,
  type ServerEvent,
  type PromptMessage,
  type AbortMessage,
  type WelcomeEvent,
  type TextDeltaEvent,
  type ToolStartEvent,
  type ToolEndEvent,
  type TurnEndEvent,
  type ErrorEvent,
} from "./protocol.js";
export {
  Canvas,
  createCanvasCatalog,
  type CanvasCatalog,
  type CanvasViewSpec,
  type CanvasTab,
  type CanvasSnapshot,
} from "./canvas.js";
export { createCanvasTools } from "./canvas-tools.js";
export type {
  CanvasStateEvent,
  CanvasTabView,
  CatalogEntryView,
  CanvasReorderMessage,
  CanvasOpenMessage,
} from "./protocol.js";
export { demoCanvasViews } from "./demo-views.js";
export type { TranscriptEntry, HistoryEvent, PoMessageEvent } from "./protocol.js";
export { createFileTools } from "./file-tools.js";
export { createFileWriteTools, type FileWriteToolOptions } from "./file-write-tools.js";
export { createPlaceTools } from "./place-tools.js";
export { ThreadStore, type StoredThread } from "./thread-store.js";
export { SettingsStore, type BantoSettings, type PlaceSetting } from "./settings-store.js";
export { createCoreSettingsSections } from "./core-settings.js";
export {
  createSettingsModule,
  settingsSection,
  SETTINGS_BASE_URL,
} from "./settings-module.js";
export {
  createPlaceRequestTools,
  createPlaceGrantAdminTools,
  PLACE_PERMISSIONS_VIEW_KIND,
} from "./place-grant-tools.js";
export { PlaceGrantStore, type PlaceGrantRequest, type PlaceGrantState } from "./place-grants.js";
export { createGitTools } from "./git-tools.js";
export { workspaceRoot, resolveInWorkspace, toWorkspaceRelative } from "./workspace.js";
export {
  createModuleRegistry,
  resolveSkills,
  moduleDomains,
  CORE_ORIGIN,
  type BantoModule,
  type ModuleEndpoint,
  type ModuleRegistry,
  type SkillEntry,
} from "./module.js";
export { createWorkspaceModule, WORKSPACE_BASE_URL } from "./modules/workspace.js";
export { createDemoModule } from "./modules/demo.js";
export { createModuleToolHandler } from "./module-serve.js";

export {
  BANTO_ORIGIN,
  threadOrigin,
  threadIdOfOrigin,
  isBantoOrigin,
  renderWorkerNotice,
  isNoticeworthy,
} from "./worker-notice.js";
export { createStudioModule, STUDIO_BASE_URL } from "./modules/studio.js";
export { createPiAgentModule, PI_AGENT_BASE_URL } from "./modules/pi-agent.js";
// 空応答ガード（imp-0016 再発防止）。ツール実行後の継続ターンが空応答で停止する事象への防御
// （判断ロジックは turn-guard.ts にあり、server.ts は HostSession 契約のまま無変更）
export {
  EMPTY_RESPONSE_MAX_RETRIES,
  isEmptyResponse,
  isRetryableEmptyResponse,
  findLastEmptyAssistantIndex,
  withEmptyResponseGuard,
  type GuardableSession,
} from "./turn-guard.js";
