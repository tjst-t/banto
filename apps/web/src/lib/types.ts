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

/** スレッド作成の場所の候補（決定32）。役割 `workspace-suggestions` を持つモジュールから集める。 */
export interface WorkspaceCandidate {
  /** `workspaceRoot` と同じ形（広いrootからの相対パス、決定29）。 */
  readonly path: string;
  readonly label: string;
  readonly lastModified: string;
  /** 既にどれかのスレッドがこの場所を使っているか（host が突き合わせる）。 */
  readonly inUse: boolean;
}

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
  /** 畳んで閉じた先。畳んでいなければ `null`（`packages/core` の `ThreadState` と同じ形）。 */
  readonly mergedInto: string | null;
  /** base のいまの大きさと上限（要件 R8）。**拒否される前から見せる。** */
  readonly baseCharacters: number;
  readonly baseLimit: number;
  /**
   * このスレッドが向いているリポジトリ（決定29）。フォークは根から継承する
   * （`effectiveWorkspaceRoot`）。宣言していなければ `null`。
   */
  readonly workspaceRoot: string | null;
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

export interface DecisionOption {
  /** 答えを読む側が見る鍵。**表示名で判定しない。** */
  readonly id: string;
  readonly label: string;
  /** 選んだら何が起きるか。**帰結が分からない選択肢は、選べない選択肢である。** */
  readonly detail?: string;
}

export interface PendingDecision {
  readonly decisionId: string;
  readonly source: DecisionSource;
  readonly threadId: string | null;
  readonly question: string;
  /** 出された選択肢。**無いこともあるし、在っても自由文で答えてよい。** */
  readonly options?: readonly DecisionOption[];
  /** ISO 8601。立った時刻。滞留の判定に使う（要件 A7）。 */
  readonly since: string;
}

/** base の1行（要件 R2・R6、PO裁定 2026-08-22：無効化）。 */
export interface BaseEntry {
  readonly baseVersion: number;
  readonly text: string;
  /** 削除ではなく無効化——`effectiveBase`（会話に効く分）から外れているだけ。 */
  readonly invalidated: boolean;
  /** このスレッド自身が追記したか。false なら fork 元からの継承（要件 R4）か共有base（決定30）。
   * 無効化・有効化できるのは own のものだけ。 */
  readonly own: boolean;
  /** 実際にこの行を追記したスレッド。own なら自分自身と同じ（決定30）。
   * 共有baseスレッドのidと比べて、fork継承と共有baseを見分ける。 */
  readonly ownerThreadId: string;
}

/** いまそのスレッドで決まっていること（要件 R2・R6）。**継承は host が解く。** */
export interface BaseResponse {
  readonly threadId: string;
  readonly baseVersion: number;
  readonly entries: readonly BaseEntry[];
  /** 無効化した行を除いた文字数。 */
  readonly characters: number;
  /** R8 のゲート。**常に見せる**——拒否されて初めて存在を知る、を避ける。 */
  readonly limit: number;
}

export interface StateResponse {
  readonly channels: ChannelSummary[];
  /** 共有baseスレッドの固定id（決定30）。会話をしないので「開いているもの」には出さない。 */
  readonly sharedBaseThreadId: string;
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
  readonly workspaceRoot: string | null;
}

export interface MergeThreadResponse {
  readonly threadId: string;
  readonly into: string;
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
 * `/api/events` はそのスレッドの**全イベント**を返す（要件 A8）。会話の見た目に
 * 効かないものも混ざるので、画面が知っている型として並べておく——
 * **知らない型に落ちると「未対応」と表示される**ので、意味のあるものはここに書く。
 */
export type ThreadSessionRecorded = EventEnvelope & {
  readonly type: 'thread.session';
  readonly threadId: string;
  readonly queryId: string;
  readonly sessionHandle: string;
};

export type ThreadCreated = EventEnvelope & {
  readonly type: 'thread.created';
  readonly threadId: string;
  readonly channelId: string;
  readonly title: string;
};

/** 分岐（要件 A3・R4）。**決まったことは、切った時点の版まで引き継がれる。** */
export type ThreadForked = EventEnvelope & {
  readonly type: 'thread.forked';
  readonly threadId: string;
  readonly channelId: string;
  readonly title: string;
  readonly from: { readonly threadId: string; readonly baseVersion: number };
  readonly mode: 'base' | 'tip';
};

export type BaseAppended = EventEnvelope & {
  readonly type: 'base.appended';
  readonly threadId: string;
  readonly baseVersion: number;
  readonly text: string;
};

/** 訂正は無効化で行う（PO裁定 2026-08-22）。削除ではない——`effectiveBase` が
 * 読み飛ばすようになるだけで、元の `base.appended` はログに残る。 */
export type BaseInvalidated = EventEnvelope & {
  readonly type: 'base.invalidated';
  readonly threadId: string;
  readonly baseVersion: number;
};

/** `base.invalidated` の取り消し。 */
export type BaseReactivated = EventEnvelope & {
  readonly type: 'base.reactivated';
  readonly threadId: string;
  readonly baseVersion: number;
};

export type RunRequested = EventEnvelope & {
  readonly type: 'run.requested';
  readonly runId: string;
  readonly threadId: string;
  readonly branch: string;
  readonly request: string;
};

export type RunTested = EventEnvelope & {
  readonly type: 'run.tested';
  readonly runId: string;
  readonly commit: string;
  readonly passed: boolean;
  readonly detail: string;
};

export type RunFailed = EventEnvelope & {
  readonly type: 'run.failed';
  readonly runId: string;
  readonly stage: string;
  readonly detail: string;
};

/** 判断が立った（要件 A6）。**会話の中にも見える**——列にしか出ないと文脈が切れる。 */
export type DecisionRequested = EventEnvelope & {
  readonly type: 'decision.requested';
  readonly decisionId: string;
  readonly source: DecisionSource;
  readonly threadId: string | null;
  readonly question: string;
  readonly options?: readonly DecisionOption[];
};

/** 答えが出た。**答えの本文は `message.recorded` として会話にも返っている。** */
export type DecisionResolved = EventEnvelope & {
  readonly type: 'decision.resolved';
  readonly decisionId: string;
  readonly optionId: string | null;
  readonly answer: string;
};

/**
 * **AI が「これを見て」と指したもの**（要件 C14・決定19）。
 *
 * 中身はここに無い。開くときに `/api/resource?uri=` で持ち主に読みに行く
 * ——指した時点の写しを持つと、現物と食い違う（規則3）。
 */
export type ReferenceRecorded = EventEnvelope & {
  readonly type: 'reference.recorded';
  readonly threadId: string;
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly note: string | null;
};

/**
 * どの URI をどの面で開くか（要件 C1・C14、決定20）。**台帳から導いたもの。**
 *
 * `kind` は `isolation` と同じ2択（決定20）。画面は両者を**区別して描く**——
 * `in-page` は束ねの中の React、`sandboxed` は iframe の中。
 */
export interface ViewAssignment {
  readonly moduleId: string;
  readonly kind: 'in-page' | 'sandboxed' | null;
  readonly entry: string | null;
  readonly uriPrefix: string;
  readonly title: string;
}

/**
 * モジュール台帳の1件（要件 C1・C8c・C12）。
 *
 * **境界も、外したときの影響も、隠さない。** 前者は C8c が常時表示を求めていて、
 * 後者は C12 が「押す前に分かる」ことを求めている。
 */
export interface ModuleSummary {
  readonly id: string;
  readonly description: string;
  readonly isolation: 'in-process' | 'subprocess';
  readonly handlesSecrets: boolean;
  readonly provides: readonly string[];
  readonly gui: { readonly kind: 'in-page' | 'sandboxed'; readonly views: number } | null;
  /** モジュール自身の設定の区画（要件 C4）。無ければ null。 */
  readonly settingsUri: string | null;
  readonly impact: {
    readonly summary: string;
    readonly breakages: readonly { readonly moduleId: string; readonly severity: string }[];
    readonly orphanedCapabilities: readonly string[];
  };
}

/** `/api/resource` の返り。**読むたびに現物**。 */
export interface ResourceResponse {
  readonly uri: string;
  readonly text: string;
  readonly mimeType: string | null;
}

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
  | ThreadSessionRecorded
  | ThreadCreated
  | ThreadForked
  | BaseAppended
  | BaseInvalidated
  | BaseReactivated
  | RunRequested
  | RunTested
  | RunFailed
  | DecisionRequested
  | DecisionResolved
  | ReferenceRecorded
  | StreamErrorFrame;

/** 文脈サイズ。input + cacheCreation + cacheRead の和だけ。他の式にしない。 */
export function contextSize(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}
