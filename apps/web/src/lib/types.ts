/**
 * host（apps/host/src/server.ts）が返す形をそのまま写した型。
 *
 * `@banto/core` から型を import しない。core の barrel は `EventLog`
 * （node:fs に依存）まで再輸出しており、ブラウザ向けバンドルに node の
 * コアモジュールが紛れ込む——このアプリの外の話とはいえ、Vite のビルドが
 * 壊れるリスクを避けるため、契約（サーバが実際に返す JSON）だけをここに写す。
 * 二重管理にならないよう、この型は server.ts の応答の形と1対1で対応させる
 * ことだけを目的にする（規則3：真実は API のレスポンスという1箇所）。
 */

export type ThreadStatus = 'working' | 'waiting-on-human' | 'blocked' | 'done';
export type DecisionSource = 'thread' | 'factory' | 'observer';

export interface ForkOrigin {
  readonly threadId: string;
  readonly baseVersion: number;
  readonly mode: 'base' | 'tip';
}

export interface ChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly threadIds: string[];
}

export interface ThreadSummary {
  readonly id: string;
  readonly channelId: string;
  readonly title: string;
  readonly status: ThreadStatus;
  readonly turnCount: number;
  readonly baseVersion: number;
  readonly forkedFrom: ForkOrigin | null;
  /** base のいまの大きさと上限（要件 R8）。**拒否される前から見せる。** */
  readonly baseCharacters: number;
  readonly baseLimit: number;
}

/** Factory の Run（要件 B）。**畳んで作られたもの**で、保存された「段」は無い。 */
export interface RunSummary {
  readonly runId: string;
  readonly threadId: string;
  readonly branch: string;
  readonly request: string;
  readonly failed: boolean;
  /** commit の sha つきのテスト結果。**sha が変われば無効になる。** */
  readonly testedCommits: { readonly commit: string; readonly passed: boolean }[];
}

export interface PendingDecision {
  readonly decisionId: string;
  readonly source: DecisionSource;
  readonly threadId: string | null;
  readonly question: string;
  /** ISO 8601。立った時刻。滞留の判定に使う（要件 A7）。 */
  readonly since: string;
}

export interface StateResponse {
  readonly channels: ChannelSummary[];
  readonly threads: ThreadSummary[];
  readonly runs: RunSummary[];
  readonly queue: PendingDecision[];
}

export interface RequestRunResponse {
  readonly runId: string;
  readonly branch: string;
}

export interface CreateThreadResponse {
  readonly threadId: string;
  readonly channelId: string;
}

/** 1ターンの usage。/api/prompt の turn.usage フレームが積む。 */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
}

interface EventEnvelope {
  readonly v: number;
  readonly id: string;
  /** ISO 8601。記録した時刻。 */
  readonly at: string;
}

export type TurnUsageRecorded = EventEnvelope & {
  readonly type: 'turn.usage';
  readonly threadId: string;
  readonly queryId: string;
  readonly turnIndex: number;
  readonly usage: TurnUsage;
};

export type QueryStep = EventEnvelope & {
  readonly type: 'query.step';
  readonly queryId: string;
  readonly threadId: string;
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly detail?: string;
};

export type ThreadStatusChanged = EventEnvelope & {
  readonly type: 'thread.status';
  readonly threadId: string;
  readonly status: ThreadStatus;
};

/** 会話の文面（要件 A8）。**これがログに在るから、開き直しても残る。** */
export type MessageRecorded = EventEnvelope & {
  readonly type: 'message.recorded';
  readonly threadId: string;
  readonly queryId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

export type CompactionReported = EventEnvelope & {
  readonly type: 'compaction.reported';
  readonly threadId: string;
  readonly queryId: string;
  readonly detail: string;
};

/**
 * ランタイム例外を握りつぶさず流すための、封筒を持たない特別なフレーム
 * （server.ts の catch 節。ログには積まれないので v/id/at が無い）。
 */
export interface StreamErrorFrame {
  readonly type: 'error';
  readonly detail: string;
}

export type StreamEvent =
  | TurnUsageRecorded
  | QueryStep
  | MessageRecorded
  | ThreadStatusChanged
  | CompactionReported
  | StreamErrorFrame;

/** 文脈サイズ。input + cacheCreation + cacheRead の和だけ。他の式にしない。 */
export function contextSize(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}
