// docs/specs/v4-architecture.md §2.3（Runner）・§2.4.1（判断待ち）・
// §6.0「承認ゲートの一時停止は電話を切らずに待つモデルで実装する」の実装。
//
// モデルB：1ターン＝1回の query() 呼び出し、resume で継続。
// canUseTool は hold-the-line（Promiseを解決しないまま長時間待たせてよい、
// poc/04-canusetool-hold-the-line/ で実測済み）。
// onElicitation は「その場の呼び出し自体はタイムアウトに委ねる」——
// banto は onElicitation 発火時点でInboxに記録するだけで、
// 呼び出し自体を保留し続けようとはしない（§2.4.1の決定、
// poc/02-item13-parked-elicitation/ で「呼び出し自体を保留する」は
// 成立しないと実測済み）。

import { query, type SDKMessage, type PermissionResult, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface PendingToolApproval {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve(result: PermissionResult): void;
}

export interface PendingElicitation {
  toolCallId: string;
  serverName: string;
  message: string;
  mode: "form" | "url";
  requestedSchema?: unknown;
  url?: string;
}

export interface RunnerTurnOptions {
  /** 前のターンの resume 識別子。新規Threadはundefined。 */
  resumeSessionId?: string;
  prompt: string;
  mcpServers?: Options["mcpServers"];
  permissionMode?: Options["permissionMode"];
  cwd?: string;
  /** G3——Memory toolを常時アタッチする際の使い方指示（turn-runner.tsが組み立てる）。 */
  systemPromptAppend?: string;
  /** hold-the-lineモデル——呼び出し側がいつ解決するか決める。 */
  onToolApprovalRequested?(pending: PendingToolApproval): void;
  /** 発火時点でInboxに記録するだけ。呼び出し自体の保留はSDK/Moduleに委ねる。 */
  onElicitation?(pending: PendingElicitation): void;
  signal?: AbortSignal;
}

export interface RunnerTurnResult {
  sessionId?: string;
  /** F2「文脈サイズと圧縮の発火回数を数値で返す」——実測で存在を確認した
   *  query.getContextUsage() をそのまま使う（規則12）。 */
  contextUsage?: unknown;
  compactionCount: number;
}

/**
 * 順序を保ったまま非同期に押し込む・取り出す最小のキュー。
 * canUseTool/onElicitationのコールバックは`q`のfor-awaitループとは
 * 別のタイミング（SDK内部の制御チャネル）で発火するため、両方を同じ
 * キューに押し込むことで「実際に起きた順」をそのままストリームにできる。
 */
class PushQueue<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffered.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      if (this.buffered.length > 0) {
        yield this.buffered.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

export type RunTurnEvent =
  | { type: "message"; message: SDKMessage }
  | { type: "approval_requested"; pending: PendingToolApproval }
  | { type: "elicitation_requested"; pending: PendingElicitation };

/**
 * 1ターン＝1回の query() 呼び出し。流れてきたメッセージ・承認待ち・
 * Elicitationを起きた順に逐次yieldする（実際にリアルタイムで届く——
 * ターン全体が終わってからまとめて返す旧実装は、承認待ちの発生を
 * フロントに即座に伝えられなかった、規則1違反に近い状態だった）。
 * 最後の`return`で`{sessionId, contextUsage, compactionCount}`を返す
 * （記録＝Event Store化は呼び出し側の責任、アーキ仕様§2.3の原則）。
 */
export async function* runTurn(opts: RunnerTurnOptions): AsyncGenerator<RunTurnEvent, RunnerTurnResult> {
  const queue = new PushQueue<RunTurnEvent>();
  let sessionId: string | undefined;
  let approvalSeq = 0;

  // getContextUsage()はプロセス間の追加リクエスト——「result」を受け取った
  // 直後、入力側のstreamをまだ閉じていない間しか応答が返らないと実測した
  // （閉じるとプロセスが即終了し "Query closed before response received"）。
  // そのため、prompt を文字列ではなくasync generatorにして、
  // getContextUsage()を取り終えるまで入力streamを開いたままにする。
  let closeInput!: () => void;
  const keepOpen = new Promise<void>((resolve) => {
    closeInput = resolve;
  });
  async function* promptStream() {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: opts.prompt },
      parent_tool_use_id: null,
    };
    await keepOpen;
  }

  const q = query({
    prompt: promptStream(),
    options: {
      resume: opts.resumeSessionId,
      mcpServers: opts.mcpServers,
      systemPrompt: opts.systemPromptAppend
        ? { type: "preset", preset: "claude_code", append: opts.systemPromptAppend }
        : undefined,
      // SDKの既定はopt-out（渡していないMCPも~/.claude.json等からマージされる）。
      // banto の Module境界はhostが渡すmcpServersだけで完結すべきなので、
      // OSユーザーの個人設定・project .mcp.json・pluginを一切混ぜない
      // （実際にAccuWeather/Gmail等の個人MCPが混入する不具合を実測して発覚、2026-09-04）。
      strictMcpConfig: true,
      settingSources: [],
      // 組み込みtool（Bash/WebSearch/WebFetch/Skill実行等）はSDKの既定で
      // 全て有効——banto ではShellへの経路はLandlockで絞ったShell Module
      // 経由でしか許さない設計なので、組み込みBash等が生えていると経路を
      // 素通りできてしまう。tools: [...] は「指定したものだけ有効」という
      // 置き換え指定（追加ではない）なので、Bash等は自動的に無効のまま。
      // WebSearch/WebFetchはネットワークアクセスであってファイルシステム・
      // シェル実行の迂回路にはならないため許可する（決定・2026-09-04）。
      tools: ["WebSearch", "WebFetch"],
      permissionMode: opts.permissionMode ?? "auto",
      cwd: opts.cwd,
      abortController: opts.signal ? abortSignalToController(opts.signal) : undefined,
      canUseTool: (toolName, input) =>
        new Promise<PermissionResult>((resolve) => {
          const pending: PendingToolApproval = {
            toolCallId: `approval-${++approvalSeq}`,
            toolName,
            input,
            resolve,
          };
          opts.onToolApprovalRequested?.(pending);
          queue.push({ type: "approval_requested", pending });
        }),
      // Elicitationは、記録した時点で「呼び出しは走ったまま」にする——
      // 明示的にdecline/cancelを即座に返さない（§2.4.1の帰結1）。
      // ここで返すPromiseを解決しないまま放置すると、Module側の
      // タイムアウト（既定60秒）で自然にエラーとして扱われる。
      onElicitation: async (request) => {
        const pending: PendingElicitation = {
          toolCallId: `elicitation-${++approvalSeq}`,
          serverName: request.serverName ?? "",
          message: request.message ?? "",
          mode: request.mode ?? "form",
          requestedSchema: (request as { requestedSchema?: unknown }).requestedSchema,
          url: (request as { url?: string }).url,
        };
        opts.onElicitation?.(pending);
        queue.push({ type: "elicitation_requested", pending });
        // 意図的に解決しない Promise を返す——タイムアウトに委ねる。
        return new Promise(() => {});
      },
    },
  });

  let compactionCount = 0;
  let contextUsage: unknown;
  // qのfor-awaitは、APIエラー（529 Overloaded等）で例外を投げうる。
  // ここでawaitせず投げっぱなしにすると、Node側でunhandled rejectionと
  // なりホスト全体が落ちる——1ターンの失敗が全Projectの接続を道連れに
  // してしまう（規則2違反）。catchしてqueueへ伝搬し、呼び出し側
  // （turn-runner.ts）の既存のtry/catchでSSEの`error`イベントに変換する。
  let capturedError: unknown;
  void (async () => {
    try {
      for await (const message of q) {
        queue.push({ type: "message", message });
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }
        if (message.type === "system" && message.subtype === "compact_boundary") {
          compactionCount += 1;
        }
        if (message.type === "result") {
          try {
            contextUsage = await q.getContextUsage();
          } catch {
            // Claude backend限定の機能——別backendでは無いことを明示的な値で返す
            // （アーキ仕様§4.1「無いものは無いという明示的な値を返す」）。
            contextUsage = undefined;
          }
          closeInput();
        }
      }
    } catch (err) {
      capturedError = err;
    }
    queue.close();
  })();

  yield* queue.iterate();

  if (capturedError) throw capturedError;
  return { sessionId, contextUsage, compactionCount };
}

function abortSignalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
