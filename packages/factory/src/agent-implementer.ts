/**
 * 実装するサブエージェント（要件 B3、ADR-0001 決定10）。
 *
 * **ここが Factory とランタイムの接点**だが、ベンダに触れるのは Runner だけ（決定6）。
 * この層が知っているのは「Runner に頼む」ことと「流れてきたイベントをログに積む」ことだけ。
 *
 * ## 実装ターンも観測に載せる（決定8）
 *
 * Runner が出す `turn.usage` を**そのままイベントログに積む**。積まないと、
 * **Factory が使った分だけ観測から抜ける**——「文脈が単調に増え続けていないか」を
 * 見る仕組み（要件 F1）に、いちばん長く走るものが映らないことになる。
 *
 * ## 会話は Run の Thread に紐づく（仕様 §5.1）
 *
 * Run は Thread を1つ持つので、セッション識別子も base もそのまま効く。
 * 落ちて再開したとき、**会話も続きから走る**（要件 B5）——ここが
 * 「新しい会話の器を作らない」ことの実利である。
 */

import {
  EventLog,
  effectiveBase,
  fold,
  type NewEvent,
  type ThreadId,
} from '@banto/core';
import { AgentSdkRunner, allowedToolNames, type McpServerSpec } from '@banto/runner';

import type { EnvironmentPort, Implementer, RunPlan } from './ports.js';

export interface AgentImplementerOptions {
  readonly log: EventLog;
  readonly modules: readonly McpServerSpec[];
  readonly toolsByModule: ReadonlyMap<string, readonly string[]>;
  readonly model: string;
  /** 作業ツリーの絶対パスを解く。Repo の root を知っているのは呼び手だけ。 */
  readonly absoluteWorkdir: (workdir: string) => string;
  readonly maxTurns?: number;
  /**
   * モジュールのツール以外に許すもの（要件 D4）。
   *
   * **既定を持たせない。** 実装するには編集とコマンド実行が要るが、それを
   * 既定で通すと「Factory を紐づけた瞬間に、何でも実行できるようになる」。
   * 何を許したかが**設定に1行として残っている**ことに意味がある（C8c と同じ）。
   *
   * ランタイム内蔵のツール（`Read` / `Write` / `Edit` / `Bash` 等）はここに書く。
   * これらは Runner に渡した `cwd`——つまり**その Run の作業ツリー**——で動く。
   */
  readonly extraAllowedTools?: readonly string[];
}

/**
 * サブエージェントに実装させる。
 *
 * **「実装した」という自己申告を信じない**（規則1）。この関数は commit を確かめない
 * ——確かめるのは engine で、`isAhead` という**現物の観測**で見る。
 * ここで自分の仕事を自分で検分すると、検分も一緒に壊れる（通底する原則）。
 */
export class AgentImplementer implements Implementer {
  constructor(private readonly options: AgentImplementerOptions) {}

  async implement(plan: RunPlan, _handle: string, _env: EnvironmentPort): Promise<void> {
    const { log, model, modules, toolsByModule, absoluteWorkdir } = this.options;

    const before = fold(await log.read());
    const thread = before.threads.get(plan.threadId as ThreadId);
    const base = effectiveBase(before, plan.threadId).join('\n');

    const queryId = `${plan.runId}:${String(thread?.turnCount ?? 0)}`;

    for await (const event of new AgentSdkRunner().query({
      threadId: plan.threadId,
      queryId,
      systemPrompt:
        'You are a banto factory worker. Implement the request in the working directory, ' +
        'then commit your work with git. Be concise.' +
        (base === '' ? '' : `\n\n# この作業で決まっていること\n${base}`),
      mcpServers: modules,
      skills: [],
      model,
      allowedTools: [
        ...allowedToolNames(modules, toolsByModule),
        ...(this.options.extraAllowedTools ?? []),
      ],
      // **作業ツリーの中で走らせる。** ここを間違えると、別の場所を触りに行く。
      cwd: absoluteWorkdir(plan.workdir),
      maxTurns: this.options.maxTurns ?? 40,
      // 落ちて再開したとき、会話も続きから（要件 B5）。
      ...(thread?.sessionHandle == null ? {} : { resumeFrom: thread.sessionHandle }),
      startTurnIndex: thread?.turnCount ?? 0,
      prompt: plan.request,
    })) {
      // **流れてきたものをそのまま積む。** 画面用にも観測用にも別の形を作らない（規則3）。
      await log.append(event as NewEvent);
    }
  }
}
