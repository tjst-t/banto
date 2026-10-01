// Thread に対する1ターンを実際に走らせ、SSEで配信できる形にまとめる。
// canUseTool・onElicitationはInboxへ判断待ちとして記録し、発生した時点で
// 即座にSSEへも流す（アーキ仕様§2.4「人に聞くはElicitationに乗せる」・
// §6.0 hold-the-line）——ターンが終わってからまとめて返すのではない。

import { composeTurnPrompt } from "../delivery/thread-deliveries.js";
import type { MessageImage, UiToolCallEntry } from "../project-thread/types.js";
import type { ImageMediaType } from "../images/store.js";
import { runTurn } from "../runner/adapter.js";
import { buildSystemPrompt } from "../runner/system-prompt.js";
import { buildTurnContext } from "../runner/turn-context.js";
import { splitMemory } from "../project-thread/memory-split.js";
import { assertRelayHealthy } from "../relay/health.js";
import { createMemoryMcpServer } from "./memory-tool.js";
import { createForkMcpServer, type ForkRequest } from "./fork-tool.js";
import type { GlobalMemoryStore } from "../global-memory/store.js";
import type { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadState } from "../project-thread/types.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { TurnEventBus } from "./turn-events.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSkillSet } from "../skills/types.js";

/** Runnerが`/agent-relay/<name>`へ実HTTPで繋ぐための宛先1件。 */
export interface ModuleEndpoint {
  name: string;
  url: string;
  /** /agent-relayの認証ヘッダ（bootstrap.authTokenのbearer）。 */
  headers?: Record<string, string>;
}

export type TurnStreamEvent =
  | { type: "message"; message: unknown }
  | {
      type: "judgment";
      judgmentId: string;
      /** 承認する tool の引数（approvalのみ）。何を承認するのかを画面に出すため。 */
      toolInput?: unknown;
      /** 発信元の Module 名（elicitationのみ、§2.4.1 の MUST）。 */
      serverName?: string;
      kind: "approval" | "elicitation";
      toolName?: string;
      message: string;
    }
  | {
      type: "done";
      sessionId?: string;
      contextUsage?: unknown;
      compactionCount: number;
      /** そのターンの入出力とキャッシュの内訳（決定・2026-09-06） */
      apiUsage?: unknown;
    }
  | { type: "error"; message: string }
  /**
   * **人が止めた**（追加・2026-10-01、v4-frontend.md §6.31）。ターンの終わり。`withdrawn` があれば、AI がまだ何も
   * 出していなかったので発言ごと取り消した（記録にも AI の文脈にも残らない）——画面はその中身を入力欄へ戻す
   */
  | { type: "stopped"; withdrawn?: WithdrawnMessage }
  /**
   * **判断待ちに答えがついた**（追加・2026-09-26）。どこで答えても（別の画面・受信箱）、このターンの流れに載る
   * ——あとから繋ぎ直した画面が流し直しても、そのカードは「回答済み」として出る。`answer` は画面に出す言葉
   */
  | { type: "answered"; judgmentId: string; answer: string };

/** 取り消した発言。画像は置き場の名前だけ（画面は `/api/images/:id` から取り直せる） */
export interface WithdrawnMessage {
  text: string;
  images: MessageImage[];
}

/** 画面を持つ tool（`_meta.ui.resourceUri`）の対応表。表示の復元に使う。 */
export interface UiToolBinding {
  /** Runner から見える名前（`mcp__<Module名>__<tool名>`）。 */
  toolName: string;
  server: string;
  resourceUri: string;
  /** 会話にはカードだけを置く、と名乗った tool（`dev.banto/card`、決定・2026-10-01） */
  card?: UiToolCallEntry["card"];
}

/** 人が添えた画像1枚。**中身は置き場に置いてから**ここへ来る（記録には名前だけが残る） */
export interface TurnImage extends MessageImage {
  mediaType: ImageMediaType;
  /** base64 */
  data: string;
}

export interface RunThreadTurnInput {
  threadId: string;
  prompt: string;
  /** 人が添えた画像（決定・2026-09-26）。文と同じ発言に属する */
  images?: TurnImage[];
  modules: ModuleEndpoint[];
  cwd?: string;
  permissionMode?: Options["permissionMode"];
  /** AI 自身に伝える、いま動いているモデル（決定・2026-09-24）。分からなければ無い */
  modelIdentity?: { name: string; id: string };
  /** 画面つき tool の一覧（決定・2026-09-07）。**これに載っている呼び出しだけ**を
   *  記録する——記録の目的は Module の画面をリロード後に出し直すことなので、
   *  画面を持たない tool の結果まで残す理由が無い（会話の記録を膨らませない）。 */
  uiTools?: UiToolBinding[];
  /**
   * **人が止める合図**（追加・2026-10-01、v4-frontend.md §6.31）。立ったらすぐ CLI を止め、`stopped` で終える
   */
  stop?: AbortSignal;
}

/**
 * 1ターンを走らせ、イベントを流す。**流したものは `turnEvents` にも覚えさせる**
 * （`turn-stream-reattach`、2026-09-10）——走行中にリロードされても
 * `GET /api/threads/:id/stream` から**最初から流し直せる**ようにするため。
 * 覚えるのはここ1箇所（規則3——各 yield の場所に書き足さない）。
 */
export async function* runThreadTurn(
  deps: Parameters<typeof runThreadTurnInner>[0],
  input: RunThreadTurnInput,
): AsyncGenerator<TurnStreamEvent> {
  deps.turnEvents?.begin(input.threadId, new Date().toISOString());
  // **AI が予約した Fork**（決定・2026-09-27、§2.2「AI が Fork を立てる」）。ターンの終わりに立てる
  const forks: ForkTurnState = { reserved: [], settled: false };
  try {
    for await (const event of runThreadTurnInner(deps, input, forks)) {
      deps.turnEvents?.record(input.threadId, event);
      yield event;
    }
  } finally {
    // **どう終わってもここを通る**——終わったターンの途中経過は残さない
    deps.turnEvents?.end(input.threadId);
    // 最後まで行かなかったターンで予約されていた Fork は立てない——このターンの会話が記録に
    // 載っていないので、引き継ぐ中身が欠ける。**黙って捨てない**：人に知らせる（規則2）
    if (!forks.settled && forks.reserved.length > 0) {
      forks.settled = true;
      await deps.settleForks?.(input.threadId, forks.reserved, { ok: false }).catch((err: unknown) =>
        console.warn(`[host] ${input.threadId} で予約された Fork を片づけられませんでした:`, err),
      );
    }
  }
}

/** このターンで AI が予約した Fork（`fork-tool.ts`）と、立てたかどうか */
interface ForkTurnState {
  reserved: ForkRequest[];
  settled: boolean;
}

/**
 * セッションごとの「CLI がまだ後片づけ中」（追加・2026-09-26）。鍵はセッション id
 * ——同じ Thread の次のターンも、そこから分けた Fork の最初のターンも、同じ
 * セッションの記録を読むので、どちらもこれを待つ。終わったら消える
 */
const cliExits = new Map<string, Promise<void>>();
function rememberCliExit(sessionId: string, exited: Promise<void>): void {
  cliExits.set(sessionId, exited);
  void exited.finally(() => {
    if (cliExits.get(sessionId) === exited) cliExits.delete(sessionId);
  });
}

async function* runThreadTurnInner(
  deps: {
    projectThread: ProjectThreadStore;
    globalMemory: GlobalMemoryStore;
    inbox: InboxStore;
    pendingApprovals: PendingApprovalRegistry;
    /** ターンの外（host の中継ゲート等）で起きた判断待ちの流し込み口。 */
    turnEvents?: TurnEventBus;
    /** Runner の差し替え口（試験用）。本番は既定の `runTurn`。 */
    runTurn?: typeof runTurn;
    /**
     * **新しいセッションで効かせる Skill の集合を決める**（決定・2026-09-23、§5.7）。
     * 繋がっている Module が配っている Skill を集め、設定で絞る（cli.ts）。
     * 渡されなければ Skill は1つも効かせない。
     */
    resolveSessionSkills?(threadId: string): Promise<SessionSkillSet>;
    /**
     * **AI が予約した Fork を立てる／立てずに片づける**（決定・2026-09-27、§2.2「AI が Fork を立てる」）。
     * ターンが最後まで行ったら `ok: true`（resume-point と返事を記録したあと）、途中で終わったら `ok: false`。
     * 渡されなければ予約は受けても何もしない（試験用）
     */
    settleForks?(parentThreadId: string, forks: ForkRequest[], outcome: { ok: boolean }): Promise<void>;
  },
  input: RunThreadTurnInput,
  forks: ForkTurnState = { reserved: [], settled: false },
): AsyncGenerator<TurnStreamEvent> {
  const thread = deps.projectThread.getThread(input.threadId);
  if (!thread) {
    yield { type: "error", message: `thread ${input.threadId} not found` };
    return;
  }
  const project = deps.projectThread.getProject(thread.projectId);
  if (!project) {
    // Threadがあって Project が無いのは fold の不整合——黙って既定値で
    // 走らせない（規則2）。system prompt の層3が組めない。
    yield { type: "error", message: `project ${thread.projectId} not found for thread ${input.threadId}` };
    return;
  }

  // **効かせる Skill は、新しいセッションの最初のターンで決まる**（決定・2026-09-23、§5.7）。
  // `instructions` は `resume` では読み直されない（実測）——続きのターンで決め直しても
  // モデルには届かず、記録だけが嘘になる。**resume しないターン**（新しい会話・Clear の
  // 後）だけがここを通り、決めたものを会話に刻む。代理サーバはその記録から
  // `instructions` を作る（cli.ts の `instructionsFor`）ので、**刻むのは走らせる前**。
  // Fork は親の記録を引き継いでいる（fold）——Fork も resume なので、ここは通らない。
  // 刻むのは人の発言より前——「その発言の時点で何が効いていたか」が seq の順で引ける
  if (input.stop?.aborted) {
    // まだ何も刻んでいないうちに止められた（§6.31）——Skill も決めずに終える。取り消す中身は下で同じように返す
    const imgs = (input.images ?? []).map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) }));
    yield {
      type: "stopped",
      ...(input.prompt !== "" || imgs.length > 0 ? { withdrawn: { text: input.prompt, images: imgs } } : {}),
    };
    return;
  }
  if (thread.resumePoint === undefined && deps.resolveSessionSkills) {
    try {
      const set = await deps.resolveSessionSkills(input.threadId);
      for (const p of set.problems) console.warn(`[host] Skill（${p.module}）: ${p.message}`);
      await deps.projectThread.fixSessionSkills(input.threadId, set);
    } catch (err) {
      // **決められないまま走らせない**（規則2）——黙って「何も効かせない」会話を始めると、
      // その会話のあいだずっと効かないまま、誰も気づけない
      yield {
        type: "error",
        message: `効かせる Skill を決められませんでした: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
  }

  // **届いていたものを先に積む**（決定・2026-09-25、アーキ仕様 §4.2）。届いた順に、送り手の印つきで——人の発言
  // ではない。上限で起こさなかったものも、人が次に送ったこのターンの頭に積まれる（黙って捨てない）
  const delivered = [...(deps.projectThread.getThread(input.threadId)?.deliveries ?? [])];
  const images = input.images ?? [];
  // 画像だけの発言もある（文を書かずにスクリーンショットだけ貼る）
  const hasHumanMessage = input.prompt !== "" || images.length > 0;
  if (delivered.length === 0 && !hasHumanMessage) {
    yield { type: "error", message: "このターンに渡すもの（人の発言・届いたもの）がありません" };
    return;
  }
  const imageNames = images.map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) }));
  // **まだ何も積んでいないうちに止められた**（§6.31）——記録にも残さず、そのまま返す。届いたものは待ち行列に
  // 残っているので、次のターンの頭に積まれる
  if (input.stop?.aborted) {
    yield { type: "stopped", ...(hasHumanMessage ? { withdrawn: { text: input.prompt, images: imageNames } } : {}) };
    return;
  }
  for (const d of delivered) {
    await deps.projectThread.appendMessage(input.threadId, "user", d.text, undefined, {
      from: d.from,
      title: d.title,
      hop: d.hop,
      deliveryId: d.deliveryId,
    });
  }
  let humanSeq: number | undefined;
  if (hasHumanMessage) {
    humanSeq = await deps.projectThread.appendMessage(
      input.threadId,
      "user",
      input.prompt,
      undefined,
      undefined,
      imageNames,
    );
  }
  const prompt = composeTurnPrompt(delivered, input.prompt, images.length);

  const mcpServers: Record<string, unknown> = {};
  for (const m of input.modules) mcpServers[m.name] = { type: "http", url: m.url, headers: m.headers };
  mcpServers["banto-memory"] = createMemoryMcpServer(deps.projectThread, thread.projectId, input.threadId);
  // Base でも Fork でも同じ tool を見せる（Fork の中で呼ばれたら断る）——tool の一覧はキャッシュの先頭に
  // 入るので、変えると Fork が親のキャッシュを引き継げない（§3）
  mcpServers["banto-thread"] = createForkMcpServer(deps.projectThread, input.threadId, forks.reserved);

  // system promptに入れるのは確定した分、ターンに添えるのはそれ以降の分
  // （§2.3、決定・2026-09-05）。Project MemoryもGlobal Memoryも同じ規律・
  // 同じ物差し（Event Storeのseq）なので、分け方の判断はsplitMemoryに1つだけ置く。
  const memory = deps.projectThread.memoryForThread(input.threadId);
  const global_ = splitMemory(
    deps.globalMemory.list(),
    thread.memoryBaselineSeq,
    thread.memoryDeliveredSeq,
  );
  const turnContext = buildTurnContext({
    thread,
    pendingMemory: [...memory.pending, ...global_.pending].sort((a, b) => a.changedAtSeq - b.changedAtSeq),
    openJudgments: deps.inbox
      .listOpen()
      .filter((i): i is JudgmentItem => i.kind === "judgment" && i.threadId === input.threadId),
    startedAt: new Date(),
  });
  const deliveredUpToSeq = [...memory.pending, ...global_.pending].reduce(
    (max, m) => Math.max(max, m.changedAtSeq),
    0,
  );

  const messages: unknown[] = [];
  let sessionId: string | undefined;
  let contextUsage: unknown;
  let compactionCount = 0;
  let apiUsage: unknown;
  let deliveryRecorded = false;

  // **ターンの外から来る判断待ち**（host の中継ゲート、docs/specs/v4-frontend.md
  // 「Module 間中継の承認」）。SDK の出力を待っている最中に割り込むので、
  // 溜めておいて、下のループで SDK の続きと**どちらが先に来ても**流せるようにする。
  const sideEvents: TurnStreamEvent[] = [];
  let wakeSide: (() => void) | undefined;
  // 健全性検査で中断するときに、走り出した query を止めるための紐
  const abortTurn = new AbortController();
  // **人が止めた**（§6.31）。下のループは SDK の次を待たずにこれで抜ける
  const stopRequested = new Promise<"stop">((resolve) => {
    if (input.stop?.aborted) resolve("stop");
    else input.stop?.addEventListener("abort", () => resolve("stop"), { once: true });
  });
  let stoppedByHuman = false;
  // このターンで出した判断待ち（止めたら畳む——答えても届く先が無い）
  const raisedJudgments: string[] = [];
  // このターンのセッション（`system/init` で分かる。止めたターンには `result` が来ない）
  let initSessionId: string | undefined;
  // 親から借りたresume-pointのままなら、このターンで枝を分ける（§2.2）
  // ——分けないと親と同じセッションを共有し、会話が1本に混ざる。
  // 既に共有されてしまっているもの（2026-09-05以前に作られたFork）も、
  // ここで検知して分ける——黙って壊れたまま続けない（規則2）。
  const forkSession =
    thread.resumePoint !== undefined &&
    (!thread.ownsSession || deps.projectThread.resumePointSharedWithOtherThread(input.threadId));
  const unsubscribeSide = deps.turnEvents?.subscribeSide(input.threadId, (event) => {
    sideEvents.push(event);
    wakeSide?.();
  });
  try {
    // **前のターンの CLI が終わるまで、同じセッションを続きから走らせない**
    // （追加・2026-09-26）。ターンは答えが揃った時点で終わり、CLI の後片づけは
    // 裏で続く（`RunnerTurnResult.exited`）。ふつうは人が次を打つより先に終わっている
    if (thread.resumePoint !== undefined) await cliExits.get(thread.resumePoint);
    const gen = (deps.runTurn ?? runTurn)({
      signal: abortTurn.signal,
      resumeSessionId: thread.resumePoint,
      // 前のターンで人が発言を取り消した——CLI のセッションに書かれていても、その手前で切って続ける（§6.31）
      ...(thread.resumePoint !== undefined && thread.rewindTo ? { resumeSessionAt: thread.rewindTo } : {}),
      forkSession,
      prompt: `${turnContext}\n\n${prompt}`,
      ...(images.length > 0 ? { images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })) } : {}),
      mcpServers: mcpServers as Options["mcpServers"],
      permissionMode: input.permissionMode,
      // 人がこの Thread で選んだモデルと effort（決定・2026-09-23）。host が持つ値を
      // そのまま渡す——選んでいなければ渡さず、CLI の既定で走る
      ...(thread.model ? { model: thread.model } : {}),
      ...(thread.effort ? { effort: thread.effort } : {}),
      cwd: input.cwd,
      // system promptに入れるのはThread作成時に確定した分だけ（§2.3）。
      // 確定より後に増えた分は先頭を変えずにターンへ添える（Cで実装）。
      systemPrompt: buildSystemPrompt({
        globalMemory: global_.established.filter((m) => !m.invalidated).map((m) => m.text),
        project: { name: project.name, root: project.root },
        memory: memory.established,
        ...(input.modelIdentity ? { model: input.modelIdentity } : {}),
      }),
    });

    type Step = Awaited<ReturnType<typeof gen.next>>;
    // **1回の gen.next() を包むのは1回だけ**——race のたびに `.then` で
    // 包み直すと、負けた側の派生 Promise が誰にも読まれない rejection になる
    const settle = (p: Promise<Step>): Promise<{ step: Step } | { error: unknown }> =>
      p.then(
        (step) => ({ step }),
        (error: unknown) => ({ error }),
      );

    let pending = settle(gen.next());
    let sideSignal: Promise<"side"> | undefined;
    let result!: Extract<Step, { done: true }>["value"];
    for (;;) {
      if (sideEvents.length > 0) {
        yield sideEvents.shift()!;
        continue;
      }
      if (!sideSignal) {
        sideSignal = new Promise<"side">((resolve) => {
          wakeSide = () => {
            wakeSide = undefined;
            resolve("side");
          };
        });
      }
      const winner = await Promise.race([pending, sideSignal, stopRequested]);
      if (winner === "side") {
        sideSignal = undefined;
        continue;
      }
      if (winner === "stop" || ("error" in winner && input.stop?.aborted)) {
        // **人が止めた**（§6.31）。CLI を止め、止まるのを少しだけ待つ（止めたあとの書き込みと、次のターンの
        // resume が重ならないように）。待ち切らない——止まらなくても、このターンはここで終える
        stoppedByHuman = true;
        abortTurn.abort();
        await Promise.race([pending, new Promise((r) => setTimeout(r, STOP_SETTLE_MS))]);
        break;
      }
      if ("error" in winner) throw winner.error;
      const next = winner.step;
      if (next.done) {
        result = next.value;
        break;
      }

      const event = next.value;
      if (event.type === "message") {
        // **道具が繋がっているかは、最初に届く `system/init` で分かる**
        // （改訂・2026-09-10）。以前はターンが**終わってから**見ていたので、
        // AI は道具なしで最後まで走り、それらしい返事を書き、resume-point まで
        // 更新されていた——「守れていないのに動く」（規則2）。
        // ここで止める：記録も残さず、人には理由を返す
        const initError = relayHealthError(event.message, input.modules.map((m) => m.name));
        if (initError) {
          abortTurn.abort();
          await gen.return?.(undefined as never).catch(() => undefined);
          yield { type: "error", message: initError };
          return;
        }
        const m = event.message as { type?: string; subtype?: string; session_id?: string };
        if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
          initSessionId = m.session_id;
        }
        // AI が返した＝添えたブロックがモデルに届いた。
        // ここで初めて「届けた」を記録する——組み立てた時点で記録すると、
        // プロセスが起動できなかったときに届いていない差分を失う（規則2）。
        // **AI の返事を待つ**（改訂・2026-10-01）——以前は `system/init` で記録していた。AI が何も出さないうちに
        // 人が止めると、その発言は AI の文脈からも切り落とす（§6.31）ので、添えた差分も届いていない
        if (!deliveryRecorded && deliveredUpToSeq > 0 && m.type === "assistant") {
          deliveryRecorded = true;
          await deps.projectThread.markMemoryDelivered(input.threadId, deliveredUpToSeq);
        }
        messages.push(event.message);
        yield { type: "message", message: event.message };
      } else if (event.type === "approval_requested") {
        const judgment = await deps.inbox.raiseJudgment({
          threadId: input.threadId,
          source: "text",
          message: `tool呼び出しの承認: ${event.pending.toolName}`,
          toolCallId: event.pending.toolCallId,
          // **何を承認するのか**を一緒に残す（決定・2026-09-06、見直し起点）。
          // 引数を見せずに承認させると、runCommand を中身を見ないまま
          // 許可することになる（§6.0「サーバを呼ぶ前に人に見せる」）
          toolInput: event.pending.input,
        });
        deps.pendingApprovals.register(judgment.id, event.pending.resolve);
        raisedJudgments.push(judgment.id);
        yield {
          type: "judgment",
          judgmentId: judgment.id,
          kind: "approval",
          toolName: event.pending.toolName,
          toolInput: event.pending.input,
          message: judgment.message,
        };
      } else if (event.type === "elicitation_requested") {
        const judgment = await deps.inbox.raiseJudgment({
          threadId: input.threadId,
          source: "elicitation",
          message: event.pending.message,
          // どのサーバが聞いているか（§2.4.1 の MUST）
          serverName: event.pending.serverName,
          mode: event.pending.mode,
          requestedSchema: event.pending.requestedSchema,
          url: event.pending.url,
        });
        raisedJudgments.push(judgment.id);
        yield {
          type: "judgment",
          judgmentId: judgment.id,
          kind: "elicitation",
          serverName: event.pending.serverName,
          message: judgment.message,
        };
      }
      pending = settle(gen.next());
    }
    if (!stoppedByHuman) {
      sessionId = result.sessionId;
      if (sessionId && result.exited) rememberCliExit(sessionId, result.exited);
      contextUsage = result.contextUsage;
      compactionCount = result.compactionCount;
      apiUsage = result.apiUsage;
      // 走行が終わった後に届いた分（人が答える前にターンが終わった等）も落とさない
      while (sideEvents.length > 0) yield sideEvents.shift()!;
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  } finally {
    unsubscribeSide?.();
  }

  if (stoppedByHuman) {
    yield await settleStoppedTurn(deps, {
      threadId: input.threadId,
      thread,
      forkSession,
      messages,
      initSessionId,
      humanSeq,
      deliveredCount: delivered.length,
      withdrawn: { text: input.prompt, images: imageNames },
      raisedJudgments,
      uiTools: input.uiTools ?? [],
    });
    return;
  }

  if (sessionId) {
    // このターンの最後のやり取りも残す——次のターンで人が発言を取り消したら、ここまでで切る（§6.31）
    await deps.projectThread.updateResumePoint(input.threadId, sessionId, lastChainUuid(messages));
  }
  const assistantText = extractAssistantText(messages);
  const uiToolCalls = extractUiToolCalls(messages, input.uiTools ?? []);
  if (assistantText || uiToolCalls.length > 0) {
    await deps.projectThread.appendMessage(input.threadId, "assistant", assistantText, uiToolCalls);
  }
  await deps.projectThread.recordUsage(input.threadId, contextUsage, compactionCount, apiUsage);
  // **予約された Fork はここで立てる**——このターンの resume-point と返事を記録したあと。Fork は
  // このターンの会話を最後まで引き継ぐ（§2.2「AI が Fork を立てる」）
  if (forks.reserved.length > 0 && !forks.settled) {
    forks.settled = true;
    try {
      await deps.settleForks?.(input.threadId, forks.reserved, { ok: true });
    } catch (err) {
      console.warn(`[host] ${input.threadId} で予約された Fork を立てられませんでした:`, err);
    }
  }
  yield { type: "done", sessionId, contextUsage, compactionCount, apiUsage };
}

/**
 * 止めたあと、CLI が止まるのを待つ上限。ふつうはすぐ止まる（abort はプロセスを終わらせる）——越えても
 * ターンは終える（人を待たせない）
 */
const STOP_SETTLE_MS = 3_000;

/** 止めたとき、返事の末尾に添える一行（記録に残る——「失敗」ではなく「人が止めた」と分かるように） */
export const STOPPED_NOTE = "（ここで止めました）";

/**
 * **人が止めたターンを片づける**（決定・2026-10-01、ユーザー要望。v4-frontend.md §6.31）。
 *
 *  - **AI がまだ何も出していない**（文も tool の呼び出しも無い）なら、人の発言ごと取り消す——記録から外し、
 *    CLI のセッションに書かれていても次のターンはその手前で切って続ける。tool を呼んでいないので、何も起きていない。
 *    画面は取り消した中身を入力欄へ戻す
 *  - 取り消せないとき（出したものがある・届いたものも積んだターン・切る位置を知らない）は、そこまでに出たものを
 *    「ここで止めました」と一緒に記録する——SDK は止めたターンの出力を結果に載せないので、流れてきた分を
 *    自分で残す（アーキ仕様 §2.3「止めたターンの記録」）
 *
 * どちらでも、このターンが出した判断待ちは畳む（答えても届く先が無い）
 */
async function settleStoppedTurn(
  deps: { projectThread: ProjectThreadStore; inbox: InboxStore; pendingApprovals: PendingApprovalRegistry },
  turn: {
    threadId: string;
    /** ターンを始めたときの Thread */
    thread: ThreadState;
    forkSession: boolean;
    messages: readonly unknown[];
    initSessionId: string | undefined;
    humanSeq: number | undefined;
    deliveredCount: number;
    withdrawn: WithdrawnMessage;
    raisedJudgments: readonly string[];
    uiTools: UiToolBinding[];
  },
): Promise<TurnStreamEvent> {
  for (const id of turn.raisedJudgments) {
    const item = deps.inbox.get(id);
    if (item?.kind !== "judgment" || item.liveness !== "live") continue;
    const answer = { behavior: "deny" as const, message: "人がターンを止めました" };
    deps.pendingApprovals.resolve(id, answer);
    await deps.inbox.answerJudgment(id, answer);
  }

  const { thread } = turn;
  // このターンが続けたセッションを、どこで切ればよいか。新しいセッション（最初のターン・Clear のあと・
  // Fork の最初のターン）なら切る必要が無い——次のターンも同じところから始める
  const startsFresh = thread.resumePoint === undefined || turn.forkSession;
  const rewindTo = thread.rewindTo ?? thread.resumeAnchor;
  const withdrawable =
    turn.humanSeq !== undefined &&
    turn.deliveredCount === 0 &&
    !hasVisibleOutput(turn.messages) &&
    (startsFresh || rewindTo !== undefined);
  if (withdrawable) {
    await deps.projectThread.withdrawMessage(turn.threadId, turn.humanSeq!, startsFresh ? undefined : rewindTo);
    return { type: "stopped", withdrawn: turn.withdrawn };
  }

  // 取り消さない——CLI のセッションにはこのターンが載っているので、次はその続きから。**切る位置は残さない**
  // （途中で止めたやり取りのどこで切れば壊れないか分からない。次に最後まで走ったターンがまた残す）
  if (turn.initSessionId) await deps.projectThread.updateResumePoint(turn.threadId, turn.initSessionId);
  const text = extractAssistantText(turn.messages);
  const uiToolCalls = extractUiToolCalls(turn.messages as unknown[], turn.uiTools);
  await deps.projectThread.appendMessage(
    turn.threadId,
    "assistant",
    text ? `${text}\n\n${STOPPED_NOTE}` : STOPPED_NOTE,
    uiToolCalls,
  );
  return { type: "stopped" };
}

/** AI が人に見えるもの（文・tool の呼び出し）を出したか。考えただけ（thinking）は数えない */
function hasVisibleOutput(messages: readonly unknown[]): boolean {
  return messages.some((raw) => {
    const m = raw as { type?: string; message?: { content?: unknown } };
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) return false;
    return (m.message.content as Array<{ type?: string; text?: unknown }>).some(
      (b) => b?.type === "tool_use" || (b?.type === "text" && typeof b.text === "string" && b.text !== ""),
    );
  });
}

/**
 * **そのターンの最後のやり取り**（SDK のメッセージの uuid）。会話の鎖に載るのは assistant と user（tool の結果）
 * だけ——`system`・`result` は載らない（SDK の `resumeSessionAt` の説明）
 */
export function lastChainUuid(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: string; uuid?: unknown };
    if ((m.type === "assistant" || m.type === "user") && typeof m.uuid === "string") return m.uuid;
  }
  return undefined;
}

/**
 * `system/init` が届いた時点で、配線した代理サーバが全部繋がっているかを見る。
 * init 以外のメッセージでは何も言わない（`undefined`）。
 */
function relayHealthError(message: unknown, expectedServerNames: string[]): string | undefined {
  const m = message as { type?: string; subtype?: string };
  if (m?.type !== "system" || m?.subtype !== "init") return undefined;
  try {
    assertRelayHealthy([message] as Parameters<typeof assertRelayHealthy>[0], expectedServerNames);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** リロード時の表示復元用に、assistantのテキスト応答だけを抜き出す
 *  （決定・2026-09-04）。tool_use等SDKの内部詳細は持たない——表示に要るのは
 *  発言テキストだけ（docs/notes参照）。
 *  **文ブロックの間は段落を分ける**（改訂・2026-09-26）——SDK が別々に届ける文は別々の発言（別の応答・
 *  CLI の「API Error: …」など）。改行1つだと Markdown では同じ段落に混ざり、流れていたときの見え方
 *  （画面の `addTextBlock`）と食い違っていた */
export function extractAssistantText(messages: readonly unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const m = raw as { type?: string; message?: { content?: unknown } };
    if (m.type !== "assistant") continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n\n");
}


/**
 * そのターンで呼ばれた**画面つきの tool**を拾う（決定・2026-09-07、ユーザー報告）。
 *
 * リロードすると会話は host の記録から組み直される。記録が文章だけだと
 * **Module の画面が消える**（tool のカードごと失われる）ので、画面を出すのに
 * 要る分——どの tool を、どの引数で呼んで、何が返ったか——を残す。
 * **画面を持つ tool だけ**が対象。
 */
function extractUiToolCalls(messages: unknown[], uiTools: UiToolBinding[]): UiToolCallEntry[] {
  if (uiTools.length === 0) return [];
  const byToolName = new Map(uiTools.map((t) => [t.toolName, t]));
  const calls = new Map<string, UiToolCallEntry>();

  for (const raw of messages) {
    const message = raw as {
      type?: string;
      message?: { content?: unknown };
    };
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;

    if (message.type === "assistant") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : undefined;
        const id = typeof block.id === "string" ? block.id : undefined;
        const binding = name ? byToolName.get(name) : undefined;
        if (!id || !name || !binding) continue;
        calls.set(id, {
          toolCallId: id,
          toolName: name,
          server: binding.server,
          resourceUri: binding.resourceUri,
          ...(binding.card ? { card: binding.card } : {}),
          args: block.input,
        });
      }
    } else if (message.type === "user") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result") continue;
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const call = id ? calls.get(id) : undefined;
        if (!call) continue;
        call.result = block.is_error ? { error: block.content } : block.content;
      }
    }
  }
  return [...calls.values()];
}
