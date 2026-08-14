/**
 * Orchestration event types for the banto event sourcing system.
 * All events are append-only and cover: state transitions, spawn/exit,
 * gate decisions, approvals/rejections, PO operations, card generation.
 *
 * Session transcripts are NOT stored here — only path references (per spec §2.1).
 */

/** Task lifecycle states from daemon-core spec §1 */
export type TaskStatus =
  | "draft"
  | "queued"
  | "ready"
  | "planning"
  | "implementing"
  | "auditing"
  | "review-ready"
  | "in-review"
  | "approved"
  | "merging"
  | "merged"
  | "evaluating"
  | "closed"
  | "paused"
  | "failed"
  | "superseded";

/** Base fields present on every event (monotonically increasing eventId + projectTag) */
export interface EventBase {
  /** Monotonically increasing integer ID scoped to this log */
  eventId: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Project tag for multi-project support (spec-multi-project §1) */
  projectTag: string;
  /**
   * 起点参照 (D8 / spec-ui §3): ID of the PO input or event that triggered this
   * event, e.g. "event:123" or "po:<eventId of po_operation>". Optional —
   * writers populate it when the trigger is known; existing events are not
   * backfilled. Added by v1a data-shape audit (docs/research/v1a-data-shape-audit.md).
   */
  originRef?: string;
}

/** Task created by PO or daemon */
export interface TaskCreatedEvent extends EventBase {
  type: "task_created";
  taskId: string;
  payload: {
    title: string;
    /** Optional transcript path reference (not content) */
    transcriptPath?: string;
    [key: string]: unknown;
  };
}

/** Task state machine transition */
export interface StateTransitionedEvent extends EventBase {
  type: "state_transitioned";
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason?: string;
}

/** Agent session spawned for a task */
export interface AgentSpawnedEvent extends EventBase {
  type: "agent_spawned";
  taskId: string;
  pid: number;
  sessionPath: string;
  worktree: string;
  modelTier: "reasoning" | "standard" | "fast";
  /**
   * 職人のセッション（ADR-0013 決定60）。Kobo は自分の spawn 台帳を持たなくなり、
   * 「どの職人を起こしたか」はこの帳簿に残る——ここから職人ビューアへ辿れる（決定18）。
   *
   * 任意なのは、この項目より前に書かれた帳簿を読めなくしないため。
   */
  sessionId?: string;
}

/** Agent session exited */
export interface AgentExitedEvent extends EventBase {
  type: "agent_exited";
  taskId: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
  /** 終わった職人のセッション（`agent_spawned.sessionId` と対になる）。 */
  sessionId?: string;
}

/** Dependency gate evaluated (queued → ready gate) */
export interface GateEvaluatedEvent extends EventBase {
  type: "gate_evaluated";
  taskId: string;
  passed: boolean;
  blockedBy: string[];
}

/**
 * PO approved a task for merge.
 * D3: This event is a PO judgment record ONLY — it does NOT change task status.
 * Status canonical source is state_transitioned exclusively.
 */
export interface TaskApprovedEvent extends EventBase {
  type: "task_approved";
  taskId: string;
  /** 誰が通したか。`banto`（一次受け）／`po`（決定57 の3段）。 */
  approvedBy: string;
  /** 何を見て良しとしたか（ADR-0013 決定57：判断の理由を帳簿に残す）。 */
  note?: string;
}

/**
 * PO rejected a task.
 * D3: This event is a PO judgment record ONLY — it does NOT change task status.
 * Status canonical source is state_transitioned exclusively.
 */
export interface TaskRejectedEvent extends EventBase {
  type: "task_rejected";
  taskId: string;
  rejectedBy: string;
  reason: string;
}

/** PO operation (enqueue, prioritize, pause, etc.) */
export interface PoOperationEvent extends EventBase {
  type: "po_operation";
  operation: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}

/** Evaluation/retrospective card generated */
export interface CardGeneratedEvent extends EventBase {
  type: "card_generated";
  cardId: string;
  taskId?: string;
  cardType: "evaluation" | "cadence" | "meta_cadence";
  /** Path reference to card file, not content */
  cardPath: string;
}

/** Environment provisioned for a task */
export interface EnvProvisionedEvent extends EventBase {
  type: "env_provisioned";
  taskId: string;
  envId: string;
  /** Profile name used to provision (e.g. "dev", "test") — spec-environment §2 */
  profileName: string;
  /** Driver name or path used (e.g. "process") */
  driver: string;
  /**
   * Result of the healthcheck after provision.
   * D3: path reference only — never log bodies (spec-environment §6).
   */
  healthcheck: { ok: boolean; detail?: string };
  /**
   * 外から触れる URL（ADR-0013 決定59）。レビューのために立てた環境だけが持つ。
   *
   * **判断待ちの札に添える**ためにここへ残す——「見て決めてください」ではなく
   * 「触って決めてください」にするのが決定59 の要点。
   */
  url?: string;
}

/** Environment torn down */
export interface EnvTornDownEvent extends EventBase {
  type: "env_torn_down";
  taskId: string;
  envId: string;
  /**
   * Reason for teardown. Optional — omitted for user-initiated teardown.
   * "ttl_expired": TTL enforcement tick forced teardown (Story-5).
   * "vanished": reconcile detected that the resource is gone from the driver list (Story-5).
   */
  reason?: "ttl_expired" | "vanished";
}

/** Merge completed */
export interface TaskMergedEvent extends EventBase {
  type: "task_merged";
  taskId: string;
  commitSha: string;
}

/**
 * Invalid transition attempt recorded for auditability (I2: errors not swallowed).
 * D3: This event records the rejection fact; it does NOT change task status.
 */
export interface TransitionRejectedEvent extends EventBase {
  type: "transition_rejected";
  taskId: string;
  attempted_from: TaskStatus;
  attempted_to: TaskStatus;
  reason: string;
}

/**
 * Task paused from an active execution state.
 * suspended_from records the pre-pause status so resume() can restore it (D3).
 */
export interface TaskPausedEvent extends EventBase {
  type: "task_paused";
  taskId: string;
  suspended_from: TaskStatus;
}

/**
 * Task resumed from paused state, restoring to the suspended_from status.
 */
export interface TaskResumedEvent extends EventBase {
  type: "task_resumed";
  taskId: string;
  restored_to: TaskStatus;
}

/**
 * Task entered unrecoverable failure state (I2: stop, don't swallow).
 */
export interface TaskFailedEvent extends EventBase {
  type: "task_failed";
  taskId: string;
  reason: string;
}

/**
 * Task superseded (replaced) by another task via escalation.
 */
export interface TaskSupersededEvent extends EventBase {
  type: "task_superseded";
  taskId: string;
  supersededBy: string;
}

/**
 * 契約を改訂した（task-0082・決定64 改訂）。
 *
 * **凍結をやめた代わりに、改訂を必ずここに残す。** 「何に対して監査したのか」は、
 * 凍結ではなく**版で**答える——`kobo.task` の経緯にこのイベントが並ぶので、
 * 「版 V の契約に対して時刻 T に監査した」が読める。
 *
 * `auditInvalidated` は、この改訂で監査がやり直しになったか。`verify` だけの訂正
 * （＝「どう確かめるか」だけを直した）なら基準は変わっていないので `false`。
 */
export interface TaskContractAmendedEvent extends EventBase {
  type: "task_contract_amended";
  taskId: string;
  /** 誰が改訂したか。緩める方向は PO だけ（→ daemon.amendTask） */
  amendedBy: "banto" | "po";
  /** なぜ改訂したか。帳簿に残る */
  reason: string;
  /** 何が変わったか（人が読む要約。1変更1行） */
  changes: string[];
  /** この改訂で監査が無効になったか */
  auditInvalidated: boolean;
  /**
   * **改訂後の契約そのもの**（`acceptance` / `scope` / `title` / `body` …）。
   *
   * D3: 状態はイベントログから作り直せなければならない。要約（`changes`）だけ載せると、
   * リプレイしたときに契約が古いまま復元される——**帳簿と実物が食い違う**。
   */
  contract: Record<string, unknown>;
}

/**
 * Task definition file was rejected during watcher ingest (I2: rejection recorded, not swallowed).
 * The file is NOT added to the task registry. reason describes the validation failure.
 */
export interface TaskIngestRejectedEvent extends EventBase {
  type: "task_ingest_rejected";
  /** Absolute path of the rejected task definition file */
  filePath: string;
  /** Human-readable reason for rejection (e.g. "missing required field: scope.paths") */
  reason: string;
}

/**
 * A scheduler tick job failed.
 * I2: errors are NOT swallowed — recorded here so the audit trail is complete.
 * The daemon continues running after a tick job failure (scheduler catches and records).
 * projectTag is set to the sentinel value "daemon" (daemon-internal, not a user project).
 */
export interface TickJobFailedEvent extends EventBase {
  type: "tick_job_failed";
  jobName: string;
  error: string;
}

/**
 * Merge-gate verdict for a task in the 'merging' state.
 *
 * Records whether the pre-merge checks (scope diff + verify commands) passed.
 * On failure, `reasons` lists the violation file paths or verify command failures.
 * Log paths for verify-command output are carried as path references only (spec §2.1).
 *
 * S75f66b-4: appended here to keep the union complete; wiring into the merge
 * processor happens in S75f66b-5. (D3: gate judgments recorded as events only.)
 */
export interface MergeGateEvaluatedEvent extends EventBase {
  type: "merge_gate_evaluated";
  taskId: string;
  passed: boolean;
  /** Human-readable reasons for gate failure (violation files or failed command ids). */
  reasons: string[];
  /**
   * Path references to execution log directories for verify commands.
   * Contains log directory paths only — never log content (spec §2.1).
   * Empty when no verify commands were run or when scope check failed first.
   */
  logPaths: string[];
  /**
   * **どの環境で検査したか**（realign 第2便・段1）。検証環境プロファイルの中身から
   * 作った短い指紋（`envProfileDigest`）。
   *
   * これが無いと「通った」が**いつまで有効か**を計算できない——検証環境の定義
   * （土台のイメージ・`setup`・キャッシュの鍵）が変われば、同じ差分でも結果は変わりうる。
   * 既定を反転して人の承認なしに着地させる（第3便）前に、ここが刻まれている必要がある。
   *
   * 任意なのは、この項目より前に書かれた帳簿を読めなくしないため。検証コマンドを
   * 1本も持たないタスクでは環境を立てないので、そのときも付かない。
   */
  environmentDigest?: string;
  /**
   * **どのコミットの上で検査したか**（realign 第2便・段1）。`base` を解決した SHA。
   *
   * `passed` は「この土台の上でなら通る」という主張でしかない。メインラインが進めば
   * 主張の前提が変わる——それを後から言えるようにするための項目。
   *
   * 任意なのは、この項目より前に書かれた帳簿を読めなくしないため。`git rev-parse` に
   * 失敗したときも付かない（I2: 嘘の SHA を書くより、無いと言う）。
   */
  baseCommit?: string;
}

/**
 * Audit session started for a task in 'auditing' state.
 *
 * S75f66b-3: emitted when daemon auto-spawns an audit session.
 * sessionPath is a path reference only — no content stored (spec §2.1).
 * role: "audit" distinguishes this from executor agent_spawned events.
 */
export interface AuditStartedEvent extends EventBase {
  type: "audit_started";
  taskId: string;
  /** Session JSONL path reference (not transcript content — spec §2.1). */
  sessionPath: string;
  /** Absolute path to the task's worktree (read context for the audit agent). */
  worktree: string;
}

/**
 * Audit session reported a verdict via the audit_report tool.
 *
 * S75f66b-3: emitted by daemon when it receives the audit verdict.
 * D3: status change is carried exclusively by state_transitioned events;
 * this event records only the audit metadata (verdict + findings).
 * findings: path references or short descriptions — no large content inline (spec §2.1).
 */
export interface AuditVerdictEvent extends EventBase {
  type: "audit_verdict";
  taskId: string;
  verdict: "pass" | "fail";
  /**
   * Human-readable findings from the audit session (fail case).
   * Empty array on pass. Short strings only — full transcript is in sessionPath.
   */
  findings: string[];
  /**
   * **どの契約に対して監査したか**（realign 第2便・段1）。
   *
   * 契約を定めたイベントの `eventId`——`task_created`、または直近の
   * `task_contract_amended`。**新しく版番号を持たない**：契約の版は既に帳簿が
   * 表しており（決定64 改訂）、別に数えると帳簿と食い違う。導出は
   * `contractVersionOf`（`dwell.ts` と同じく `banto-core` の純関数）。
   *
   * これがあると「この判定はまだ有効か」が**計算できる**——いまの契約の版と
   * 突き合わせるだけでよい。無かったので、代わりに「基準が動いたら状態を
   * implementing へ巻き戻す」という乱暴な形で表していた（`Daemon.amendTask`）。
   *
   * 任意なのは、この項目より前に書かれた帳簿を読めなくしないため。
   */
  contractVersion?: number;
  /**
   * **どの基準で監査したか**（realign 第2便・段1）。監査チェックリストの中身から
   * 作った短い指紋（`promptAssetDigest("audit-checklist")`）。
   *
   * 中身のハッシュにしているのは、チェックリストが版番号を持たないファイルだから
   * （`skills/audit-checklist.md`）。番号を別に振ると、書き換えても番号を上げ忘れる。
   *
   * **刻む前に、その中身が監査人に届いていることを確かめてある**——届いていない
   * 基準の指紋を刻むのは、証拠ではなく嘘になる（`buildAuditInstruction` を参照）。
   *
   * 任意なのは、この項目より前に書かれた帳簿を読めなくしないため。
   */
  checklistVersion?: string;
}

/**
 * **止まっている**（realign 第2便・rethink C-3 第1手）。
 *
 * 状態は「いつからその状態なのか」を持っていない。だから何日詰まっていても
 * 誰も気づけなかった（実測 19.2h / 28.6h / 16.8h）。滞在時間は帳簿から導出できる
 * （`dwellMs`）ので**保存はしない**——このイベントが持つのは「閾値を超えた」という
 * 判定の事実と、そのときの実測値（あとから閾値を変えても、当時の判断が読める）。
 *
 * D3: 状態は動かさない。これは知らせるための記録であって、状態遷移ではない。
 * **同じ状態のあいだ二度は鳴らない**（`stalledAlreadyRecorded`）——鳴り続ける知らせは
 * 読まれなくなり、知らせないのと同じになる。
 */
export interface TaskStalledEvent extends EventBase {
  type: "task_stalled";
  taskId: string;
  /** 止まっている状態（この状態のあいだ、このイベントは1回だけ積まれる）。 */
  status: TaskStatus;
  /** その状態に入ってからの経過（ms）。判定した時点の実測値。 */
  dwellMs: number;
  /** 超えた閾値（ms）。層B設定 `limits.dwell_warn_minutes` から。 */
  thresholdMs: number;
  /**
   * **なぜ止まっているか**（`gate_evaluated.blockedBy` の最新）。
   * task-0100 の 19.2 時間は「`blockedBy` が 18 時間変わらなかった」というだけの事実で、
   * それを言える機構が無かった。空配列は「依存では止まっていない」。
   */
  blockedBy: string[];
  /**
   * 最後に**外から見える変化**があった時刻（`lastObservableChangeAt`）。
   * 状態に入った時刻より新しいことがある（職人は動いているが状態が変わらない場合）。
   */
  lastChangeAt: string;
}

/**
 * **工場の外で決着した**（realign 第2便・imp-0019 の4番）。
 *
 * `kobo.abandon` は failed のタスクにしか効かず、queued / paused / review-ready の
 * まま「中身が別のところで入った」ものを帳簿の上で畳む手段が無かった。実際に
 * 番頭がここで詰まり、判定を帳簿へ書き戻せずに文書で代用した。
 *
 * **failed とは区別する。** 失敗ではない——工場を通らずに片づいただけである。
 * D3: 状態を動かすのは `state_transitioned`（→ `closed`）。これは理由の記録。
 * **記録は消えない**：経緯にはそれまでの遷移がすべて残る。
 */
export interface TaskSettledOutsideEvent extends EventBase {
  type: "task_settled_outside";
  taskId: string;
  /** 誰が畳んだか（`banto` / `po`）。 */
  settledBy: string;
  /**
   * どう決着したか。**理由の分類**であって失敗ではない。
   * - `landed_elsewhere`: 中身が別の経路で main に入った
   * - `no_longer_needed`: もう要らなくなった（前提が変わった・重複していた）
   * - `handled_directly`: 番頭が職人へ直接投げて片づけた（工場を通していない）
   */
  outcome: "landed_elsewhere" | "no_longer_needed" | "handled_directly";
  /** **なぜそう言えるのか**。マージコミット・置き換わった先など、根拠が残る。 */
  reason: string;
  /** 畳んだ時点の状態（どこで止まっていたのかが読める）。 */
  settled_from: TaskStatus;
}

/**
 * Audit session spawn was suppressed by the disableAuditSpawn config flag.
 *
 * F2 (governance): emitted so the bypass is visible in the event log — "黙って迂回できる経路を
 * 作らない" (priority rule 2). This event is recorded instead of spawning the audit session,
 * making the suppression auditable without spawning a real session (test-only flag).
 */
export interface AuditSpawnDisabledEvent extends EventBase {
  type: "audit_spawn_disabled";
  taskId: string;
}

/**
 * Daemon started with one or more spawn-suppressing config flags set.
 *
 * F2 (governance): emitted once at daemon start when disableAutoSpawn (or similar
 * spawn-suppressing flags) are set, so the bypass is visible in the event log —
 * "黙って迂回できる経路を作らない" (priority rule 2). Without this event, a production
 * daemon started with disableAutoSpawn:true would silently not auto-spawn, invisible
 * to the PO via GET /events.
 *
 * Pattern mirrors audit_spawn_disabled: the suppression fact is the observable artifact.
 */
export interface DaemonConfigEvent extends EventBase {
  type: "daemon_config";
  /** True when the auto-spawn scheduler job is suppressed by config */
  autoSpawnDisabled: boolean;
  /** True when the audit-spawn side-effect is suppressed by config */
  auditSpawnDisabled: boolean;
}

/**
 * An environment profile definition in meta/environments.yaml was rejected
 * because it failed schema validation (driver missing / ttl format / quota type).
 *
 * S9d7fdb-1 (AC-S9d7fdb-1-2): emitted at most once per (project, profile name, mtime)
 * to avoid event flooding (watcher-reject no-flood pattern).
 * D3: file is intent; this event records the rejection fact only.
 * I2: errors not swallowed — recorded here so the audit trail is complete.
 */
export interface EnvProfileRejectedEvent extends EventBase {
  type: "env_profile_rejected";
  /** Profile name that failed validation */
  profileName: string;
  /** Human-readable reason naming the offending field */
  reason: string;
}

/**
 * A provision attempt for a task's environment failed.
 *
 * S9d7fdb-1 (AC-S9d7fdb-1-3): emitted when a task references an unknown profile name
 * (or when provision fails for any other reason at the profile-resolution layer).
 * D3: no env_provisioned event is emitted on failure.
 * I2: failure is recorded, not swallowed.
 */
export interface EnvProvisionFailedEvent extends EventBase {
  type: "env_provision_failed";
  taskId: string;
  /** The profile name that was requested but not found (or failed) */
  profileName: string;
  /** Human-readable failure reason */
  reason: string;
}

/**
 * A tmux pane was successfully added to the task's tmux window for environment output.
 *
 * S9d7fdb-7 (AC-S9d7fdb-7-2): emitted after the env pane is attached in the task's
 * existing tmux window so the PO can observe the provisioned environment on SSH+attach.
 * D3: pane address is recorded here; no duplicate pane tracking state elsewhere.
 * I2: not emitted on failure — env_review_tmux_pane_skipped covers failure/no-tmux paths.
 */
export interface EnvReviewTmuxPaneAttachedEvent extends EventBase {
  type: "env_review_tmux_pane_attached";
  taskId: string;
  /** Provisioned environment ID */
  envId: string;
  /** Tmux window address (e.g. "banto:T-001") from the spawn ledger */
  windowAddr: string;
  /** Pane index that was added (2 = the env pane alongside the agent session pane) */
  paneIndex: number;
}

/**
 * Tmux pane attachment was skipped because no tmux session is configured,
 * no spawn-ledger entry has a tmux window for this task, or tmux returned an error.
 *
 * S9d7fdb-7 (AC-S9d7fdb-7-2): I2 — skip must not be silent. This event makes the
 * skip observable via GET /events so the PO knows no pane is waiting.
 * "tmux-less config" (daemon.tmuxSession unset or "") → reason "no_tmux_session".
 * "No window recorded in spawn ledger for this task" → reason "no_tmux_window".
 * "tmux split-window command failed" → reason "tmux_error".
 */
export interface EnvReviewTmuxPaneSkippedEvent extends EventBase {
  type: "env_review_tmux_pane_skipped";
  taskId: string;
  /** Provisioned environment ID (present when provision succeeded before the pane skip) */
  envId: string;
  /** Reason code for the skip */
  reason: "no_tmux_session" | "no_tmux_window" | "tmux_error";
  /** Optional detail message (e.g. tmux stderr) */
  detail?: string;
}

/** Union of all orchestration event types */
export type OrchestrationEvent =
  | TaskCreatedEvent
  | StateTransitionedEvent
  | AgentSpawnedEvent
  | AgentExitedEvent
  | GateEvaluatedEvent
  | TaskApprovedEvent
  | TaskRejectedEvent
  | PoOperationEvent
  | CardGeneratedEvent
  | EnvProvisionedEvent
  | EnvTornDownEvent
  | TaskMergedEvent
  | TransitionRejectedEvent
  | TaskPausedEvent
  | TaskResumedEvent
  | TaskFailedEvent
  | TaskSupersededEvent
  | TaskStalledEvent
  | TaskSettledOutsideEvent
  | TaskContractAmendedEvent
  | TaskIngestRejectedEvent
  | TickJobFailedEvent
  | MergeGateEvaluatedEvent
  | AuditStartedEvent
  | AuditVerdictEvent
  | AuditSpawnDisabledEvent
  | DaemonConfigEvent
  | EnvProfileRejectedEvent
  | EnvProvisionFailedEvent
  | EnvReviewTmuxPaneAttachedEvent
  | EnvReviewTmuxPaneSkippedEvent;
