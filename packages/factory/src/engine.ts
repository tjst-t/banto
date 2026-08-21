/**
 * Factory の本体（要件 B1〜B7、ADR-0001 決定10）。
 *
 * **耐久ワークフロー（durable execution）は名前のついた問題**なので、機構は既知の形に乗る
 * （規則12）。banto に固有なのは2点だけ：
 *
 * 1. **済んだかどうかを、フラグではなく世界を見て決める**（`stage.ts`）
 * 2. **マージだけを直列にする**（merge queue。bors / GitHub merge queue / Zuul）
 *
 * 実装とテストは並行に進み、**取り込みだけが1本の列**に入る。これで
 * 「3依頼を同時に投げて3つとも main に入る」（要件 B の受け入れ）が、
 * 衝突の解決を機構に持たせずに成り立つ。
 */

import {
  EventLog,
  appendBase,
  fold,
  type BantoEvent,
  type ChannelId,
  type NewEvent,
  type RunId,
} from '@banto/core';

import type { EnvironmentPort, Implementer, RepoPort, RunPlan, TestCommand } from './ports.js';
import { isSettled, nextStage, type Next, type Observation } from './stage.js';

export interface FactoryOptions {
  readonly log: EventLog;
  readonly repo: RepoPort;
  readonly environment: EnvironmentPort;
  readonly implementer: Implementer;
  /** テストの走らせ方。**リポジトリが決める**（仕様 §6）。 */
  readonly test: TestCommand;
  /** 取り込み先。**`base` とは呼ばない**——会話の base と重なる（仕様 §5.8）。 */
  readonly targetBranch?: string;
  /** 人を待つか。**既定は待たない**（要件 B4）。 */
  readonly needsReview?: boolean;
  /**
   * 同時に進める Run の数（要件 F4）。
   *
   * **上限の根拠は Phase 2 で測る。** F4 は「線形を超えたら違反」ではなく
   * 「どこで曲がるか」を測る検証項目である（ADR 決定15）。
   */
  readonly maxConcurrent?: number;
}

/** ログから畳んだ Run。**現在の段は含まない**——それは世界を見て決める。 */
export interface RunRecord extends RunPlan {
  readonly channelId: ChannelId;
  readonly requestedAt: string;
  readonly failed: boolean;
  /** commit の sha → 結果。**鍵が sha なので、載せ直せば自動的に無効になる。** */
  readonly tested: ReadonlyMap<string, boolean>;
}

/** Run の作業ツリーの場所。**1箇所で決める**——散らすと再開時にずれる。 */
export function workdirOf(branch: string): string {
  return `.banto-worktrees/${branch}`;
}

export function reviewDecisionId(runId: RunId): string {
  return `review:${runId}`;
}

/** ログを畳んで Run を作る（規則3）。 */
export function foldRuns(events: readonly BantoEvent[]): RunRecord[] {
  const runs = new Map<RunId, RunRecord>();
  const tested = new Map<RunId, Map<string, boolean>>();
  const failed = new Set<RunId>();

  for (const event of events) {
    if (event.type === 'run.requested') {
      tested.set(event.runId, tested.get(event.runId) ?? new Map());
      runs.set(event.runId, {
        runId: event.runId,
        channelId: event.channelId,
        threadId: event.threadId,
        branch: event.branch,
        request: event.request,
        workdir: workdirOf(event.branch),
        requestedAt: event.at,
        failed: false,
        tested: tested.get(event.runId) as Map<string, boolean>,
      });
    } else if (event.type === 'run.tested') {
      const map = tested.get(event.runId) ?? new Map<string, boolean>();
      map.set(event.commit, event.passed);
      tested.set(event.runId, map);
    } else if (event.type === 'run.failed') {
      failed.add(event.runId);
    }
  }

  return [...runs.values()]
    .map((r) => ({ ...r, failed: failed.has(r.runId) }))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export class Factory {
  private readonly into: string;
  private readonly needsReview: boolean;
  private readonly cap: number;

  constructor(private readonly options: FactoryOptions) {
    this.into = options.targetBranch ?? 'main';
    this.needsReview = options.needsReview ?? false;
    this.cap = options.maxConcurrent ?? 3;
  }

  /**
   * 依頼を1件投げる。**進めるのは `advanceAll`**——投げる側は待たない（要件 B4）。
   *
   * **Run は Thread を1つ持つ**（仕様 §5.1）ので、ここで会話も作る。会話の器を
   * 作り直さないので、セッション再開（要件 B5）も fork（要件 A3）もそのまま効く。
   *
   * **依頼は base に入る。** 要件 R3 の表に「依頼・制約」がそう書いてある。
   * したがって **R8 のゲートを通る**——base が閾値を超えていれば、Run は始まらない。
   * ここを迂回させると、ゲートに穴が1つ空く（決定4）。
   */
  async request(input: {
    runId: RunId;
    channelId: ChannelId;
    threadId: string;
    branch: string;
    request: string;
  }): Promise<void> {
    const { log } = this.options;

    if (!fold(await log.read()).threads.has(input.threadId)) {
      await log.append({
        type: 'thread.created',
        threadId: input.threadId,
        channelId: input.channelId,
        title: input.request.slice(0, 80),
      });
    }

    const gate = await appendBase(log, fold(await log.read()), input.threadId, input.request);
    if (!gate.ok) {
      // 握りつぶさない（規則2）。**Run を作らずに断る**——中途半端な Run を残さない。
      throw new Error(`依頼を base に入れられないので Run を始めない: ${gate.reason}`);
    }

    await log.append({ type: 'run.requested', ...input });
  }

  /**
   * いまの世界を見る。**保存された状態を読まない**（規則3・仕様 §5.3）。
   *
   * 環境の生死を `status` で聞けるのは決定16 で口に足したからで、
   * これが無いと「環境が無い」と「コマンドが落ちた」を区別できなかった。
   */
  async observe(run: RunRecord): Promise<Observation> {
    const hasWorktree = await this.options.repo.hasWorktree(run.workdir);
    const handle = await this.handleOf(run);
    const environment = handle === null ? 'gone' : await this.options.environment.status(handle);

    const hasCommits = hasWorktree
      ? await this.options.repo.isAhead(run.branch, this.into).catch(() => false)
      : false;
    const head = hasCommits ? await this.options.repo.headOf(run.branch) : null;
    const passed = head === null ? undefined : run.tested.get(head);

    /**
     * **「まだ何もしていない」と「取り込み済み」は、git だけでは同じに見える。**
     *
     * どちらもブランチは取り込み先より先に進んでいないし、`merge-base --is-ancestor` は
     * どちらでも真になる（切った直後のブランチは、当然ながら祖先である）。
     * 最初に書いたときここを `isMerged` だけで見ていて、**Run が生まれた瞬間に
     * 「取り込み済み」と判定されて何もせず終わっていた。**
     *
     * 足りない1ビットは「この Run が仕事をしたか」で、それは
     * **測ったことがあるか**で分かる——テスト結果は commit に鍵をつけて
     * ログに在る（導出できないので記録してよい唯一の事実。仕様 §5.3）。
     */
    const merged = run.tested.size > 0 && !hasCommits;

    const decisions = fold(await this.options.log.read()).pendingDecisions;
    const reviewPending = decisions.has(reviewDecisionId(run.runId));

    return {
      failed: run.failed,
      hasWorktree,
      environment,
      hasCommits,
      head,
      testedHead: passed === undefined ? null : { passed },
      needsReview: this.needsReview,
      // 立っていない＝まだ聞いていないか、答えが出たか。答えが出ていれば進んでよい。
      reviewApproved: this.needsReview ? !reviewPending && (await this.reviewAnswered(run)) : true,
      merged,
    };
  }

  private async reviewAnswered(run: RunRecord): Promise<boolean> {
    const id = reviewDecisionId(run.runId);
    return (await this.options.log.read()).some(
      (e) => e.type === 'decision.resolved' && e.decisionId === id,
    );
  }

  /**
   * その Run の環境の handle。**作業ツリーの場所から決まる**ので、覚えない（規則3）。
   * 作業ツリーが無ければ、環境も無い。
   */
  private async handleOf(run: RunRecord): Promise<string | null> {
    if (!(await this.options.repo.hasWorktree(run.workdir))) return null;
    return this.options.environment
      .create(run.workdir)
      .then((h) => h)
      .catch(() => null);
  }

  /** 1つの Run を1段だけ進める。**進めた段を返す**（何もしなければ終端を返す）。 */
  async step(run: RunRecord): Promise<Next> {
    const next = nextStage(await this.observe(run));
    if (isSettled(next)) return next;

    try {
      await this.perform(run, next);
    } catch (cause) {
      // 握りつぶさない（規則2）。**記録して止める**——記録しないと永久に同じ段を試みる。
      await this.fail(run, next, cause);
      return 'failed';
    }
    return next;
  }

  private async fail(run: RunRecord, stage: string, cause: unknown): Promise<void> {
    const failure: NewEvent = {
      type: 'run.failed',
      runId: run.runId,
      stage,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
    await this.options.log.append(failure);
    // 人に上げる。**列は止めない**（要件 B の受け入れ）。
    await this.options.log.append({
      type: 'decision.requested',
      decisionId: `run-failed:${run.runId}`,
      source: 'factory',
      threadId: run.threadId,
      question: `Run が ${stage} で失敗した: ${failure.detail}`,
    });
  }

  private async perform(run: RunRecord, stage: Next): Promise<void> {
    const { repo, environment, implementer, test, log } = this.options;

    switch (stage) {
      case 'worktree':
        await repo.addWorktree(run.branch, run.workdir);
        return;

      case 'environment':
        await environment.create(run.workdir);
        return;

      case 'implement': {
        const handle = await environment.create(run.workdir);
        await implementer.implement(run, handle, environment);
        // 実装したと言われても、**commit が無ければ済んでいない。** 現物で確かめる。
        if (!(await repo.isAhead(run.branch, this.into))) {
          throw new Error('実装が commit を作らなかった');
        }
        return;
      }

      case 'test': {
        const handle = await environment.create(run.workdir);
        const commit = await repo.headOf(run.branch);
        const result = await environment.exec(handle, test.command, test.args);
        // **結果は sha に鍵をつけて記録する**（仕様 §5.3）。載せ直せば自動的に無効になる。
        await log.append({
          type: 'run.tested',
          runId: run.runId,
          commit,
          passed: result.exitCode === 0,
          detail: `exit=${result.exitCode} ${result.stderr.trim().slice(0, 500)}`,
        });
        return;
      }

      case 'review':
        // 二重に立てない。立てるだけで待たない——待つのは次の pass。
        if (!fold(await log.read()).pendingDecisions.has(reviewDecisionId(run.runId))) {
          await log.append({
            type: 'decision.requested',
            decisionId: reviewDecisionId(run.runId),
            source: 'factory',
            threadId: run.threadId,
            question: `${run.branch} を ${this.into} に入れてよいか: ${run.request}`,
          });
        }
        return;

      case 'merge':
        try {
          await repo.merge(run.branch, this.into);
        } catch {
          // 衝突（要件 B7）。**先端に載せ直して、テストからやり直す**（実装は済んでいる）。
          // 載せ直すと sha が変わるので、テスト結果は**自動的に**無効になる。
          await repo.rebaseOnto(run.workdir, this.into);
        }
        return;

      case 'teardown': {
        const handle = await environment.create(run.workdir).catch(() => null);
        if (handle !== null) await environment.destroy(handle);
        await repo.removeWorktree(run.workdir);
        return;
      }
    }
  }

  /**
   * 進められる Run を、進められるところまで進める。
   *
   * **実装とテストは並行、取り込みは1本の列**（要件 B3・B7）。列の順は依頼の古い順で、
   * **失敗した Run は列を塞がない。**
   *
   * 何度呼んでも同じ——落ちて再開したら、もう一度呼ぶだけでよい（要件 B5）。
   */
  async advanceAll(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      const runs = foldRuns(await this.options.log.read());
      const observed = await Promise.all(
        runs.map(async (run) => ({ run, next: nextStage(await this.observe(run)) })),
      );
      const active = observed.filter((r) => !isSettled(r.next));
      if (active.length === 0) return;

      // 取り込み以外を、上限つきで並行に。
      const parallel = active.filter((r) => r.next !== 'merge');
      for (let i = 0; i < parallel.length; i += this.cap) {
        await Promise.all(parallel.slice(i, i + this.cap).map(({ run }) => this.step(run)));
      }

      // **取り込みだけ直列。** 古い順に1本ずつ。
      for (const { run } of active.filter((r) => r.next === 'merge')) {
        await this.step(run);
      }

      // 人待ちだけが残ったら、進めるものは無い。**空回りしない。**
      if (parallel.every((r) => r.next === 'review') && active.every((r) => r.next === 'review')) {
        return;
      }
    }
    // 回り続けるのは機構が壊れている合図（規則6）。**待ちを延ばさず、止めて上げる。**
    throw new Error(`Factory が ${maxRounds} 巡しても収束しない——段の判定が進んでいない`);
  }
}
