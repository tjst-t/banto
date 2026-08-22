import { Fragment, type ReactNode } from 'react';
import { AlertTriangle, GitFork, PackageMinus } from 'lucide-react';
import { StickToBottom } from 'use-stick-to-bottom';

import { Markdown } from './Markdown';
import { ReferenceCard } from './ReferenceCard';
import { DecisionCard } from './DecisionCard';
import { JumpToBottom } from './JumpToBottom';
import type { TimelineItem } from '../hooks/useThreadSessions';
import type { StreamEvent } from '../lib/types';
import { contextSize } from '../lib/types';
import { dateLabel, isNewDay, timeLabel } from '../lib/time';

/**
 * 会話の年表（要件 A6・A8・E4・E5・E6）。
 *
 * ## 誰の言葉かを、印と置き方で言う（要件 E6）
 *
 * - **人の言葉**：沈んだ紙の吹き出し、右に寄せる
 * - **相手の言葉**：**器を持たせない。印を左に、字下げして置く**
 *
 * 相手に器を持たせないのは意匠の趣味ではない——**器があると、読むたびに枠が目に入る。**
 * 読ませたいのは中身であって枠ではないし、届いた分だけ箱が伸び縮みすることもなくなる。
 *
 * ## 判断待ちは、会話の最後尾にそのまま出す（要件 A6）
 *
 * 別立ての列を持たない。それが最新の発言なら、放っておいても一番下にある
 * ——**常設の判断待ち欄は無い。** 遡ったときだけ、下端の浮き玉（`JumpToBottom`）が教える。
 *
 * ## 会話に属さない記録は、線1本に落とす
 *
 * ターン境界・追記・テスト結果は「会話」ではなく「そのとき起きたこと」なので、
 * **点と細字だけ**にして本文の邪魔をしない。消しはしない——
 * 静かに起きていることが見えなくなるほうが困る（規則4）。
 */
export function MessageList({
  items,
  running,
  onOpen,
  onAnswer,
}: {
  items: TimelineItem[];
  running: boolean;
  /** AI が指したものを開く（要件 C14）。**押すまで開かない。** */
  onOpen: (uri: string, name: string) => void;
  /** 判断待ちに答える（要件 A6）。答えは `message.recorded` として会話にも返る。 */
  onAnswer: (decisionId: string, answer: string, optionId?: string) => Promise<void>;
}) {
  /**
   * 文面が記録されている問い合わせの集合（要件 A8）。
   *
   * `message.recorded` を入れる前の会話では、相手の文面は `query.step` の `detail` に
   * しか無い。出さないと**過去の会話が読めなくなる**ので、そのときはそちらから読む。
   *
   * **判定は「会話ごと」ではなく「問い合わせごと」。** 会話ごとにすると、
   * **古い形と新しい形が混ざった会話で、古いほうが丸ごと消える**
   * ——実際に消えた（自分で画面を見て気づいた）。同じ会話の中で形が変わりうる以上、
   * 判定の単位も同じ細かさでないと合わない。
   */
  const recordedQueries = new Set(
    items.flatMap((i) => (i.event.type === 'message.recorded' ? [i.event.queryId] : [])),
  );

  /**
   * 答え済みの判断。**答えたものはもう押せる形で出さない。**
   *
   * `decision.resolved` では判定できない——**その型は `threadId` を持たない**
   * （機構の警報など、スレッドに紐づかない判断もあるため）。host の
   * `/api/events?threadId=` は `threadId` を持つ／`runId` から導けるイベントしか
   * 返さないので、`decision.resolved` はここに届かない（実測）。
   *
   * 届くのは、答えを会話に返すために積まれる `message.recorded`
   * （`queryId: "decision:<decisionId>"`、`modules/ledger/src/core.ts`）——
   * こちらで判定する。
   */
  const resolvedDecisions = new Set(
    items.flatMap((i) =>
      i.event.type === 'message.recorded' && i.event.queryId.startsWith('decision:')
        ? [i.event.queryId.slice('decision:'.length)]
        : [],
    ),
  );

  /** 直前に日付を出した時刻。**出せた行だけ更新する**（時刻の無い行を挟まない）。 */
  let prevAt: string | undefined;

  /** 未解決の判断待ちの件数。**浮き玉の朱色・件数はこれで決める。** */
  const pendingCount = items.filter(
    (i) => i.event.type === 'decision.requested' && !resolvedDecisions.has(i.event.decisionId),
  ).length;

  return (
    /**
     * **末尾に追従する。ただし遡って読んでいる間は飛ばない**（要件 E5）。
     *
     * **名前のある問題なので自分で解かない**（規則12）。素朴に `scrollTop` を毎回
     * 末尾へ入れる実装は、読み返している最中に引きずり戻す——それが「追従が無い」
     * より嫌われるのは、**自分の操作が奪われる**からである。
     */
    <StickToBottom className="relative min-h-0 flex-1" resize="smooth" initial="instant">
      <StickToBottom.Content className="mx-auto flex w-full max-w-[var(--w-read)] flex-col gap-2 px-5 py-3">
        {items.length === 0 && !running && (
          <p className="py-8 text-center text-sm leading-loose text-ink-muted">
            メッセージを送るとここに会話が流れます。
          </p>
        )}

        {items.map((item) => {
          const body = renderEvent(item.event, recordedQueries, resolvedDecisions, onOpen, onAnswer);
          const at = atOf(item.event);
          const divider = body !== null && at !== undefined && isNewDay(at, prevAt) ? at : null;
          if (at !== undefined && body !== null) prevAt = at;
          if (body === null) return null;
          return (
            <Fragment key={item.id}>
              {divider !== null && <DayDivider at={divider} />}
              {body}
            </Fragment>
          );
        })}

        {running && <Thinking />}
      </StickToBottom.Content>
      <JumpToBottom pendingCount={pendingCount} />
    </StickToBottom>
  );
}

/** そのイベントが起きた時刻。**無い形もある**ので、無ければ日付の線は挟まない。 */
function atOf(event: StreamEvent): string | undefined {
  return 'at' in event && typeof event.at === 'string' ? event.at : undefined;
}

function renderEvent(
  event: StreamEvent,
  recordedQueries: ReadonlySet<string>,
  resolvedDecisions: ReadonlySet<string>,
  onOpen: (uri: string, name: string) => void,
  onAnswer: (decisionId: string, answer: string, optionId?: string) => Promise<void>,
): ReactNode {
  // 文面は message.recorded が持つ（要件 A8）。**ログに在るので開き直しても残る。**
  if (event.type === 'message.recorded') {
    return event.role === 'user' ? (
      <FromPerson text={event.text} at={event.at} />
    ) : (
      <FromBanto text={event.text} at={event.at} />
    );
  }

  if (event.type === 'query.step') {
    if (event.status === 'started') return null; // 下の running で表す
    if (event.status === 'succeeded') {
      // その問い合わせの文面が記録済みなら出さない（同じものが2箇所に並ぶ）。
      if (recordedQueries.has(event.queryId) || !event.detail) return null;
      return <FromBanto text={event.detail} at={event.at} />;
    }
    return <Stopped title="実行に失敗しました" detail={event.detail ?? ''} />;
  }

  if (event.type === 'turn.usage') {
    // ツール呼び出しの中身（何を呼んだか）は host のイベントに載っていないので
    // 出せない——見えるのは「1ターン進み、usage がこれだけ記録された」ことだけ。
    return (
      <Aside>ターン境界 ・ {contextSize(event.usage).toLocaleString('ja-JP')} トークン</Aside>
    );
  }

  if (event.type === 'compaction.reported') {
    return (
      <Note tone="caution" icon={<PackageMinus className="h-3.5 w-3.5" />}>
        <span className="font-medium">圧縮が発火しました</span>
        <span className="block">{event.detail}</span>
      </Note>
    );
  }

  /**
   * スレッドの状態は**見出しに出ている**ので、ここには出さない。
   *
   * 1往復ごとに「作業中」「完了」が積まれるため、出すと**会話より状態の札の
   * ほうが多くなる**（自分で画面を見て気づいた）。同じことを2箇所に置かない（規則3）。
   */
  if (event.type === 'thread.status') return null;

  // 会話の見た目には効かない記録。**出さないが、エラーでもない。**
  if (event.type === 'thread.session' || event.type === 'thread.created') return null;
  // 依頼の文面は base に入っているので、ここでは二重に出さない。
  if (event.type === 'run.requested') return null;

  // 「決まったこと」への追記（要件 R2・R6）。**静かに増えるものを見えるようにする。**
  if (event.type === 'base.appended') {
    return (
      <Aside tone="accent">
        決まったことに追記（第 {event.baseVersion} 版）・{event.text.length} 文字
      </Aside>
    );
  }

  if (event.type === 'run.tested') {
    return (
      <Aside tone={event.passed ? 'done' : 'stopped'}>
        テスト {event.passed ? '通過' : '失敗'} ・{' '}
        <span className="font-mono">{event.commit.slice(0, 7)}</span>
      </Aside>
    );
  }

  if (event.type === 'run.failed') {
    return <Stopped title={`${event.stage} で止まりました（人の判断待ち）`} detail={event.detail} />;
  }

  // **どこから分かれたかは、会話の最初に要る情報**（要件 A3・R4）。
  // 継承した決まりごとは「決まったこと」の面に出るが、
  // 分かれた事実そのものは年表にしか置き場が無い。
  if (event.type === 'thread.forked') {
    return (
      <Aside icon={<GitFork className="h-3 w-3" />}>
        {event.mode === 'base' ? '決まったこと' : 'いまの続き'}からフォーク（base v
        {event.from.baseVersion} まで引き継ぎ）
      </Aside>
    );
  }

  // **AI が「これを見て」と指したもの**（要件 C14・決定19）。パネルを開くカード。
  if (event.type === 'reference.recorded') {
    return <ReferenceCard event={event} onOpen={onOpen} />;
  }

  // **判断待ちは、会話の最後尾にそのまま出す**（要件 A6）。答え済みなら押せる形にしない。
  if (event.type === 'decision.requested') {
    if (resolvedDecisions.has(event.decisionId)) {
      return <Aside>判断待ちだった: {event.question}</Aside>;
    }
    return (
      <div className="ml-8 max-w-[85%]">
        <DecisionCard
          question={event.question}
          options={event.options}
          onAnswer={(answer, optionId) => onAnswer(event.decisionId, answer, optionId)}
        />
      </div>
    );
  }

  // **通常はここに届かない**（`threadId` を持たないため。`resolvedDecisions` の説明を見よ）。
  // 届く経路が増えたときのために、型として在る以上は描いておく（規則2：知らない型に落とさない）。
  if (event.type === 'decision.resolved') {
    return <Aside tone="done">判断に答えた{event.optionId === null ? '' : `（${event.optionId}）`}</Aside>;
  }

  if (event.type === 'error') {
    return <Stopped title="エラー" detail={event.detail} />;
  }

  /**
   * **知らないイベントを「エラー」と言わない。**
   *
   * ここは以前、当たらなかったもの全部をエラー枠に落としていた。
   * サーバを新しくして `run.step` が `query.step` になった日、
   * **画面が真っ赤になり、しかも理由が「エラー」としか出なかった**——
   * 何が起きているのか画面から分からない、いちばん困る形である（規則2）。
   *
   * 知らないものは**知らないと言う。** 型を出しておけば、次に見た人が辿れる。
   */
  return (
    <Aside>
      未対応のイベント: <span className="font-mono">{(event as { type: string }).type}</span>
    </Aside>
  );
}

/** 人の言葉。**沈んだ紙に置く**——自分が打ったものだと分かればよい（要件 E6）。 */
function FromPerson({ text, at }: { text: string; at: string }) {
  return (
    <div className="mt-6 flex flex-col items-end first:mt-0">
      <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-paper-sunken px-3.5 py-2.5 text-md text-ink">
        {text}
      </div>
      <span className="mt-0.5 text-xs text-ink-muted">{timeLabel(at)}</span>
    </div>
  );
}

/**
 * banto の言葉。**器なし・印つき**（要件 E6）。
 *
 * 中身は Markdown として描く（要件 E4）。ここまで素の文字列で出していたので、
 * 見出しも箇条も表も**記号のまま**並んでいた。
 */
function FromBanto({ text, at }: { text: string; at: string }) {
  return (
    <div className="group relative mt-6 pl-8 first:mt-0" data-from="banto">
      <span
        aria-hidden
        className="absolute left-0 top-1 grid h-5 w-5 place-items-center rounded-sm bg-accent text-xs font-semibold text-paper-raised"
      >
        番
      </span>
      <Markdown text={text} />
      <span className="mt-1 block text-xs text-ink-muted opacity-0 transition-opacity group-hover:opacity-100">
        {timeLabel(at)}
      </span>
    </div>
  );
}

/** 日付の境目。**遡って読むときの手がかり**になる。 */
function DayDivider({ at }: { at: string }) {
  return (
    <div className="my-4 flex items-center gap-3" role="separator" aria-label={dateLabel(at)}>
      <span className="h-px flex-1 bg-rule-faint" />
      <span className="text-xs text-ink-muted">{dateLabel(at)}</span>
      <span className="h-px flex-1 bg-rule-faint" />
    </div>
  );
}

/** 会話に属さない記録。**点と細字だけ**にして本文の邪魔をしない。 */
function Aside({
  children,
  tone = 'neutral',
  icon,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'done' | 'stopped';
  icon?: ReactNode;
}) {
  const dot =
    tone === 'accent'
      ? 'bg-accent'
      : tone === 'done'
        ? 'bg-done'
        : tone === 'stopped'
          ? 'bg-stopped'
          : 'bg-paper-sunken-2';
  return (
    <div className="flex items-center gap-1.5 self-start pl-8 text-xs text-ink-muted">
      {icon ?? <span className={`h-1.5 w-1.5 rounded-sm ${dot}`} />}
      {children}
    </div>
  );
}

/**
 * 止まったこと。**紫**（`theme/tokens.css` の色の役）。
 *
 * 朱にしない——朱は「あなたの番」に取ってある。エラーを朱にすると、
 * 画面でいちばん強い色が「あなたの番」を指さなくなる。
 */
function Stopped({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="ml-8 flex items-start gap-2 self-start rounded-md bg-stopped-soft px-3 py-2 text-sm text-ink shadow-[inset_2px_0_0_var(--stopped)]">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stopped" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="break-words text-ink-secondary">{detail}</p>
      </div>
    </div>
  );
}

/** 気をつけること。**左罫で言う。** */
function Note({
  children,
  tone,
  icon,
}: {
  children: ReactNode;
  tone: 'caution';
  icon: ReactNode;
}) {
  const skin =
    tone === 'caution' ? 'bg-caution-soft shadow-[inset_2px_0_0_var(--caution)]' : '';
  const mark = 'text-caution';
  return (
    <div
      className={`ml-8 flex max-w-[85%] items-start gap-2 self-start rounded-md px-3 py-2 text-sm text-ink ${skin}`}
    >
      <span className={`mt-0.5 shrink-0 ${mark}`}>{icon}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * 考えている間。**点滅ではなく、順に強くなる点**——
 * 一斉の点滅は「止まっているのか進んでいるのか」が読めない。
 */
function Thinking() {
  return (
    <div className="mt-6 flex items-center gap-2 pl-8 text-sm text-ink-muted">
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-sm bg-accent animate-[banto-pulse_1.2s_ease-in-out_infinite]"
            style={{ animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
      考えています…
    </div>
  );
}
