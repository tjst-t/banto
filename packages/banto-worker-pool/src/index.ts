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
export { workerReportExtensionPath, webToolsExtensionPath } from "./extension.js";
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
