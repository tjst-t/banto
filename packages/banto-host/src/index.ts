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

export { BANTO_ORIGIN, renderWorkerNotice, isNoticeworthy } from "./worker-notice.js";
export { createStudioModule, STUDIO_BASE_URL } from "./modules/studio.js";
