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

import { getSessionMessages, query, type SDKMessage, type PermissionResult, type Options, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ImageMediaType } from "../images/store.js";

export interface PendingToolApproval {
  /** SDKが渡してくる**本物の** tool_use id（`options.toolUseID`）。
   *  以前は`approval-N`を自前で振っていたが、それはターンごとに1から振り直され
   *  Thread内でも衝突するうえ、§2.4.1が「本実装で詰める」とした
   *  「tool_use_id で Event Store のレコードと tool 呼び出し結果を紐づける」が
   *  構造的に不可能だった（見直し・2026-09-06）。 */
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
  /** trueなら、resumeしたセッションを**そのまま続けず新しいsession idへ分岐**する
   *  （SDKの`forkSession`）。Fork Threadの最初のターンで使う——渡さないと親と
   *  同じセッションを共有し、**両方の会話が1本に混ざる**（実測・2026-09-05、§2.2）。 */
  forkSession?: boolean;
  /**
   * **resume するとき、このやり取り（SDK のメッセージの uuid）までで切る**（SDK の `resumeSessionAt`、
   * 決定・2026-10-01）。人が止めて取り消した発言（§6.31）が CLI のセッションに書かれていても、次のターンの
   * AI に見せないために使う。`resumeSessionId` と一緒にだけ意味がある
   */
  resumeSessionAt?: string;
  /**
   * **新しい会話の session id を host が先に決めて渡す**（SDK の `sessionId`、追加・2026-10-05、アーキ仕様 §2.5
   * 「起こし直しをまたいで続ける」）。UUID。`system/init` を待たずに記録できる——その前に切れても、起き直したら
   * 同じ id で走らせ直せる（実測 M2）。`resumeSessionId` とは一緒に渡さない（SDK が断る）
   */
  sessionId?: string;
  prompt: string;
  /** 人が添えた画像（決定・2026-09-26）。**縮めずに渡す**——大きいものは CLI が長辺 2000px の
   *  JPEG に縮めてから API に送る（実測・2026-09-26、`docs/notes/2026-09-26-composer-images.md`） */
  images?: Array<{ mediaType: ImageMediaType; data: string }>;
  mcpServers?: Options["mcpServers"];
  permissionMode?: Options["permissionMode"];
  /** 人がこの Thread で選んだモデル（決定・2026-09-23）。無ければ CLI の既定 */
  model?: string;
  /** 人がこの Thread で選んだ reasoning effort。無ければそのモデルの既定 */
  effort?: Options["effort"];
  cwd?: string;
  /** coreが組み立てたsystem promptの全文（§2.3、決定・2026-09-05）。
   *  `claude_code`プリセットは使わない——省略可能にすると、渡し忘れたときに
   *  黙ってプリセット（＝banto に無いtoolの説明とSDK側の記憶）へ落ちる。
   *  必須にして落ちる経路を塞ぐ（規則2）。 */
  systemPrompt: string[];
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
  /** そのターンの入出力とキャッシュの内訳（`result`メッセージの`usage`をそのまま）。
   *  **キャッシュが効いているかはここでしか分からない**——contextUsage は
   *  「どれだけ積んだか」であって「いくらで読めたか」ではない（決定・2026-09-06）。 */
  apiUsage?: unknown;
  /**
   * **CLI のプロセスが終わったら解決する**（追加・2026-09-26、実測）。
   *
   * ターンは `result` と文脈使用量が揃った時点で終わる——以前は CLI が終了する
   * まで待っていて、**答えが出そろってから入力欄が戻るまで毎ターン約 0.75 秒**
   * 余計にかかっていた（docs/notes/2026-09-25-latency-review.md §2.3）。
   * 同じセッションを続きから走らせる（resume）ときは、**これを待ってから**起こす
   * ——前の CLI がセッションの記録を書き終える前に、次の CLI が読まないように。
   * 拒否はしない（終わり際の失敗はログに書く）。
   */
  exited?: Promise<void>;
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
/**
 * Runner に生やす組み込み tool。**ここが唯一の一覧**（規則3）——
 * 試験も実物もこれを見る。理由は下の `tools:` のコメント。
 */
export const RUNNER_BUILTIN_TOOLS: string[] = [
  "WebSearch",
  "WebFetch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
];

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
  // 画像は文より前に置く（Claude は画像→文の順でよく読む。Vision のドキュメント）
  const content =
    opts.images && opts.images.length > 0
      ? [
          ...opts.images.map((image) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
          })),
          { type: "text" as const, text: opts.prompt },
        ]
      : opts.prompt;
  async function* promptStream() {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
    };
    await keepOpen;
  }

  const q = query({
    prompt: promptStream(),
    options: {
      resume: opts.resumeSessionId,
      forkSession: opts.forkSession,
      ...(opts.resumeSessionId && opts.resumeSessionAt ? { resumeSessionAt: opts.resumeSessionAt } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      mcpServers: opts.mcpServers,
      // **毎ターン組み立て直したものをそのまま使わせる**（`snapshot: false`、2026-09-24）。
      // SDK 0.3.267 から、独自の system prompt は既定で「最初の要求で記録し、以後の要求と
      // resume では記録をそのまま送る」になった——後から渡した prompt は、圧縮か新しい
      // セッションまで**黙って無視される**。banto は Memory・モデルの名前（§2.3）を core が
      // 組み立てて毎ターン渡すのが唯一の真実で、CLI 側の記録は写しになる（規則3）。
      // 中身は §3 の規律で安定させているので、毎回描き直してもキャッシュの前置きは崩れない
      systemPrompt: { type: "custom", prompt: opts.systemPrompt, snapshot: false },
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
      //
      // **resource を読む口も要る**（追加・2026-09-12、実測で発覚）。
      // アーキ仕様 §2.5・v4-modules §2.1 は「Runner は resource を直接読まず、
      // 組み込み tool（ListMcpResourcesTool/ReadMcpResourceTool）経由で
      // `resources/list`/`read` を呼ぶ——banto が同種の tool を自作する必要は
      // ない」と決めている。ところが `tools: [...]` は**基底集合の置き換え**
      // なので、この3つも一緒に落ちていた——**AI は Module の resource を
      // 1つも読めなかった**（`vault://aliases` も FileSystem の資源も、
      // 存在しないのと同じ）。仕様の前提が実装で成立していない状態だった（規則8）。
      //
      // **迂回路にはならない**：resource は Runner が実 Module に直接繋がず、
      // host の代理サーバ越しにしか読めない。代理サーバは `resources/read` の
      // ハンドラの中でも可視性を見て fail closed で拒む（`relay/visibility.ts`）。
      tools: RUNNER_BUILTIN_TOOLS,
      permissionMode: opts.permissionMode ?? "auto",
      // 1ターン＝1回の query()（モデルB、§2.3）なので、ターンごとに渡すだけで切り替わる
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      cwd: opts.cwd,
      abortController: opts.signal ? abortSignalToController(opts.signal) : undefined,
      canUseTool: (toolName, input, options) =>
        new Promise<PermissionResult>((resolve) => {
          const pending: PendingToolApproval = {
            toolCallId: options?.toolUseID ?? `approval-${++approvalSeq}`,
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
  let apiUsage: unknown;
  // qのfor-awaitは、APIエラー（529 Overloaded等）で例外を投げうる。
  // ここでawaitせず投げっぱなしにすると、Node側でunhandled rejectionと
  // なりホスト全体が落ちる——1ターンの失敗が全Projectの接続を道連れに
  // してしまう（規則2違反）。catchしてqueueへ伝搬し、呼び出し側
  // （turn-runner.ts）の既存のtry/catchでSSEの`error`イベントに変換する。
  let capturedError: unknown;
  // `result` を受け取り、文脈使用量まで揃ったか——ここから先は CLI の後片づけ
  let answered = false;
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  void (async () => {
    try {
      for await (const message of q) {
        if (answered) {
          // 実測では何も来ない（2026-09-26）。来たら**黙って捨てずに**書き残す（規則2）
          console.warn(
            `[runner] 答えが出そろった後に CLI から ${message.type}${"subtype" in message ? `/${String(message.subtype)}` : ""} が届きました（セッション ${sessionId ?? "?"}）。ターンは終わっているので記録していません`,
          );
          continue;
        }
        queue.push({ type: "message", message });
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }
        if (message.type === "system" && message.subtype === "compact_boundary") {
          compactionCount += 1;
        }
        if (message.type === "result") {
          apiUsage = (message as { usage?: unknown }).usage;
          try {
            contextUsage = await q.getContextUsage();
          } catch {
            // Claude backend限定の機能——別backendでは無いことを明示的な値で返す
            // （アーキ仕様§4.1「無いものは無いという明示的な値を返す」）。
            contextUsage = undefined;
          }
          closeInput();
          // **ここでターンを終える**（改訂・2026-09-26、実測）——入力を閉じてから
          // CLI のプロセスが終わるまで約 0.75 秒かかり、その間に届くものは無い。
          // 終わるのは裏で待つ（`exited`）
          answered = true;
          queue.close();
        }
      }
    } catch (err) {
      if (answered) {
        // 答えはもう記録に入る。**握りつぶさずに書き残す**（規則2）——次のターンの
        // resume が壊れていれば、そちらが理由つきで落ちる
        console.warn(
          `[runner] 答えが出そろった後、CLI の終わり際に失敗しました（セッション ${sessionId ?? "?"}）: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        capturedError = err;
      }
    }
    queue.close();
    markExited();
  })();

  yield* queue.iterate();

  if (capturedError) throw capturedError;
  return { sessionId, contextUsage, compactionCount, apiUsage, exited };
}

/**
 * **止めて取り消す発言の、1つ手前のやり取り**（追加・2026-10-02、v4-frontend.md §6.31）。切る位置を覚えていない会話
 * （この仕組みより前から続く会話・止めたターンが続いた会話）で、SDK の公式の口（`getSessionMessages`、会話の鎖を
 * parentUuid でたどったもの）から引く。
 *
 *  - 送った発言（`sentPrompt` と文が同じ最後の user）が鎖にあれば、その1つ前。先頭なら切れない（`undefined`）
 *  - 見つからなければ（まだ書かれていない・文の形が違う）、鎖の末尾に並ぶ人の側の文（送った発言・中断の印。tool の結果は
 *    除く）を飛ばしたその手前——止めたのは AI がまだ何も出していないときだけなので、末尾の人の側の文はこのターンのもの。
 *    「鎖の最後」にすると、文の形が食い違ったときに取り消した発言そのものを切る位置にしてしまう
 *
 * 読めなければ投げる（呼ぶ側は取り消さずに止めるだけにする）
 */
export async function findRewindBeforePrompt(
  sessionId: string,
  sentPrompt: string,
  dir?: string,
): Promise<string | undefined> {
  let chain = await getSessionMessages(sessionId, dir ? { dir } : {});
  // 置き場の名前の付け方が食い違うと空が返る——全部から探し直す
  if (chain.length === 0 && dir) chain = await getSessionMessages(sessionId);
  if (chain.length === 0) throw new Error(`セッション ${sessionId} の会話の記録が読めません`);
  const textOf = (message: unknown): string => {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
      .map((b) => b.text)
      .join("");
  };
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!;
    if (m.type === "user" && textOf(m.message) === sentPrompt) return i > 0 ? chain[i - 1]!.uuid : undefined;
  }
  const isToolResult = (message: unknown): boolean => {
    const content = (message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) && content.some((b) => (b as { type?: string })?.type === "tool_result");
  };
  let i = chain.length - 1;
  while (i >= 0 && chain[i]!.type === "user" && !isToolResult(chain[i]!.message)) i--;
  return i >= 0 ? chain[i]!.uuid : undefined;
}

function abortSignalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

/**
 * **選べるモデルの一覧を CLI に聞く**（決定・2026-09-23、`runner/models.ts`）。
 *
 * 発言は送らない——入力の流れを開いたまま `supportedModels()` だけを尋ね、答えを
 * 受けたら閉じる。API は呼ばれない（実測・2026-09-23、約0.8秒）。
 * ターンと同じく、人の設定・MCP・組み込み tool は混ぜない。
 */
export async function listModels(): Promise<ModelInfo[]> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* nothing(): AsyncGenerator<never> {
    await hold;
  }
  const abortController = new AbortController();
  const q = query({
    prompt: nothing(),
    options: { settingSources: [], strictMcpConfig: true, tools: [], abortController },
  });
  try {
    return await q.supportedModels();
  } finally {
    release();
    abortController.abort();
  }
}

