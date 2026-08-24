/**
 * Factory の core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * 実体は `@banto/factory` の `Factory`/`FactoryPool`/`foldRuns`——ここはそれを
 * AI 向けの道具・人向けの面（URI）から使いやすい形に薄く委譲するだけ。
 *
 * **チャンネルは名前で1つに保つ**（`ensureChannel`、`@banto/core`）。
 * `apps/host/src/server.ts` の `/api/runs` と同じ「無ければ作る」を通る
 * ——2箇所に同じロジックを持たない（規則3）。
 */

import { randomUUID } from 'node:crypto';

import { EventLog, ensureChannel, fold } from '@banto/core';
import { foldRuns, nextStage, type Factory, type FactoryPool, type RunRecord } from '@banto/factory';

export interface RunView {
  readonly runId: string;
  readonly threadId: string;
  readonly branch: string;
  readonly request: string;
  readonly failed: boolean;
  readonly testedCommits: { commit: string; passed: boolean }[];
  /**
   * いまの段（`worktree`/`environment`/`implement`/`test`/`review`/`merge`/
   * `teardown`/`done`/`failed`/`rejected`）。**世界を見て決める**（`stage.ts`）
   * ——保存された段は無い。観測できなければ、その理由を文字列で返す
   * （握りつぶさない。規則2）。
   */
  readonly stage: string;
}

export function runUri(runId: string): string {
  return `banto://factory/run/${encodeURIComponent(runId)}`;
}

export class FactoryCore {
  constructor(
    private readonly log: EventLog,
    private readonly pool: FactoryPool,
  ) {}

  /**
   * 依頼を1件投げる。**進めるのは `advanceRuns`**——投げる側は待たない（要件 B4）。
   *
   * Run は自分のスレッドを持つ（仕様 §5.1）。**このチャンネルを引数にしない**——
   * `channelName` は自由記入だが、Run 自体はここで新しく作るスレッドに閉じるので、
   * 他人の会話を指せる形にはならない（要件 D4 の考えと矛盾しない）。
   */
  async requestRun(input: {
    request: string;
    repo?: string;
    branch?: string;
    channelName?: string;
  }): Promise<{ runId: string; branch: string; uri: string }> {
    const state = fold(await this.log.read());
    const channelId = await ensureChannel(this.log, state, input.channelName ?? 'banto-v3');
    const runId = randomUUID();
    const branch = input.branch ?? `factory/${runId.slice(0, 8)}`;

    const factory = await this.pool.factoryFor(input.repo ?? '.');
    await factory.request({
      runId,
      channelId,
      threadId: randomUUID(),
      branch,
      request: input.request,
    });

    return { runId, branch, uri: runUri(runId) };
  }

  /**
   * 進める。**明示的に呼ばれたときだけ**（Claude の枠を使うため。要件 B4）。
   * `/api/runs/advance` と同じ——**これまでに要求されたリポジトリぶんだけ**進める。
   */
  async advanceRuns(): Promise<void> {
    for (const factory of await this.pool.allBuilt()) await factory.advanceAll();
  }

  async listRuns(): Promise<RunView[]> {
    const records = foldRuns(await this.log.read());
    const factory = await this.defaultFactory();
    return Promise.all(records.map((r) => this.describe(r, factory)));
  }

  async describeRun(runId: string): Promise<RunView | null> {
    const record = foldRuns(await this.log.read()).find((r) => r.runId === runId);
    if (record === undefined) return null;
    return this.describe(record, await this.defaultFactory());
  }

  /**
   * **単一リポジトリ運用だけを、いまは相手にする**（既知の欠落。バックログ「Run が
   * どのリポジトリを対象にしたか」）。`RunRecord` はどのリポジトリの依頼かを
   * 持たないので、複数リポジトリのときにどの `Factory` で観測すべきかを解けない。
   * `'.'` の Factory が既に組み立て済みならそれで観測し、無理なら段は
   * 「観測できない」と正直に返す（規則8：黙って片方へ寄せない）。
   */
  private async defaultFactory(): Promise<Factory | null> {
    return this.pool.factoryFor('.').catch(() => null);
  }

  private async describe(record: RunRecord, factory: Factory | null): Promise<RunView> {
    const testedCommits = [...record.tested.entries()].map(([commit, passed]) => ({ commit, passed }));
    if (factory === null) {
      return {
        runId: record.runId,
        threadId: record.threadId,
        branch: record.branch,
        request: record.request,
        failed: record.failed,
        testedCommits,
        stage: '観測できない（対象リポジトリの Factory が組み立てられていない）',
      };
    }
    try {
      const observation = await factory.observe(record);
      return {
        runId: record.runId,
        threadId: record.threadId,
        branch: record.branch,
        request: record.request,
        failed: record.failed,
        testedCommits,
        stage: nextStage(observation),
      };
    } catch (cause) {
      // 握りつぶさない（規則2）。観測できなかった理由をそのまま返す。
      return {
        runId: record.runId,
        threadId: record.threadId,
        branch: record.branch,
        request: record.request,
        failed: record.failed,
        testedCommits,
        stage: `観測できない: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }
}
