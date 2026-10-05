// docs/specs/v4-architecture.md §2.5「Runner は実 Module に直接繋がない」の実装。
// poc/05-module-relay-topology・poc/06-resource-prompt-relay で実証済みの設計:
// host が実Moduleへの接続を1本だけ持ち、Runnerには低レベルServerで組んだ
// 代理サーバを見せる。`createSdkMcpServer`は使わない（toolしか受け付けない）。
//
// Runnerとこの代理サーバの間は実HTTPで繋ぐ（決定・2026-09-03、
// docs/notes/2026-09-03-agent-relay-http-transport.md）——in-processの
// `{type:'sdk', instance}`ではElicitationが機能しないため。この関数は
// Serverオブジェクトを組み立てるだけで、HTTP transportへの接続は
// agent-relay-endpoint.ts が行う。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ErrorCode,
  McpError,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CALL_ID_META_KEY,
  CALLER_META_KEY,
  PENDING_REPLY_META_KEY,
  REPLY_TO_META_KEY,
  THREAD_META_KEY,
  AUTO_APPROVE_META_KEY,
  deliversLater,
  fillCardText,
  stripBantoMeta,
  toolCardOf,
  uiResourceUriOf,
  visibilityOf,
  waitingOnOf,
  type BantoModuleMeta,
  type WaitingOn,
} from "@banto/module-contract";
import type { BackgroundWork } from "../delivery/reply-handles.js";

/**
 * **Claude Code が tool 呼び出しに添える tool_use の id**（Claude Code の `_meta` の名前。banto のものではない）。
 * 会話の記録の toolCallId と同じ値なので、バックグラウンドの仕事を「会話のどのカードか」に結びつけられる
 * （2026-10-03 に同梱 CLI で確かめた）。Runner が渡さなければ結びつけない——推測しない
 */
const RUNNER_TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

/** 札を出すとき、人に見せる手がかりを呼び出しから作る（Module には聞かない） */
function backgroundWorkOf(
  tool: { name: string; _meta?: Record<string, unknown> },
  args: Record<string, unknown> | undefined,
  requestMeta: Record<string, unknown> | undefined,
): BackgroundWork {
  const card = toolCardOf(tool);
  const toolUseId = requestMeta?.[RUNNER_TOOL_USE_ID_META_KEY];
  const resourceUri = uiResourceUriOf(tool);
  const title = fillCardText(card?.title, args);
  const description = fillCardText(card?.description, args);
  return {
    toolName: tool.name,
    ...(typeof toolUseId === "string" && toolUseId !== "" ? { toolCallId: toolUseId } : {}),
    ...(resourceUri ? { resourceUri } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}
import { makeResourceVisibilityResolver } from "./visibility.js";
import { APPROVAL_PROGRESS_INTERVAL_MS } from "./host-relay-endpoint.js";
import type { ModuleCallTracker } from "./module-calls.js";
import type { ElicitationRouter } from "./elicitation-router.js";

export interface RelayRecord {
  direction: "list" | "call" | "read";
  name: string;
  allowed: boolean;
}

export interface AgentProxyOptions {
  onRelay?(record: RelayRecord): void;
  /**
   * この接続がどのターンのものか（agent-relay-endpoint.ts が
   * `x-banto-thread-id` から取る）と、走行中の呼び出しの台帳。
   * **Module 間中継の承認を、正しい会話に出すために要る**
   * ——Module→host の中継接続は Thread を知らない（relay/module-calls.ts）。
   */
  threadId?: string;
  /** そのターンがどの Project のものか。**host が渡す**（Module に聞かない）。 */
  projectId?: string;
  moduleCalls?: ModuleCallTracker;
  /**
   * Module が進捗も返事も寄こさないまま待つ上限（ミリ秒、既定は MCP の60秒）。人の答えを待つ間は数えない。
   * 試験が短くするためのもの（追加・2026-10-04）
   */
  toolIdleTimeoutMs?: number;
  /** 人の答えを待つ間、Runner へ進捗を送る間隔（ミリ秒、既定10秒）。試験が短くするためのもの（追加・2026-10-05） */
  humanWaitProgressIntervalMs?: number;
  /** Module からの問いを、正しいターンへ届けるための宛先表。 */
  elicitations?: ElicitationRouter;
  /**
   * **`initialize` の応答に載せる `instructions`**（決定・2026-09-23、§5.6）。
   * Runner はこれをモデルの文脈の冒頭に入れる（実測）。**組み立てるのは core**
   * （`skills/instructions.ts`）——実 Module が自分の `instructions` を返しても、
   * それは転送しない（Module に文脈を占領させない）。
   */
  instructions?: string;
  /**
   * **返信用の札**（決定・2026-09-25、アーキ仕様 §4.2）。「終わったら届ける」と名乗った tool
   * （`dev.banto/deliversLater`）を呼ぶときに、このターンの Thread に結びついた札を出して渡す。
   * 結果が「あとで届ける」（`dev.banto/pendingReply`）なら、札を返事待ちにする
   */
  /**
   * **その Project で「承認をすべて自動で許可する」がオンか**（追加・2026-10-05、v4-frontend.md §6.4）。オンなら Module への
   * 呼び出しに `dev.banto/autoApprove` を刻む（呼び出しのたびに引く）。渡されなければ刻まない
   */
  autoApproveFor?(projectId: string): boolean;
  replies?: {
    issue(input: { threadId: string; projectId?: string; connName: string; moduleName: string; work?: BackgroundWork }): string;
    /** `waitingOn`：Module が「人の答えを待っている」と名乗ったら（`dev.banto/waitingOn`） */
    markAwaiting(replyTo: string, waitingOn?: WaitingOn): Promise<void>;
  };
}

export interface AgentProxy {
  server: Server;
  /**
   * **Runner がもう答えを受け取れない呼び出しを止める**（追加・2026-10-05、`agent-relay-endpoint.ts`）。
   * 渡すのは JSON-RPC の id。止めると Module への呼び出しも取り消され、台帳から外れる——中継の承認は畳まれる
   */
  abortCalls(requestIds: ReadonlyArray<string | number>, reason: string): void;
  close(): Promise<void>;
}

export interface ModuleConnection {
  /** 接続の名前（Project ごとの Module は `<宣言の名前>-<projectId>`）。 */
  name: string;
  /**
   * 宣言の名前——**Runner から見える名前**（`mcp__<これ>__…`）。Skill はこの名前で
   * 修飾する（§5.7）。無ければ `name` と同じ（instance に1本の Module）。
   */
  declaredName?: string;
  client: Client;
  meta: BantoModuleMeta;
}

/**
 * Runner向けの代理サーバを組む。`agent`可視性のtool/resourceだけを
 * 転送する——「フィルタで隠す」のではなく「最初から存在しない」。
 */
export function buildAgentProxy(conn: ModuleConnection, opts: AgentProxyOptions = {}): AgentProxy {
  const server = new Server(
    { name: conn.name, version: "0.0.0" },
    {
      capabilities: { tools: {}, resources: {} }, // prompts は宣言しない（poc/06実測、CLIが呼ばない）
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    },
  );
  const visibilityResolver = makeResourceVisibilityResolver(conn.client);

  // 実Module（conn.client の先）が elicitInput() を呼んだとき、それを受けるのは
  // hostの持つ実Client接続——そのままではRunnerに届かない。転送は要るが、
  // **ハンドラを代理サーバごとに付けると最後の1つが上書きしてしまう**
  // （並行ターンで問いが別の会話に出る）。**宛先の決定は router に集約する**
  // （relay/elicitation-router.ts、決定・2026-09-10）。
  opts.elicitations?.register(conn, opts.threadId, server);

  /**
   * **この接続が誰のためのものか**（決定・2026-09-13）。AI の代理接続は必ず
   * ターンの中なので、Project が分かる。**分からなければ刻まない**
   * ——受け手はそれを「決められない」として fail closed で止める（規則2）。
   */
  function callerStamp(): Record<string, unknown> {
    return opts.projectId ? { [CALLER_META_KEY]: { project: opts.projectId } } : {};
  }

  /**
   * **どの Thread のターンからの呼び出しか**（追加・2026-10-03、`THREAD_META_KEY`）。Project と Thread の
   * 両方が分かるときだけ刻む——片方では「どこで取り組んだか」を言えない
   */
  function threadStamp(): Record<string, unknown> {
    return opts.projectId && opts.threadId
      ? { [THREAD_META_KEY]: { projectId: opts.projectId, threadId: opts.threadId } }
      : {};
  }

  /**
   * **人に聞かずに許可してよいか**（追加・2026-10-05、`AUTO_APPROVE_META_KEY`）。その Project のスイッチがオンのときだけ刻む
   * ——Module はスイッチを知らないので、人を待つもの（Publish の公開の承認）はこれを見る。**AI の引数からは渡らない**
   * （ここで組む `_meta` は host が作り直したもので、Runner が添えた `_meta` は Module に流さない）
   */
  function autoApproveStamp(): Record<string, unknown> {
    return opts.projectId && opts.autoApproveFor?.(opts.projectId) === true ? { [AUTO_APPROVE_META_KEY]: true } : {};
  }

  /** 台帳が振った呼び出しの印（`CALL_ID_META_KEY`）。台帳が無ければ渡さない */
  function callIdStamp(id: string | undefined): Record<string, unknown> {
    return id ? { [CALL_ID_META_KEY]: id } : {};
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const real = await conn.client.listTools();
    const visible = real.tools.filter((t) => visibilityOf(t as { _meta?: Record<string, unknown> }) === "agent");
    opts.onRelay?.({ direction: "list", name: "tools/list", allowed: true });
    return { tools: visible.map((t) => stripBantoMeta(t as Tool & { _meta?: Record<string, unknown> })) };
  });

  /** 走っている tool 呼び出し（JSON-RPC の id → 止める口）。`abortCalls` が使う */
  const running = new Map<string | number, AbortController>();

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // 名前がRunnerに見えていたことを信じない——毎回ライブに再確認する。
    const real = await conn.client.listTools();
    const target = real.tools.find((t) => t.name === request.params.name);
    const allowed = target !== undefined && visibilityOf(target as { _meta?: Record<string, unknown> }) === "agent";
    opts.onRelay?.({ direction: "call", name: request.params.name, allowed });
    if (!allowed) {
      throw new Error(`tool "${request.params.name}" は agent 可視性ではありません`);
    }

    const progressToken = extra._meta?.progressToken;
    // **このハンドラが動いている間だけ**、この Module はこのターンの仕事をしている
    // ——中継の承認をどの会話に出すかは、これで決まる（relay/module-calls.ts）
    const endCall =
      // **Thread が無くても在籍は立てる**（訂正・2026-09-15）。`begin` は
      // 元から `threadId: undefined` を受ける設計（「どの会話か分からないが、
      // 誰の意思で始まったかは分かる」）なのに、ここが Thread を必須にしていた
      // ——**Project は分かっているのに刻印が付かない**ので、中で他 Module を
      // 呼ぶ resource（横断した一覧）が「誰のためか分からない」で止まっていた。
      // 承認が要る中継は `threadFor` が `none` を返すので、今までどおり
      // fail closed のまま
      opts.moduleCalls?.beginCall(conn.name, opts.threadId, "turn", opts.projectId);
    // **終わったら届ける tool には、呼び出し元の Thread に結びついた札を渡す**（追加・2026-09-25）。
    // Thread が分からない接続では出さない——Module は「届ける先が無い」と断る（規則2）
    const replyTo =
      opts.replies && opts.threadId && deliversLater(target as { _meta?: Record<string, unknown> })
        ? opts.replies.issue({
            threadId: opts.threadId,
            ...(opts.projectId ? { projectId: opts.projectId } : {}),
            connName: conn.name,
            moduleName: conn.declaredName ?? conn.name,
            work: backgroundWorkOf(
              target as { name: string; _meta?: Record<string, unknown> },
              request.params.arguments,
              request.params._meta as Record<string, unknown> | undefined,
            ),
          })
        : undefined;
    // **上限は host が自分で数える**（追加・2026-10-04、ユーザー報告「publishService が承認待ちで止まる」）。
    // 既定の60秒は、Module が黙ったまま返さないときの見張り。ところが Module の中の中継が人の承認を待つ間も
    // 数えていたので、人が60秒で答えないと外側が切れ、承認のカードもターンと一緒に消えていた。Module の進捗で
    // 数え直すのは今までどおり、**人の答えを待っている間（台帳の holdForHuman）は数えない**
    //
    // **同じ Module のほかの呼び出しが人を待っている間も数えない**（追加・2026-10-05、
    // docs/notes/2026-10-05-relay-stale-card.md）。Module が中で書き込みを並べていると、この呼び出しは人を待つ
    // 呼び出しの後ろで黙って待つ（Backlog で実測——2本目の書き込みが60秒で -32001 になった）
    const watchdog = new AbortController();
    running.set(extra.requestId, watchdog);
    const idleLimit = opts.toolIdleTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    const waitingOnHuman = () =>
      !!endCall &&
      !!opts.moduleCalls &&
      (opts.moduleCalls.isWaitingOnHuman(conn.name, endCall.id) || opts.moduleCalls.isModuleWaitingOnHuman(conn.name));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (waitingOnHuman()) {
          arm();
          return;
        }
        watchdog.abort(new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: idleLimit }));
      }, idleLimit);
    };
    arm();
    // **人を待っている間は、Runner へ進捗を送る**（追加・2026-10-05、同ノート）。Runner（Claude Code 2.1.281）は
    // 返事も進捗も来ない呼び出しを**300秒で諦め、しかも host に取り消しを送らない**（実測）——host はその呼び出しが
    // 続いていると思い続け、承認のカードが畳まれずに残り、同じ組み合わせの次の呼び出しはそこに相乗りしていた。
    // 人を待っているのを知っているのは host なので、host が送る（Module に流し直させない）。
    // **待っている間は上限も数え直す**——数え直さないと、人を待ち終えた瞬間に、待つ前から数えていた分で切れる
    // （同じ Module の後ろで待っていた呼び出しが、前の呼び出しが畳まれた直後に切れた。実測）
    const heartbeat = setInterval(() => {
      if (!waitingOnHuman()) return;
      arm();
      if (progressToken === undefined) return;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: 0, message: "人の承認を待っています" },
        })
        .catch(() => undefined);
    }, opts.humanWaitProgressIntervalMs ?? APPROVAL_PROGRESS_INTERVAL_MS);
    heartbeat.unref();
    const onOuterAbort = () => watchdog.abort(extra.signal.reason);
    if (extra.signal.aborted) onOuterAbort();
    else extra.signal.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const result = await conn.client.callTool(
        {
          name: request.params.name,
          arguments: request.params.arguments,
          // **誰のための呼び出しかを host が刻む**（追加・2026-09-13）
          // **この呼び出しの印も渡す**（追加・2026-09-28）——Module が中で中継を呼ぶとき、この1件を名指せる
          // **どの Thread のターンかも刻む**（追加・2026-10-03）——Backlog が「取り組んだ Thread」を残す
          _meta: {
            ...callerStamp(),
            ...threadStamp(),
            ...autoApproveStamp(),
            ...callIdStamp(endCall?.id),
            ...(replyTo ? { [REPLY_TO_META_KEY]: replyTo } : {}),
          },
        },
        undefined,
        {
          signal: watchdog.signal,
          // SDK の上限は使わない（上の見張りが数える）。setTimeout に渡せる最大
          timeout: 2 ** 31 - 1,
          onprogress: (progress) => {
            arm();
            if (progressToken !== undefined) {
              void extra.sendNotification({
                method: "notifications/progress",
                params: { ...progress, progressToken },
              });
            }
          },
        },
      );
      // **「あとで届ける」と約束したら、札を返事待ちにする**——Module が止まったら host が代わりに知らせる
      if (replyTo && (result as { _meta?: Record<string, unknown> })._meta?.[PENDING_REPLY_META_KEY] === true) {
        await opts.replies!.markAwaiting(
          replyTo,
          waitingOnOf((result as { _meta?: Record<string, unknown> })._meta),
        );
      }
      return stripBantoMeta(result as { _meta?: Record<string, unknown> }) as typeof result;
    } finally {
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      running.delete(extra.requestId);
      extra.signal.removeEventListener("abort", onOuterAbort);
      endCall?.end();
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const real = await conn.client.listResources().catch(() => ({ resources: [] }));
    const visible = real.resources.filter(
      (r) => visibilityOf(r as { _meta?: Record<string, unknown> }) === "agent",
    );
    return { resources: visible.map((r) => stripBantoMeta(r as { _meta?: Record<string, unknown> })) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const real = await conn.client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));
    const visible = real.resourceTemplates.filter(
      (t) => visibilityOf(t as { _meta?: Record<string, unknown> }) === "agent",
    );
    return {
      resourceTemplates: visible.map((t) => stripBantoMeta(t as { _meta?: Record<string, unknown> })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    // resourceはtoolと違い一覧に無くても直接読めてしまう非対称がある
    // （poc/06実測）——visibility解決はfail closed。
    const visibility = await visibilityResolver(request.params.uri);
    const allowed = visibility === "agent";
    opts.onRelay?.({ direction: "read", name: request.params.uri, allowed });
    if (!allowed) {
      throw new Error(`resource "${request.params.uri}" は読めません（visibility=${visibility}）`);
    }
    // **読み取りの最中も、この Module はこのターンの仕事をしている**
    // （追加・2026-09-12）。tool 呼び出しには前からこれが有ったが、resource の
    // 読み取りには無かった——**中で他 Module を呼ぶ resource**（横断した一覧を
    // 作る窓口など）は、承認ゲートが「どのターンからの呼び出しか特定できません」
    // で**構造的に必ず拒否される**状態だった。
    const endCall =
      // **Thread が無くても在籍は立てる**（訂正・2026-09-15）。`begin` は
      // 元から `threadId: undefined` を受ける設計（「どの会話か分からないが、
      // 誰の意思で始まったかは分かる」）なのに、ここが Thread を必須にしていた
      // ——**Project は分かっているのに刻印が付かない**ので、中で他 Module を
      // 呼ぶ resource（横断した一覧）が「誰のためか分からない」で止まっていた。
      // 承認が要る中継は `threadFor` が `none` を返すので、今までどおり
      // fail closed のまま
      opts.moduleCalls?.beginCall(conn.name, opts.threadId, "turn", opts.projectId);
    try {
      const result = await conn.client.readResource({
        uri: request.params.uri,
        _meta: { ...callerStamp(), ...callIdStamp(endCall?.id) },
      });
      return stripBantoMeta(result as { _meta?: Record<string, unknown> }) as typeof result;
    } finally {
      endCall?.end();
    }
  });

  return {
    server,
    abortCalls(requestIds, reason) {
      for (const id of requestIds) running.get(id)?.abort(new McpError(ErrorCode.ConnectionClosed, reason));
    },
    close: () => server.close(),
  };
}
