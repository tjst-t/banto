/**
 * worker の core。**サブエージェントを1人動かす**（要件 C5 の WorkerPool、決定17）。
 *
 * 前の実装で「職人」と呼んでいたものにあたる。4層（PO ／ 番頭 ／ Kobo ／ 職人）のうち
 * **仕事をする側**で、v3 では Factory のコンストラクタ引数に格下げされていたのを、
 * 名前と格つきで戻したもの。**独自語は持ち込まず `worker` と呼ぶ**（規則11）。
 *
 * ## ここが Runner に触れる唯一のモジュールである
 *
 * 決定6 は「ランタイム固有の型・語彙を外に出さない」と定めている。**このモジュールは
 * 中核同梱なので Runner を内側で握ってよい**が、外へ出すのは MCP のツールだけで、
 * `QueryInput` も `SDKMessage` も口には現れない（要件 C13：口は他のモジュールと同じ）。
 *
 * ## 流れてきたイベントは、そのままログに積む
 *
 * 積まないと **Factory が使った分だけ観測から抜ける**——「文脈が単調に増え続けて
 * いないか」を見る仕組み（要件 F1）に、いちばん長く走るものが映らないことになる。
 */

import {
  EventLog,
  effectiveBase,
  fold,
  type NewEvent,
  type ThreadId,
} from '@banto/core';
import { AgentSdkRunner, allowedToolNames, type McpServerSpec } from '@banto/runner';

export interface WorkOrder {
  readonly threadId: ThreadId;
  /** この仕事の識別子。**呼び手が決める**——同じ仕事を二度呼んでも同じ id になるように。 */
  readonly queryId: string;
  readonly request: string;
  /** 走らせる場所。**ここを間違えると、別のディレクトリを触りに行く。** */
  readonly cwd: string;
}

export interface WorkResult {
  readonly turns: number;
  readonly succeeded: boolean;
  readonly detail: string;
}

export interface WorkerOptions {
  readonly log: EventLog;
  readonly model: string;
  readonly mcpServers: readonly McpServerSpec[];
  readonly toolsByModule: ReadonlyMap<string, readonly string[]>;
  /**
   * モジュールのツール以外に許すもの（要件 D4）。**既定を持たせない。**
   *
   * 実装には編集とコマンド実行が要るが、既定で通すと「worker を載せた瞬間に
   * 何でも実行できる」ことになる。**何を許したかが設定に1行として残っている**
   * ことに意味がある（C8c と同じ考え）。
   */
  readonly extraAllowedTools?: readonly string[];
  readonly maxTurns?: number;
  /**
   * 前のターンの続きから走るか。
   *
   * **既定は続きから走る**（要件 B5）。前の実装は memoryless だったので、
   * **設計の意図は反転している**（規則8 の記録）。2026-08-21 に PO が裁定。
   *
   * **測ってから決めた**（`memory.measure.test.ts`）。落ちた後の2回目で、
   * 仕事の出来は同じ（4/4 対 4/4）、費用は memoryless が約1.6倍、
   * 文脈は膨らまない。前の実装が memoryless にした理由——番頭の文脈を
   * 汚さない——は、**Run ごとに専用の Thread を持つ v3 では構造で解けている**。
   *
   * つまみは残す。覆すときの根拠と、測っていない場合は ADR 決定17 にある。
   */
  readonly resumeConversation?: boolean;
}

export class WorkerCore {
  constructor(private readonly options: WorkerOptions) {}

  /**
   * 1人働かせる。**「やった」という自己申告は返さない。**
   *
   * 返すのはターン数と、ランタイムが言った成否だけ。**仕事が済んだかどうかを
   * 判定するのは頼んだ側**で、現物（commit が在るか等）を見て決める
   * ——自分の仕事を自分で検分すると、検分も一緒に壊れる（通底する原則）。
   */
  async work(order: WorkOrder): Promise<WorkResult> {
    const { log, model, mcpServers, toolsByModule } = this.options;

    const before = fold(await log.read());
    const thread = before.threads.get(order.threadId);
    if (!thread) throw new Error(`知らないスレッド: ${order.threadId}`);
    const base = effectiveBase(before, order.threadId).join('\n');

    let turns = 0;
    let succeeded = false;
    let detail = '';

    for await (const event of new AgentSdkRunner().query({
      threadId: order.threadId,
      queryId: order.queryId,
      systemPrompt:
        'You are a banto worker. Do the requested work in the working directory, ' +
        'then commit it with git. Be concise.' +
        (base === '' ? '' : `\n\n# この作業で決まっていること\n${base}`),
      mcpServers,
      skills: [],
      model,
      allowedTools: [
        ...allowedToolNames(mcpServers, toolsByModule),
        ...(this.options.extraAllowedTools ?? []),
      ],
      // **`allowedTools` は確認を省くだけで、見せるかどうかは別**（`packages/runner` 参照）。
      // ここは実際にコードを書く役なので、許した組み込みツールをそのまま見せる。
      builtinTools: this.options.extraAllowedTools ?? [],
      cwd: order.cwd,
      maxTurns: this.options.maxTurns ?? 40,
      ...(this.options.resumeConversation !== false && thread.sessionHandle !== null
        ? { resumeFrom: thread.sessionHandle }
        : {}),
      startTurnIndex: thread.turnCount,
      prompt: order.request,
    })) {
      // **流れてきたものをそのまま積む。** 画面用にも観測用にも別の形を作らない（規則3）。
      await log.append(event as NewEvent);
      if (event.type === 'turn.usage') turns += 1;
      if (event.type === 'query.step' && event.status !== 'started') {
        succeeded = event.status === 'succeeded';
        detail = event.detail ?? '';
      }
    }

    return { turns, succeeded, detail };
  }
}
