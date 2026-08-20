/**
 * イベントの定義。真実はイベントログに1つだけ置く（ADR-0001 決定7）。
 *
 * **導出できる値をここに書かない**（規則3）。たとえば文脈サイズは
 * input + cacheCreation + cacheRead で常に導けるので、イベントには持たせない。
 * 写しを持つと、いつか食い違う。
 */

/**
 * 版印。読めない版に当たったら止まる（ADR-0001 決定7）。
 * 形を変えたら上げる。上げたら、古い版を読む道を明示的に書く。
 */
export const LOG_VERSION = 1;

export type ChannelId = string;
export type ThreadId = string;
export type RunId = string;
export type DecisionId = string;
export type EventId = string;

/** スレッドの状態。横断集約（要件 A5・A6）のために一級のイベントにする。 */
export type ThreadStatus = 'working' | 'waiting-on-human' | 'blocked' | 'done';

/** 判断待ちの出所。3本の列は作らない——1つのキューに集める（要件 A6）。 */
export type DecisionSource = 'thread' | 'factory' | 'observer';

/**
 * 1ターンの usage。決定8 の材料。
 *
 * ランタイムが返した値をそのまま写す。ここで足し算をしない——
 * 足した値を保存すると、それが第二の真実になる。
 */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

/** すべてのイベントが持つ封筒。 */
interface Envelope {
  readonly v: number;
  readonly id: EventId;
  /** ISO 8601。記録した時刻。 */
  readonly at: string;
}

export interface ChannelCreated extends Envelope {
  readonly type: 'channel.created';
  readonly channelId: ChannelId;
  readonly name: string;
}

export interface ThreadCreated extends Envelope {
  readonly type: 'thread.created';
  readonly threadId: ThreadId;
  readonly channelId: ChannelId;
  readonly title: string;
}

/**
 * fork。既定は base から切る（要件 R1）。
 * `from.baseVersion` は、切った時点で見えていた base の版。
 * 既存のブランチは以後の追記を見ない（要件 R4）ので、これを固定する必要がある。
 */
export interface ThreadForked extends Envelope {
  readonly type: 'thread.forked';
  readonly threadId: ThreadId;
  readonly channelId: ChannelId;
  readonly title: string;
  readonly from: { readonly threadId: ThreadId; readonly baseVersion: number };
  /** 'base' が既定。'tip' は「いまの続きから」の明示オプション（要件 R1）。 */
  readonly mode: 'base' | 'tip';
}

export interface ThreadStatusChanged extends Envelope {
  readonly type: 'thread.status';
  readonly threadId: ThreadId;
  readonly status: ThreadStatus;
}

/**
 * base への追記。**追記のみ。書き換えない**（要件 R2）。
 * 追記ならキャッシュの前方一致は壊れないので、既存のブランチは生きたまま。
 */
export interface BaseAppended extends Envelope {
  readonly type: 'base.appended';
  readonly threadId: ThreadId;
  /** 追記後の版。1 から始まる連番。 */
  readonly baseVersion: number;
  readonly text: string;
}

/**
 * 1ターンの usage。決定8 の材料であり、観測はこれだけを畳む。
 * `turnIndex` はスレッド内の連番——外から系列を切り直せるようにする。
 */
export interface TurnUsageRecorded extends Envelope {
  readonly type: 'turn.usage';
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly turnIndex: number;
  readonly usage: TurnUsage;
}

/**
 * ランタイムが「圧縮した」と明示的に言ってきたときだけ記録する。
 *
 * 実測（2026-08-20）では 1,110 セッション中 2 件しか出ていない。**滅多に出ない
 * ので、これが無くても観測が成り立つように作る**——事後は usage 系列の下降から
 * 導く。両方が取れたときは突き合わせ、食い違ったら黙ってどちらかに寄せず、
 * 記録して人に上げる（規則8）。実測ではこの2件は下降と完全に一致した。
 */
export interface CompactionReported extends Envelope {
  readonly type: 'compaction.reported';
  readonly threadId: ThreadId;
  readonly runId: RunId;
  /** ランタイムが返した生の説明。解釈しない。 */
  readonly detail: string;
}

/**
 * ランタイムのセッション識別子。**不透明な文字列として扱い、解釈しない。**
 *
 * 決定6 は「ランタイム固有の**型・語彙**を外に出さない」と言っている。これは型でも
 * 語彙でもなく、**導出できない事実そのもの**——次のターンを前の続きから走らせるには、
 * これを覚えているしかない。Runner の中のメモリに置くと、落ちた時点で会話が切れる
 * （要件 B5「落ちた地点から再開できる」に反する）ので、ログに残す。
 *
 * 解釈しないことは型でも示している：中身は string で、構造を持たせていない。
 */
export interface ThreadSessionRecorded extends Envelope {
  readonly type: 'thread.session';
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly handle: string;
}

export interface RunStep extends Envelope {
  readonly type: 'run.step';
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly step: string;
  readonly state: 'started' | 'succeeded' | 'failed';
  readonly detail?: string;
}

export interface DecisionRequested extends Envelope {
  readonly type: 'decision.requested';
  readonly decisionId: DecisionId;
  readonly source: DecisionSource;
  readonly threadId: ThreadId | null;
  readonly question: string;
}

export interface DecisionResolved extends Envelope {
  readonly type: 'decision.resolved';
  readonly decisionId: DecisionId;
  readonly answer: string;
}

export type BantoEvent =
  | ChannelCreated
  | ThreadCreated
  | ThreadForked
  | ThreadStatusChanged
  | BaseAppended
  | TurnUsageRecorded
  | ThreadSessionRecorded
  | CompactionReported
  | RunStep
  | DecisionRequested
  | DecisionResolved;

export type EventType = BantoEvent['type'];

/** 記録するときに与えない項目——封筒はログ側が埋める。 */
export type NewEvent = {
  [K in BantoEvent as K['type']]: Omit<K, 'v' | 'id' | 'at'>;
}[EventType];

const KNOWN_TYPES: ReadonlySet<string> = new Set<EventType>([
  'channel.created',
  'thread.created',
  'thread.forked',
  'thread.status',
  'base.appended',
  'turn.usage',
  'thread.session',
  'compaction.reported',
  'run.step',
  'decision.requested',
  'decision.resolved',
]);

export function isKnownEventType(type: string): type is EventType {
  return KNOWN_TYPES.has(type);
}

/**
 * 1ターンの文脈サイズ。**保存せず、必要なときに導く**（規則3）。
 *
 * 入力側の3つの和。output は「そのターンでモデルに入っていた量」ではないので
 * 足さない。ここを間違えると、観測そのものが嘘をつく。
 */
export function contextSize(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}
