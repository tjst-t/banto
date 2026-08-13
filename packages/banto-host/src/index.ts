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
// pi バックエンド（ADR-0020 決定89）。`BantoHarness` の第一実装
export { PiHarness, type PiHarnessOptions } from "./pi-harness.js";
// Agent SDK バックエンド（ADR-0020 決定89・91〜93）。番頭を Claude Code で回す
export {
  ClaudeAgentHarness,
  BANTO_MCP_SERVER,
  type ClaudeAgentHarnessOptions,
} from "./claude-agent-harness.js";
export { jsonSchemaToZod, jsonSchemaToZodShape } from "./schema-to-zod.js";
export {
  PRESENTED_TOOL_NAMES,
  presentedWireNames,
  renderToolCategories,
  selectPresentedTools,
} from "./presented-tools.js";
export {
  createMemoryTools,
  renderMemoryForPrompt,
  type MemoryToolsOptions,
  type RenderMemoryOptions,
} from "./memory-tools.js";
// ツール出力の退避（提案§3.1）。要約せず参照に置き換えるので情報を失わない
export {
  ArtifactStore,
  withArtifactOffload,
  outlineOf,
  renderStub,
  renderArtifactIndex,
  DEFAULT_ARTIFACT_THRESHOLD_CHARS,
  type ArtifactRef,
  type ArtifactSlice,
  type ArtifactSummary,
  type ArtifactRecord,
  type ArtifactOffloadOptions,
} from "./artifacts.js";
export { createArtifactTools } from "./artifact-tools.js";
// 章立て（提案§3.2）。コンパクションの代わりに、区切りで畳んで引き継ぐ
export {
  HandoffStore,
  renderSummary,
  renderChapterOpening,
  type HandoffSummary,
  type HandoffRecord,
} from "./handoffs.js";
export {
  ChapterKeeper,
  renderTranscript,
  DEFAULT_CHAPTER_THRESHOLD_RATIO,
  DEFAULT_MIN_MESSAGES,
  type ChapterKeeperOptions,
  type ChapterInput,
  type ChapterHandoff,
} from "./chapters.js";
export { createHandoffTools } from "./handoff-tools.js";
export {
  createLlmChapterSummarizer,
  parseHandoff,
  type ChapterSummarizerOptions,
} from "./chapter-summarizer.js";
// 記憶の評価セット（提案§3.6）。測らなければ静かに腐る
export {
  runMemoryEval,
  DEFAULT_MEMORY_EVAL,
  type MemoryEvalCase,
  type MemoryEvalCategory,
  type MemoryEvalResult,
  type MemoryEvalReport,
} from "./memory-eval.js";
// 記憶の自動抽出（提案§3.4・決定28）。差分だけを受け取り、既存の記憶を書き直させない
export {
  createLlmMemoryExtractor,
  parseDeltas,
  applyMemoryDeltas,
  type MemoryDelta,
  type MemoryExtractorOptions,
  type MemoryExtractionInput,
  type MemoryApplyResult,
} from "./memory-extraction.js";
export { createSkillTools, type SkillToolsOptions } from "./skill-tools.js";
// SKILL の学習層（決定26・task-0017）。既定を上書きし、既定が変わったら黙って隠さない
export {
  LearnedSkillStore,
  LEARNED_ORIGIN,
  skillHash,
  detectStaleOverrides,
  renderStaleOverrides,
  type LearnedSkill,
  type SkillBaseline,
  type StaleOverride,
} from "./skill-learning.js";
// 文脈長の引き当て規則。取り込みの中核なのでテストから直接見る
export { contextWindowFromCatalog } from "./llm-tools.js";
export {
  bantoSkillsDir,
  loadBantoSkills,
  renderSkillsForPrompt,
  readBantoSkill,
  type BantoSkill,
} from "./skills.js";
export { BantoHostServer, type BantoHostServerOptions, type HostSession } from "./server.js";
// 会話は幹1本と枝（ADR-0017 決定77。分身の単位が枝になった）
export {
  Thread,
  ThreadRegistry,
  BRANCH_STALE_DAYS,
  MAX_THREAD_TITLE_LENGTH,
  normalizeThreadTitle,
  trunkIdOf,
  type BranchNote,
  type ThreadFactory,
  type ThreadSpec,
} from "./threads.js";
export { watchStaleBranches } from "./threads.js";
export {
  createThreadTools,
  bindToolArgs,
  allowSend,
  resetSendCounters,
  type ThreadToolsOptions,
} from "./thread-tools.js";
// 場所の帳簿と砦（決定36・38）
export {
  PlaceRegistry,
  createStaticPlaceProvider,
  resolveInPlace,
  assertWritable,
  broadlyWritable,
  DESK_PLACE_ID,
  defaultDeskPlace,
  withDefaultDesk,
  ensureDeskDir,
  type PlaceGrantSource,
  type StaticPlaceConfig,
} from "./places.js";
export { placeScopedTools, guardPathArg, PLACE_PARAM } from "./place-scoped.js";
// 決定63: 起こしていない職人は畳めない（Tool を束ねる層の砦）
export { guardWorkerOrigin } from "./worker-guard.js";
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
export { createCanvasTools, type CanvasToolsOptions } from "./canvas-tools.js";
// 器＝中核が持つ有限の語彙（ADR-0017 決定78・81）。番頭は選ぶが、作らない
export {
  buildUtsuwa,
  brokenUtsuwa,
  pickPath,
  SHOWABLE_UTSUWA_KINDS,
  UTSUWA_NOT_SHOWABLE,
  type UtsuwaOrigin,
  type UtsuwaLabels,
  type UtsuwaBuildResult,
} from "./canvas-utsuwa.js";
export type {
  CanvasStateEvent,
  CanvasTabView,
  CatalogEntryView,
  CanvasReorderMessage,
  CanvasOpenMessage,
} from "./protocol.js";
export type { TranscriptEntry, HistoryEvent, PoMessageEvent } from "./protocol.js";
export {
  UTSUWA_KINDS,
  type UtsuwaKind,
  type UtsuwaState,
  type UtsuwaView,
  type UtsuwaEvent,
  type BranchOpener,
  type ThreadView,
  type ThreadOpenMessage,
  type ThreadMergeMessage,
} from "./protocol.js";
export { createFileTools } from "./file-tools.js";
export { createFileWriteTools, type FileWriteToolOptions } from "./file-write-tools.js";
export { createPlaceTools } from "./place-tools.js";
export { ThreadStore, type StoredThread } from "./thread-store.js";
export { SettingsStore, type BantoSettings, type PlaceSetting } from "./settings-store.js";
export { createCoreSettingsSections } from "./core-settings.js";
// バックエンドの名乗り（ADR-0020 決定98a・98d）。回せないことを値で返す
export {
  createClaudeBackend,
  createPiBackend,
  toBackendOption,
  type HarnessBackendDescriptor,
  type BackendModelRef,
} from "./harness-backends.js";
export {
  createSettingsModule,
  settingsSection,
  SETTINGS_BASE_URL,
} from "./settings-module.js";
export {
  createPlaceRequestTools,
  createPlaceGrantAdminTools,
  PLACE_SETTINGS_SECTION,
  type PlaceRequestToolOptions,
} from "./place-grant-tools.js";
export { PlaceGrantStore, type PlaceGrantRequest, type PlaceGrantState } from "./place-grants.js";
// 取次（決定73）。判断を求めるものはモジュールを問わずここへ積む
export {
  Inbox,
  type InboxAction,
  type InboxEffect,
  type InboxItem,
  type InboxItemView,
  type InboxOpens,
  type InboxSource,
  type PostInput,
} from "./inbox.js";
export { createInboxTools, type InboxToolOptions } from "./inbox-tools.js";
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
  resumeInterruptedTurn,
  withEmptyResponseGuard,
  type GuardableSession,
} from "./turn-guard.js";
export {
  createTurnBudget,
  guardTurn,
  withTurnBudgetReset,
  DEFAULT_REPEAT_LIMIT,
  DEFAULT_CALL_WARN_LIMIT,
  DEFAULT_CALL_WARN_AGAIN_LIMIT,
  DEFAULT_CALL_LIMIT,
  type TurnBudget,
  type TurnBudgetOptions,
  type TurnBudgetVerdict,
} from "./turn-budget.js";
export { withWorkerCard, WORKER_VIEW } from "./worker-card.js";
export {
  withTierUnassignedNotice,
  type WorkerTierNoticeOptions,
} from "./worker-tier-notice.js";
