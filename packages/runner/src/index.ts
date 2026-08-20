/**
 * Runner —— ベンダに触れる唯一の接点（ADR-0001 決定6）。
 *
 * ランタイム固有の型・語彙を、この層の外に出さない。外に出るのは
 * `@banto/core` のイベントだけ。将来ランタイムを替えるとき、作り直すのはここだけになる。
 *
 * トークン規律を「気をつける」で担保しない——**契約の形で破れないようにする**：
 *  - systemPrompt は引数。走行中は変えられない
 *  - model はスレッドに紐づく。走行中に替えるとキャッシュがモデル単位で全損する
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { NewEvent, RunId, ThreadId, TurnUsage } from '@banto/core';

/** モジュールのツールインターフェース。Phase 0 ではまだ誰も渡さない。 */
export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
}

export interface RunInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  /** スレッド生存中は読み取り専用。 */
  readonly systemPrompt: string;
  /** そのスレッドに紐づくモジュールの分だけ。 */
  readonly mcpServers: readonly McpServerSpec[];
  readonly skills: readonly string[];
  /** スレッドに紐づく。変更＝新スレッド。 */
  readonly model: string;
  readonly forkFrom?: { readonly threadId: ThreadId; readonly baseVersion: number };
  readonly prompt: string;
  /** ランタイムに渡す作業ディレクトリ。 */
  readonly cwd?: string;
  readonly maxTurns?: number;
}

export interface Runner {
  run(input: RunInput): AsyncIterable<NewEvent>;
}

/**
 * Claude Agent SDK の Runner。
 *
 * 偽の実装は用意しない。偽物は本物の制約を持たないので、偽物で通っても
 * 何も分からない（教訓1）。試験も本物のプロセスで叩く。
 */
export class AgentSdkRunner implements Runner {
  async *run(input: RunInput): AsyncIterable<NewEvent> {
    yield {
      type: 'run.step',
      runId: input.runId,
      threadId: input.threadId,
      step: 'query',
      state: 'started',
    };

    /**
     * 同じ message.id を持つ assistant メッセージが複数流れてくる。
     * 応答の streaming 中、SDK は**完了した content block ごとに1通**出すためで、
     * どれも同じ累積 usage を載せている（実測：同一 id 内で usage の食い違い 0 件）。
     *
     * 数えるのは message.id 単位。行単位で数えると、実測で 1.81 倍に膨らみ、
     * 同じ文脈サイズが繰り返されて分位点まで歪む。
     */
    const seenMessageIds = new Set<string>();
    let turnIndex = 0;

    const options: Options = {
      model: input.model,
      systemPrompt: input.systemPrompt,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.mcpServers.length === 0
        ? {}
        : {
            mcpServers: Object.fromEntries(
              input.mcpServers.map((s) => [
                s.name,
                { command: s.command, args: [...(s.args ?? [])] },
              ]),
            ),
          }),
    };

    try {
      for await (const message of query({ prompt: input.prompt, options })) {
        const event = this.translate(input, message, seenMessageIds, () => turnIndex++);
        if (event) yield event;
      }
    } catch (cause) {
      // 握りつぶさない。失敗を記録してから、呼び手へ投げ直す（規則2）。
      yield {
        type: 'run.step',
        runId: input.runId,
        threadId: input.threadId,
        step: 'query',
        state: 'failed',
        detail: cause instanceof Error ? cause.message : String(cause),
      };
      throw cause;
    }
  }

  /** SDK のメッセージを banto のイベントに直す。関係ないものは null。 */
  private translate(
    input: RunInput,
    message: SDKMessage,
    seenMessageIds: Set<string>,
    nextTurnIndex: () => number,
  ): NewEvent | null {
    if (message.type === 'assistant') {
      const id = message.message.id;
      if (seenMessageIds.has(id)) return null;
      seenMessageIds.add(id);

      const usage = toTurnUsage(message.message.usage);
      if (!usage) return null;

      return {
        type: 'turn.usage',
        threadId: input.threadId,
        runId: input.runId,
        turnIndex: nextTurnIndex(),
        usage,
      };
    }

    /**
     * ランタイムが明示した圧縮。トランスクリプトには残らないので、
     * **走っている最中にここで捕まえるしかない。**
     * usage 系列から導いた発火回数と、後で突き合わせる（規則8）。
     */
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const meta = message.compact_metadata;
      return {
        type: 'compaction.reported',
        threadId: input.threadId,
        runId: input.runId,
        detail: `trigger=${meta.trigger} pre_tokens=${meta.pre_tokens} post_tokens=${meta.post_tokens ?? 'unknown'}`,
      };
    }

    if (message.type === 'result') {
      return {
        type: 'run.step',
        runId: input.runId,
        threadId: input.threadId,
        step: 'query',
        state: message.subtype === 'success' ? 'succeeded' : 'failed',
        detail:
          message.subtype === 'success'
            ? message.result
            : `subtype=${message.subtype} turns=${message.num_turns}`,
      };
    }

    return null;
  }
}

/**
 * SDK の usage を banto の形に直す。
 *
 * 欠けている項目を 0 で埋めない——埋めると「測れなかった」と「0 だった」が
 * 区別できなくなる。読めなければ null を返し、そのターンは記録しない。
 */
function toTurnUsage(usage: unknown): TurnUsage | null {
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = u['input_tokens'];
  const cacheCreation = u['cache_creation_input_tokens'];
  const cacheRead = u['cache_read_input_tokens'];
  const output = u['output_tokens'];
  if (
    typeof input !== 'number' ||
    typeof cacheCreation !== 'number' ||
    typeof cacheRead !== 'number' ||
    typeof output !== 'number'
  ) {
    return null;
  }
  return {
    inputTokens: input,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
  };
}
