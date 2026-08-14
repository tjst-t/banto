/**
 * Worker Pool（職人ランタイム）— ADR-0010 決定23・27c。
 *
 * **Kobo から独立したモジュール。** Kobo のサブシステムではなく、Kobo が無くても単体で
 * 成立する。Banto も Kobo も、それぞれこのモジュールのクライアントになる。
 *
 * Banto から見た位置づけは「必須の組み込みモジュール」（決定27c）——常に同梱されるが、
 * 機構としては他のモジュールと対等。無いと番頭は職人へ委譲できず D10 が満たせない。
 */

export {
  PiRpcDriver,
  type PiRpcDriverOptions,
} from "./pi-rpc-driver.js";
export {
  ClaudeAgentDriver,
  CLAUDE_AGENT_DRIVER_ID,
  type ClaudeAgentDriverOptions,
} from "./claude-agent-driver.js";
export {
  toClaudeToolNames,
  resolveClaudeModel,
  CLAUDE_TIER_MODELS,
  CLAUDE_KNOWN_MODELS,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_REPORT_TOOL,
  CLAUDE_ASK_TOOL,
  CLAUDE_REPORT_TOOL_NAMES,
  CLAUDE_KOBO_TOOL_NAMES,
  CLAUDE_WEB_TOOL_NAMES,
  type ClaudeModelTier,
} from "./claude-agent/naming.js";
export { SessionTranscript, readSessionIdFromLines } from "./claude-agent/session-log.js";
export { endedWithoutReporting, CLAUDE_REPORT_PROMPT } from "./claude-agent/report.js";
export {
  SpawnLedger,
  isProcessAlive,
  killOrphanProcess,
  type LedgerEntry,
} from "./spawn-ledger.js";
export {
  WorkerPool,
  WORKER_SYSTEM_PROMPT,
  type WorkerPoolOptions,
  type WorkerInfo,
  type WorkerState,
  type CloseReason,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PAGE_SIZE,
  TIER_UNASSIGNED_CODE,
  tierFromUnassignedError,
  type WorkerExitDetail,
  type DelegateInput,
} from "./pool.js";
export {
  WorkerEventLog,
  type WorkerEvent,
  type WorkerEventType,
  type WorkerEventKind,
  type WorkerEventFilter,
  type WorkerEventHandler,
} from "./event-log.js";
export {
  workerReportExtensionPath,
  webToolsExtensionPath,
  toolOffloadExtensionPath,
  workKeepExtensionPath,
} from "./extension.js";
export { installToolOffload } from "./pi-extension/tool-offload.js";
export { installWorkKeep, PI_KEEP_RUNTIME } from "./pi-extension/work-keep.js";
export {
  WorktreeKeeper,
  createWorktreeKeeper,
  createGitRunner,
  keepBranchName,
  keepStamp,
  sanitizeRefPart,
  renderKeepMessage,
  isKeepEnabled,
  resolveKeepIntervalMs,
  DEFAULT_KEEP_INTERVAL_MS,
  KEEP_ENABLED_ENV,
  KEEP_INTERVAL_ENV,
  KEEP_BRANCH_PREFIX,
  KEEP_SUBJECT_PREFIX,
  KEEPER_NAME,
  KEEPER_EMAIL,
  type KeepIdentity,
  type KeepOutcome,
  type KeepReason,
  type GitRunner,
  type WorktreeKeeperOptions,
  type CreateWorktreeKeeperParams,
  parseKeepBranch,
  listKeepBranches,
  resolveGitCommonDir,
  pruneKeepBranches,
  resolveKeepMaxAgeMs,
  DEFAULT_KEEP_MAX_AGE_DAYS,
  KEEP_MAX_AGE_ENV,
  KEEP_PRUNE_LOG,
  type KeepBranchName,
  type KeepBranchInfo,
  type KeepPruneResult,
  type KeepPruneSkip,
  type PruneKeepBranchesOptions,
} from "./work-keep.js";
export {
  createClaudeWorkKeep,
  CLAUDE_KEEP_RUNTIME,
  type ClaudeWorkKeep,
} from "./claude-agent/work-keep.js";
export {
  ToolResultOffloader,
  DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS,
  MIN_OFFLOAD_LEAF_CHARS,
  OFFLOAD_THRESHOLD_ENV,
  OFFLOAD_DIR_ENV,
  OFFLOAD_ENABLED_ENV,
  READBACK_MAX_CHARS,
  WORKER_OFFLOAD_PROMPT,
  PI_OFFLOAD_DIALECT,
  CLAUDE_OFFLOAD_DIALECT,
  renderWorkerOffloadPrompt,
  resolveThresholdChars,
  resolveOffloadDir,
  isOffloadEnabled,
  isExemptTool,
  outlineOf,
  renderOffloadStub,
  type OffloadDialect,
  type ToolResultLike,
  type ToolOutputLike,
  type OffloadPatch,
  type OffloadOutputPatch,
} from "./tool-offload.js";
export {
  createClaudeToolOffload,
  CLAUDE_WORKER_OFFLOAD_PROMPT,
  type ClaudeToolOffload,
} from "./claude-agent/tool-offload.js";
export {
  buildHostOptions,
  buildAppendedPrompt,
  type BuildHostOptionsParams,
} from "./claude-agent/options.js";
export {
  WEB_TOOL_NAMES,
  isPublicHttpUrl,
  htmlToText,
  parseDuckDuckGoLite,
  parseWikipedia,
  keylessSearch,
  renderSearchHits,
  fetchPublicUrl,
  type SearchHit,
  type UrlVerdict,
  type FetchOutcome,
} from "./pi-extension/web-tools.js";
export { createWorkerTools, createWorkerReportTools, createWorkerModuleTools } from "./worker-tools.js";
export { createWorkerPoolSettings } from "./settings.js";
export type { WorkerSettingsValues, WorkerSettingsUpdate } from "./settings.js";
export {
  BackendRegistry,
  WORKER_TIERS,
  type BackendView,
  type BackendState,
  type RuntimeRegistration,
  type WorkerTier,
} from "./backends.js";
export { claudeAgentAvailability } from "./claude-agent/availability.js";
export { resumeWorkers } from "./resume.js";
export { createHandleGrip } from "./pi-rpc-driver.js";
export type { HandleGrip } from "./pi-rpc-driver.js";
export type { ResumeOptions, ResumeOutcome } from "./resume.js";
export {
  createWorkerPoolModule,
  workerPoolSkillsDir,
  WORKER_POOL_BASE_URL,
} from "./module.js";
export {
  WorkerPoolService,
  WORKER_POOL_DEFAULT_PORT,
  type WorkerPoolServiceOptions,
} from "./service.js";
export { createKoboChannel, type KoboChannel } from "./claude-agent/kobo.js";
