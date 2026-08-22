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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { NewEvent, QueryId, ThreadId, TurnUsage } from '@banto/core';

/**
 * モジュールのツールインターフェース。
 *
 * **境界はモジュールごとに選ぶ**（要件 C8b）。契約は MCP のままで、
 * in-process と subprocess のどちらでも同じツールが見える。
 *
 * ここがベンダ形式へ写す唯一の場所。module-kit は標準の MCP サーバを作るだけで、
 * Agent SDK を知らない（決定6）。
 */
export type McpServerSpec =
  | { readonly name: string; readonly kind: 'in-process'; readonly server: McpServer }
  | {
      readonly name: string;
      readonly kind: 'subprocess';
      readonly command: string;
      readonly args?: readonly string[];
    };

/**
 * ツールの許可（要件 D4）。**明示的に許した範囲に限られる。**
 * 既定では MCP のツールは1つも通らない——実測で、渡さないと権限で断られる。
 */
// **`.name` しか見ない**——引数は `McpServerSpec` に限らず、名前を持つものなら何でもよい
// （`apps/host` の `ModuleFactory` のように、まだ `McpServer` を作っていないものも渡せる）。
export function allowedToolNames(
  specs: readonly { readonly name: string }[],
  tools: ReadonlyMap<string, readonly string[]>,
): string[] {
  return specs.flatMap((spec) => (tools.get(spec.name) ?? []).map((t) => `mcp__${spec.name}__${t}`));
}

export interface QueryInput {
  readonly threadId: ThreadId;
  readonly queryId: QueryId;
  /** スレッド生存中は読み取り専用。 */
  readonly systemPrompt: string;
  /** そのスレッドに紐づくモジュールの分だけ。 */
  readonly mcpServers: readonly McpServerSpec[];
  readonly skills: readonly string[];
  /** スレッドに紐づく。変更＝新スレッド。 */
  readonly model: string;
  /**
   * 前のターンの続きから走る（要件 A2）。ランタイムのセッション識別子を渡す。
   * **渡さなければ新しく始まる**——base から切る fork がこれ（要件 R1 の既定）。
   */
  readonly resumeFrom?: string;
  /**
   * 続きから走りつつ、**別のセッションとして枝分かれする**（要件 R1 の明示オプション）。
   * `resumeFrom` と一緒に使う。単独では意味を持たない。
   */
  readonly forkSession?: boolean;
  /**
   * このスレッドで既に済んでいるターン数。**turnIndex はここから続ける。**
   *
   * run() ごとに 0 から振り直すと、observer が index で並べ替えたときに
   * 2回目以降のターンが1回目に混ざり、文脈サイズの系列が壊れる。
   */
  readonly startTurnIndex?: number;
  readonly prompt: string;
  /** ランタイムに渡す作業ディレクトリ。 */
  readonly cwd?: string;
  readonly maxTurns?: number;
  /** 明示的に許すツール名（`mcp__<server>__<tool>`）。渡さなければ MCP ツールは通らない。 */
  readonly allowedTools?: readonly string[];
  /**
   * 組み込みツール（`Read`／`Bash`／`Edit` など）のうち、モデルに**見せる**もの
   * （要件 D4、実測 2026-08-22）。
   *
   * **`allowedTools` は見せる／見せないの話ではない**——SDK の型定義いわく
   * "auto-allowed without prompting"、つまり確認を省くだけで、組み込みツール自体は
   * `allowedTools` に無くてもモデルから見えたままになる。呼ぶと許可判定に回り、
   * `canUseTool` を渡していない banto では即座に断られるだけなので、
   * モデルは「人に許可を求めれば通る」と誤解し、チャットで許可を求め続ける
   * ——実際に会話の相手が経験した壊れ方（README を開こうとして許可ループに入った）。
   *
   * **見せること自体を止めるのがここ**（SDK の `tools` オプション）。
   * 渡さなければ空——banto と話す人向けの会話は組み込みツールを1つも見ない。
   * Factory の worker のように実際にコードを書く役だけが、必要な名前を明示して渡す。
   */
  readonly builtinTools?: readonly string[];
}

/**
 * **`run` ではなく `query` である。** ここが指すのはランタイムへの1回の問い合わせで、
 * Factory の Run（依頼1件ぶんの耐久ワークフロー）とは別物（`QueryId` を見よ）。
 */
export interface Runner {
  query(input: QueryInput): AsyncIterable<NewEvent>;
}

/**
 * Claude Agent SDK の Runner。
 *
 * 偽の実装は用意しない。偽物は本物の制約を持たないので、偽物で通っても
 * 何も分からない（教訓1）。試験も本物のプロセスで叩く。
 */
export class AgentSdkRunner implements Runner {
  async *query(input: QueryInput): AsyncIterable<NewEvent> {
    yield {
      type: 'query.step',
      queryId: input.queryId,
      threadId: input.threadId,
      status: 'started',
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
    let turnIndex = input.startTurnIndex ?? 0;
    // セッション識別子は一度だけ記録する。毎ターン同じものが載っているため。
    let recordedSession: string | null = null;

    const options: Options = {
      model: input.model,
      systemPrompt: input.systemPrompt,
      /**
       * **ホストの起動ディレクトリを信用しない**（規則8で見つかった食い違い、実測 2026-08-22）。
       *
       * SDK は既定で `cwd` の `CLAUDE.md`／`.claude/settings.json` を自動で読み、
       * `allowedTools` を一切経由せずモデルの文脈に混ぜる（型定義：
       * "When omitted, all sources are loaded"）。banto は「許した mcp__ ツールの
       * 外には出ない」設計だが、この読み込みはその枠の外で起きるので、
       * ホストをどこから起動したかで無関係な指示が漏れ入る
       * ——実際に、この開発リポジトリ直下から起こしたら人向けの会話が
       * 開発者向け CLAUDE.md を知ってしまった。
       *
       * **空配列で完全に切る。** banto が渡すのは `systemPrompt` と
       * `mcpServers`／`allowedTools` だけ——文脈の入り口を1つに保つ（規則3）。
       */
      settingSources: [],
      // **既定値を持たない**（`allowedTools` と同じ考え）。渡さなければ組み込みツールは
      // 1つもモデルから見えない——安全側に倒れる既定（渡し忘れても穴が開かない）。
      tools: input.builtinTools === undefined ? [] : [...input.builtinTools],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
      ...(input.mcpServers.length === 0
        ? {}
        : {
            mcpServers: Object.fromEntries(
              input.mcpServers.map((s) => [
                s.name,
                s.kind === 'in-process'
                  ? ({ type: 'sdk', name: s.name, instance: s.server } as const)
                  : ({ type: 'stdio', command: s.command, args: [...(s.args ?? [])] } as const),
              ]),
            ),
          }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: [...input.allowedTools] }),
      ...(input.resumeFrom === undefined ? {} : { resume: input.resumeFrom }),
      ...(input.forkSession === true ? { forkSession: true } : {}),
    };

    try {
      for await (const message of query({ prompt: input.prompt, options })) {
        // ランタイムのセッション識別子。**解釈せず、そのまま記録する。**
        // これが無いと次のターンを続きから走らせられない（要件 A2）。
        const handle = (message as { session_id?: unknown }).session_id;
        if (recordedSession === null && typeof handle === 'string' && handle !== '') {
          recordedSession = handle;
          yield {
            type: 'thread.session',
            threadId: input.threadId,
            queryId: input.queryId,
            sessionHandle: handle,
          };
        }

        for (const event of this.translate(input, message, seenMessageIds, () => turnIndex++)) {
          yield event;
        }
      }
    } catch (cause) {
      // 握りつぶさない。失敗を記録してから、呼び手へ投げ直す（規則2）。
      yield {
        type: 'query.step',
        queryId: input.queryId,
        threadId: input.threadId,
        status: 'failed',
        detail: cause instanceof Error ? cause.message : String(cause),
      };
      throw cause;
    }
  }

  /**
   * SDK のメッセージを banto のイベントに直す。関係ないものは空。
   *
   * **1通から2つ出ることがある**（usage と文面）。usage は観測の材料、文面は
   * 読み返しのため（要件 A8）で、**別の理由で要るものなので別のイベントにする。**
   *
   * **試験のために公開している。** ここは「同じ id の複数通をどう畳むか」という、
   * 本物を1回走らせただけでは気づけない種類の間違いが起きる場所だった
   * （下の注記）。壊れ方が目に見えなかったので、形を試験で固定する。
   */
  translate(
    input: QueryInput,
    message: SDKMessage,
    seenMessageIds: Set<string>,
    nextTurnIndex: () => number,
  ): NewEvent[] {
    if (message.type === 'assistant') {
      const events: NewEvent[] = [];

      /**
       * **文面は「毎通から」拾い、usage は「id ごとに1回だけ」数える。**
       *
       * ここを同じ扱いにすると壊れる。実測（2026-08-21）：
       * ```
       * assistant id=msg_011Ce… blocks=[{"type":"thinking"}]
       * assistant id=msg_011Ce… blocks=[{"type":"text","len":2}]
       * ```
       * **同じ id の1通目に本文が無い。** 最初に書いたときは id で重複除去してから
       * 本文を見ていたので、`thinking` だけを見て「本文なし」と判断していた
       * ——送信中は画面に出るのに、開き直すと相手の発言だけ消えていた。
       *
       * これは**ターン数を 1.81 倍に膨らませたのと同じ現象**（この上の注記）が、
       * 逆向きに効いた例である。数えるものは畳み、拾うものは畳まない。
       *
       * `thinking` と `tool_use` / `tool_result` は入れない——前者は出すべきでなく、
       * 後者は量が桁違いでログが肥える。
       */
      const text = message.message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      if (text !== '') {
        events.push({
          type: 'message.recorded',
          threadId: input.threadId,
          queryId: input.queryId,
          role: 'assistant',
          text,
        });
      }

      const id = message.message.id;
      if (!seenMessageIds.has(id)) {
        seenMessageIds.add(id);
        const usage = toTurnUsage(message.message.usage);
        if (usage) {
          events.push({
            type: 'turn.usage',
            threadId: input.threadId,
            queryId: input.queryId,
            turnIndex: nextTurnIndex(),
            usage,
          });
        }
      }
      return events;
    }

    /**
     * ランタイムが明示した圧縮。トランスクリプトには残らないので、
     * **走っている最中にここで捕まえるしかない。**
     * usage 系列から導いた発火回数と、後で突き合わせる（規則8）。
     */
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const meta = message.compact_metadata;
      return [{
        type: 'compaction.reported',
        threadId: input.threadId,
        queryId: input.queryId,
        detail: `trigger=${meta.trigger} pre_tokens=${meta.pre_tokens} post_tokens=${meta.post_tokens ?? 'unknown'}`,
      }];
    }

    if (message.type === 'result') {
      return [{
        type: 'query.step',
        queryId: input.queryId,
        threadId: input.threadId,
        status: message.subtype === 'success' ? 'succeeded' : 'failed',
        detail:
          message.subtype === 'success'
            ? message.result
            : `subtype=${message.subtype} turns=${message.num_turns}`,
      }];
    }

    return [];
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
