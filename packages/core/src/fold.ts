/**
 * イベントを畳んで、いまの状態を作る。
 *
 * **写しを持たない**（規則3）。スレッド一覧も判断待ちの列も、ここで毎回作り直す。
 * 保存された「現在の状態」は存在しない。
 */

import type {
  BantoEvent,
  ChannelId,
  DecisionId,
  DecisionOption,
  DecisionSource,
  ThreadId,
  ThreadStatus,
} from './event.js';

export interface ChannelState {
  readonly id: ChannelId;
  readonly name: string;
  readonly threadIds: ThreadId[];
}

export interface ForkOrigin {
  readonly threadId: ThreadId;
  readonly baseVersion: number;
  readonly mode: 'base' | 'tip';
}

/** base の1行。**配列からは取り除かない**——`baseVersion` は配列の添字ではなく
 * 版番号そのものなので、無効化しても位置がずれてはいけない（fork の継承境界が
 * この番号で決まるため）。 */
export interface BaseEntry {
  readonly baseVersion: number;
  readonly text: string;
  invalidated: boolean;
}

export interface ThreadState {
  readonly id: ThreadId;
  readonly channelId: ChannelId;
  readonly title: string;
  status: ThreadStatus;
  /** このスレッド自身が追記した base。継承分は含まない——`effectiveBase` で解く。 */
  readonly ownBase: BaseEntry[];
  /** 自分の追記後の版。fork 元から継承した版を起点に増える。 */
  baseVersion: number;
  readonly forkedFrom: ForkOrigin | null;
  /**
   * 畳んで閉じた先。畳んでいなければ `null`。
   *
   * `status` とは別の事実として持つ（規則3）——`done` は「いま処理待ち」の意味で
   * 使われていて（ターンが終わるたびに立つ）、「もう二度と開かない」とは違う。
   */
  mergedInto: ThreadId | null;
  /**
   * このスレッドのターン数。**次の turnIndex はここから続ける。**
   *
   * run() ごとに 0 から振り直すと、observer が index で並べ替えたときに
   * 2回目以降のターンが1回目に混ざり、文脈サイズの系列が壊れる。
   */
  turnCount: number;
  /**
   * 直近のランタイムのセッション識別子。**不透明な文字列。解釈しない。**
   * これがあれば続きから走れる。無ければ新しく始まる。
   */
  sessionHandle: string | null;
}

export interface PendingDecision {
  readonly decisionId: DecisionId;
  readonly source: DecisionSource;
  readonly threadId: ThreadId | null;
  readonly question: string;
  /**
   * 出した選択肢。無ければ自由文だけ。**答えはここに限らない**——どれも選べないのは
   * 普通のことなので、選択肢の有無で答え方を縛らない。
   */
  readonly options?: readonly DecisionOption[];
  /** 立った時刻（ISO）。滞留の判定に使う（要件 A7）。 */
  readonly since: string;
}

export interface State {
  readonly channels: Map<ChannelId, ChannelState>;
  readonly threads: Map<ThreadId, ThreadState>;
  /** 出所を問わない1本の列（要件 A6）。解決済みは消える。 */
  readonly pendingDecisions: Map<DecisionId, PendingDecision>;
}

export function fold(events: readonly BantoEvent[]): State {
  const channels = new Map<ChannelId, ChannelState>();
  const threads = new Map<ThreadId, ThreadState>();
  const pendingDecisions = new Map<DecisionId, PendingDecision>();

  const attach = (channelId: ChannelId, threadId: ThreadId): void => {
    const channel = channels.get(channelId);
    if (channel && !channel.threadIds.includes(threadId)) channel.threadIds.push(threadId);
  };

  for (const event of events) {
    switch (event.type) {
      case 'channel.created':
        channels.set(event.channelId, {
          id: event.channelId,
          name: event.channelName,
          threadIds: [],
        });
        break;

      case 'thread.created':
        threads.set(event.threadId, {
          id: event.threadId,
          channelId: event.channelId,
          title: event.title,
          status: 'working',
          ownBase: [],
          baseVersion: 0,
          forkedFrom: null,
          mergedInto: null,
          turnCount: 0,
          sessionHandle: null,
        });
        attach(event.channelId, event.threadId);
        break;

      case 'thread.forked':
        threads.set(event.threadId, {
          id: event.threadId,
          channelId: event.channelId,
          title: event.title,
          status: 'working',
          ownBase: [],
          // 切った時点の版を引き継ぐ。以後の親の追記は見ない（要件 R4）。
          baseVersion: event.from.baseVersion,
          forkedFrom: {
            threadId: event.from.threadId,
            baseVersion: event.from.baseVersion,
            mode: event.mode,
          },
          mergedInto: null,
          turnCount: 0,
          sessionHandle: null,
        });
        attach(event.channelId, event.threadId);
        break;

      case 'thread.status': {
        const thread = threads.get(event.threadId);
        if (thread) thread.status = event.status;
        break;
      }

      case 'thread.merged': {
        const thread = threads.get(event.threadId);
        if (thread) thread.mergedInto = event.into;
        break;
      }

      case 'base.appended': {
        const thread = threads.get(event.threadId);
        if (thread) {
          thread.ownBase.push({ baseVersion: event.baseVersion, text: event.text, invalidated: false });
          thread.baseVersion = event.baseVersion;
        }
        break;
      }

      case 'base.invalidated': {
        const thread = threads.get(event.threadId);
        const entry = thread?.ownBase.find((e) => e.baseVersion === event.baseVersion);
        if (entry) entry.invalidated = true;
        break;
      }

      case 'base.reactivated': {
        const thread = threads.get(event.threadId);
        const entry = thread?.ownBase.find((e) => e.baseVersion === event.baseVersion);
        if (entry) entry.invalidated = false;
        break;
      }

      case 'turn.usage': {
        const thread = threads.get(event.threadId);
        if (thread) thread.turnCount += 1;
        break;
      }

      case 'thread.session': {
        const thread = threads.get(event.threadId);
        if (thread) thread.sessionHandle = event.sessionHandle;
        break;
      }

      case 'decision.requested':
        pendingDecisions.set(event.decisionId, {
          decisionId: event.decisionId,
          source: event.source,
          threadId: event.threadId,
          question: event.question,
          ...(event.options === undefined ? {} : { options: event.options }),
          since: event.at,
        });
        break;

      case 'decision.resolved':
        pendingDecisions.delete(event.decisionId);
        break;

      case 'compaction.reported':
      case 'query.step':
      // AI が指したもの（要件 C14）。**会話の年表には出るが、状態は変えない。**
      case 'reference.recorded':
        // 状態には効かない。観測と追跡のための記録（要件 B6）。
        break;
    }
  }

  return { channels, threads, pendingDecisions };
}

/**
 * そのスレッドが実際に見る base を解く。
 *
 * fork 元から**切った時点の版まで**を継ぎ、その後に自分の追記を足す。
 * 親がその後に追記しても、このスレッドには入らない（要件 R4）。
 *
 * 注：fork の `mode`（'base' / 'tip'）が変えるのは**以降のメッセージ**をどこから
 * 引くかであって、base の解きかたではない。Phase 0 ではメッセージ列をまだ
 * 畳んでいないので、mode は記録するだけで、ここでは効かない。
 */
/** `effectiveBaseEntries` の1行。継承したものかどうか・実際の持ち主が付く。 */
export interface EffectiveBaseEntry extends BaseEntry {
  /** このスレッド自身が追記したか。**無効化できるのは own のものだけ**——
   * 継承した行は、持ち主（`ownerThreadId`）のスレッドでしか無効化できない。 */
  readonly own: boolean;
  /** 実際にこの行を追記したスレッド。own なら threadId 自身と同じ。 */
  readonly ownerThreadId: ThreadId;
}

/**
 * そのスレッドが実際に見る base を、行ごとの詳細つきで解く。
 *
 * fork 元から**切った時点の版まで**を継ぎ、その後に自分の追記を足す。
 * 親がその後に追記しても、このスレッドには入らない（要件 R4）。
 *
 * **境界は `baseVersion`（版番号）で判定する。配列の長さでは判定しない**
 * ——無効化された行も配列からは取り除かないが、`effectiveBase`（文字列版）は
 * それを読み飛ばす。版号ベースで切れば、無効化がいつ起きても fork の継承境界は動かない。
 */
export function effectiveBaseEntries(state: State, threadId: ThreadId): EffectiveBaseEntry[] {
  const thread = state.threads.get(threadId);
  if (!thread) return [];

  const origin = thread.forkedFrom;
  const inherited: EffectiveBaseEntry[] = origin
    ? effectiveBaseEntries(state, origin.threadId)
        .filter((e) => e.baseVersion <= origin.baseVersion)
        .map((e) => ({ ...e, own: false }))
    : [];

  const own: EffectiveBaseEntry[] = thread.ownBase.map((e) => ({
    ...e,
    own: true,
    ownerThreadId: thread.id,
  }));

  return [...inherited, ...own];
}

/**
 * そのスレッドが実際に見る base を解く。**無効化された行は読み飛ばす。**
 *
 * 注：fork の `mode`（'base' / 'tip'）が変えるのは**以降のメッセージ**をどこから
 * 引くかであって、base の解きかたではない。Phase 0 ではメッセージ列をまだ
 * 畳んでいないので、mode は記録するだけで、ここでは効かない。
 */
export function effectiveBase(state: State, threadId: ThreadId): string[] {
  return effectiveBaseEntries(state, threadId)
    .filter((e) => !e.invalidated)
    .map((e) => e.text);
}

/** 判断待ちを1画面に出すための一覧。古い順（待たせているものが上）。 */
export function pendingQueue(state: State): PendingDecision[] {
  return [...state.pendingDecisions.values()].sort((a, b) => a.since.localeCompare(b.since));
}
