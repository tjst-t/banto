export {
  LOG_VERSION,
  contextSize,
  isKnownEventType,
  type BantoEvent,
  type BaseAppended,
  type ChannelCreated,
  type ChannelId,
  type CompactionReported,
  type DecisionId,
  type DecisionRequested,
  type DecisionResolved,
  type DecisionSource,
  type EventId,
  type EventType,
  type NewEvent,
  type RunId,
  type RunStep,
  type ThreadCreated,
  type ThreadForked,
  type ThreadId,
  type ThreadStatus,
  type ThreadSessionRecorded,
  type ThreadStatusChanged,
  type TurnUsage,
  type TurnUsageRecorded,
} from './event.js';

export { EventLog, EventLogError, type LogFailure } from './log.js';

export {
  DEFAULT_BASE_LIMIT_CHARACTERS,
  appendBase,
  baseCharacters,
  baseLimitDecisionId,
  checkBaseAppend,
  type BaseAccepted,
  type BaseGate,
  type BaseRefused,
} from './base.js';

export {
  effectiveBase,
  fold,
  pendingQueue,
  type ChannelState,
  type ForkOrigin,
  type PendingDecision,
  type State,
  type ThreadState,
} from './fold.js';
