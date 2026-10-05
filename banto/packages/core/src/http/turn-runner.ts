// Thread に対する1ターンを実際に走らせ、SSEで配信できる形にまとめる。
// canUseTool・onElicitationはInboxへ判断待ちとして記録し、発生した時点で
// 即座にSSEへも流す（アーキ仕様§2.4「人に聞くはElicitationに乗せる」・
// §6.0 hold-the-line）——ターンが終わってからまとめて返すのではない。

import { randomUUID } from "node:crypto";
import { composeTurnPrompt } from "../delivery/thread-deliveries.js";
import type { MessageImage, UiToolCallEntry } from "../project-thread/types.js";
import type { ImageMediaType } from "../images/store.js";
import { findRewindBeforePrompt, runTurn } from "../runner/adapter.js";
import { buildSystemPrompt } from "../runner/system-prompt.js";
import { buildTurnContext } from "../runner/turn-context.js";
import { splitMemory } from "../project-thread/memory-split.js";
import { assertRelayHealthy } from "../relay/health.js";
import { createMemoryMcpServer } from "./memory-tool.js";
import { createForkMcpServer, type ForkRequest } from "./fork-tool.js";
import type { ThreadMessaging } from "../delivery/thread-messages.js";
import type { GlobalMemoryStore } from "../global-memory/store.js";
import type { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadState, TurnOutcome } from "../project-thread/types.js";
import { notInterruptedReason, type InterruptedTurn } from "../project-thread/interrupted-turns.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { AUTO_APPROVED_ANSWER_TEXT, raiseAutoApprovedJudgment } from "../inbox/auto-approve.js";
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
      /** 答えの選択肢（追加・2026-10-01）。無ければ「許可する／拒否する」 */
      choices?: string[];
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
  /**
   * **起こし直しで続けたターンなら、何回目の続きか**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで
   * 続ける」）。`turn.started` に残し、続けて切れた回数の上限に使う。ふつうのターンは無い（0）。**本番では渡さない**
   * ——続きのターンの値は待ち行列の続き（`TurnContinuation.attempt`）が持つ。渡せばそれを使う（試験用）
   */
  attempt?: number;
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
  // **ターンの進み具合**（追加・2026-10-05、アーキ仕様 §2.5）。始めたら id が入る——終わりはここで1回だけ書く
  const turn: TurnProgress = {};
  let outcome: TurnOutcome = "failed";
  try {
    for await (const event of runThreadTurnInner(deps, input, forks, turn)) {
      if (event.type === "done") outcome = "completed";
      else if (event.type === "stopped") outcome = "stopped";
      else if (event.type === "error") outcome = "failed";
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
    // **どう終わっても書く**（最後まで・人が止めた・失敗・呼び出し側が途中で読むのをやめた）。書けなければ、
    // 起き直したときに切れたターンに見える——黙らずに書き残す（規則2）。人が止めたときは止めると決めた時点で
    // 先に書いている（`turn.ended`）——二度は書かない
    if (turn.id !== undefined && !turn.ended) {
      await deps.projectThread
        .endTurn(input.threadId, turn.id, outcome)
        .catch((err: unknown) => console.warn(`[host] ${input.threadId} のターンの終わりを記録できませんでした:`, err));
    }
  }
}

/** 始めたターンの id（`turn.started` を書いたら入る）。書く前に終わったターンは持たない */
interface TurnProgress {
  id?: string;
  /** `turn.ended` をもう書いた（人が止めたとき、止めると決めた時点で書く） */
  ended?: boolean;
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
    /** 取り消す発言の手前を CLI の記録から引く口の差し替え（試験用）。本番は `findRewindBeforePrompt` */
    findRewindPoint?: typeof findRewindBeforePrompt;
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
    /** **Thread 間・Project 間のメッセージ**（決定・2026-10-01、§4.2）。渡されなければ tool は断る */
    messaging?: ThreadMessaging;
    /**
     * **その Project で「承認をすべて自動で許可する」がオンか**（追加・2026-10-05、v4-frontend.md §6.4）。承認のたびに
     * 引く——保存した時点で、走っているターンにも次の承認から効く。渡されなければ今までどおり人に聞く
     */
    autoApproveAll?(projectId: string): boolean;
  },
  input: RunThreadTurnInput,
  forks: ForkTurnState = { reserved: [], settled: false },
  turn: TurnProgress = {},
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
  // **起こし直しで切れたターンの続き**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。続きは
  // 送り手 banto の届いたものとして待ち行列の先頭に並び、続ける会話と `attempt` を持っている。切れたターンが自分の
  // 会話を書いていたならそれを続け（`resume`）、新しい会話の最初のターンが書く前に切れたなら同じ id で最初から
  // （`fresh`、実測 M2）。その会話を人が Clear で捨てていたら使わない（Thread の今の会話で走る）。**人が送ったターン
  // でも同じ**——続きが待ち行列にあれば（自動で続けるのをやめて留めていた・起き直した直後に人が先に送った）、
  // そのターンが切れた会話を引き継ぐ
  const continuation = thread.deliveries?.find((d) => d.continues)?.continues;
  const session =
    continuation?.session &&
    !thread.abandonedSessions.includes("resume" in continuation.session ? continuation.session.resume : continuation.session.fresh)
      ? continuation.session
      : undefined;
  /** このターンが続ける会話（無ければ新しい会話） */
  const resumeFrom = session ? ("resume" in session ? session.resume : undefined) : thread.resumePoint;
  if (resumeFrom === undefined && deps.resolveSessionSkills) {
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
  // **ターンを始めたことを、発言を積むより先に残す**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで
  // 続ける」）。このターンで積む発言は、これより後ろの seq になる。ここから先はどう終わっても `turn.ended` を書く
  // （`runThreadTurn` の finally）。新しい会話なら session id を host が先に決めて渡す——`system/init` の前に
  // 切れても、起き直したら同じ id で走らせ直せる（実測 M2）。**Fork の最初のターンも決める**（改訂・2026-10-05、
  // Fable のレビュー）——分けた先の会話の id は `system/init` まで分からず、その前に切れると続ける会話を失う。
  // SDK は `forkSession` と一緒なら `sessionId` を受ける（偽の API のプローブで確かめた、経緯ノート）
  //
  // 親から借りたresume-pointのままなら、このターンで枝を分ける（§2.2）
  // ——分けないと親と同じセッションを共有し、会話が1本に混ざる。
  // 既に共有されてしまっているもの（2026-09-05以前に作られたFork）も、
  // ここで検知して分ける——黙って壊れたまま続けない（規則2）。
  const forkSession =
    session === undefined &&
    thread.resumePoint !== undefined &&
    (!thread.ownsSession || deps.projectThread.resumePointSharedWithOtherThread(input.threadId));
  const assignedSessionId = session
    ? "fresh" in session
      ? session.fresh
      : undefined
    : thread.resumePoint === undefined || forkSession
      ? randomUUID()
      : undefined;
  // 巻き戻しの位置は Thread の resume-point の会話のもの——切れたターンの会話を続けるときは付けない
  const rewindTo = session === undefined && thread.resumePoint !== undefined ? thread.rewindTo : undefined;
  turn.id = await deps.projectThread.startTurn(input.threadId, {
    cause: hasHumanMessage ? "human" : "delivery",
    // 人が送ったターンは続きを引き継いでも 0 から数える（人が見て動かした——§2.5「上限」）
    attempt: input.attempt ?? (hasHumanMessage ? 0 : (continuation?.attempt ?? 0)),
    ...(resumeFrom !== undefined ? { resumePoint: resumeFrom } : {}),
    ...(rewindTo ? { rewindTo } : {}),
    ...(assignedSessionId ? { sessionId: assignedSessionId } : {}),
    ...(continuation ? { continues: { turnId: continuation.turnId, fromSeq: continuation.fromSeq } } : {}),
  });
  // 画面に出す「走り始めた時刻」も、記録に残した始まりにそろえる（2つの時刻を持たない）。始まりの seq は流し直しの
  // 境界——このターンの AI の発言は、これより後ろの記録に書き終えるごとに入る（画面は流し直す分を記録から外す）
  const started = deps.projectThread.getThread(input.threadId)?.lastTurn;
  if (started) deps.turnEvents?.markStarted(input.threadId, started.startedAt, started.startedSeq);
  for (const d of delivered) {
    await deps.projectThread.appendMessage(input.threadId, "user", d.text, undefined, {
      from: d.from,
      title: d.title,
      hop: d.hop,
      deliveryId: d.deliveryId,
      // 別の Thread からのメッセージは送り元も残す——画面が「どこから来たか」を出す（§4.2）
      ...(d.sender ? { sender: d.sender } : {}),
    });
  }
  // 続きを引き継いだ——「自動で続けるのをやめました」のお知らせは片づける（もう人の判断を待っていない）。片づけられなく
  // てもターンは止めない（続きはもう待ち行列に無いので、留めは外れている。お知らせの「続ける」は断られる）
  if (continuation) {
    await deps.inbox
      .acknowledgeResumeNotices(input.threadId, continuation.turnId)
      .catch((err: unknown) => console.warn(`[host] ${input.threadId} の「続ける」のお知らせを片づけられませんでした:`, err));
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
  mcpServers["banto-thread"] = createForkMcpServer(deps.projectThread, input.threadId, forks.reserved, deps.messaging);

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
    // **生きているものだけ**（訂正・2026-10-04、ユーザー報告）。期限切れ（host の再起動で畳んだ等）は受信箱の記録には
    // 残るが、もう誰も答えを待っていない——以前は数えていて、片づいた承認がいつまでも「まだ返事が無い」に出ていた
    openJudgments: deps.inbox
      .listOpen()
      .filter((i): i is JudgmentItem => i.kind === "judgment" && i.liveness === "live" && i.threadId === input.threadId),
    startedAt: new Date(),
  });
  const deliveredUpToSeq = [...memory.pending, ...global_.pending].reduce(
    (max, m) => Math.max(max, m.changedAtSeq),
    0,
  );

  const messages: unknown[] = [];
  // **AI の発言は書き終えるごとに記録へ足す**（追加・2026-10-05、アーキ仕様 §2.5）——ターンの最後にまとめて書くと、
  // 途中で host が落ちたら AI の返事が1つも残らない
  const replies = new ReplyRecorder(deps.projectThread, input.threadId, input.uiTools ?? []);
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
  const unsubscribeSide = deps.turnEvents?.subscribeSide(input.threadId, (event) => {
    // ターンの外で出た判断待ち（中継の承認・Project をまたぐメッセージの承認）も、止めたら畳む
    if (event.type === "judgment") raisedJudgments.push(event.judgmentId);
    sideEvents.push(event);
    wakeSide?.();
  });
  try {
    // **前のターンの CLI が終わるまで、同じセッションを続きから走らせない**
    // （追加・2026-09-26）。ターンは答えが揃った時点で終わり、CLI の後片づけは
    // 裏で続く（`RunnerTurnResult.exited`）。ふつうは人が次を打つより先に終わっている
    if (resumeFrom !== undefined) await cliExits.get(resumeFrom);
    const gen = (deps.runTurn ?? runTurn)({
      signal: abortTurn.signal,
      resumeSessionId: resumeFrom,
      // 前のターンで人が発言を取り消した——CLI のセッションに書かれていても、その手前で切って続ける（§6.31）
      ...(rewindTo ? { resumeSessionAt: rewindTo } : {}),
      ...(assignedSessionId ? { sessionId: assignedSessionId } : {}),
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
        // **止めたことを、CLI を止めるより先に残す**（追加・2026-10-05、Fable のレビュー）。止めたあとの片づけ
        // （取り消し・resume-point・返事の記録）の途中で host が落ちても、起き直したときに「切れた」として続けない
        // ——人が止めたターンを勝手に続けない。書けなくても CLI は止める（終わりは finally がもう一度書こうとする）
        try {
          await deps.projectThread.endTurn(input.threadId, turn.id, "stopped");
          turn.ended = true;
        } catch (err) {
          console.warn(`[host] ${input.threadId} の止めた印を記録できませんでした:`, err);
        }
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
          // 会話の id を残す（最初のターンでも）。resume-point は変えない——今どおりターンの最後に書く
          await deps.projectThread.recordTurnSessionKnown(input.threadId, turn.id, m.session_id);
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
        await replies.add(event.message);
        yield { type: "message", message: event.message };
      } else if (event.type === "approval_requested") {
        const raise = {
          threadId: input.threadId,
          source: "text" as const,
          message: `tool呼び出しの承認: ${event.pending.toolName}`,
          toolCallId: event.pending.toolCallId,
          // **何を承認するのか**を一緒に残す（決定・2026-09-06、見直し起点）。
          // 引数を見せずに承認させると、runCommand を中身を見ないまま
          // 許可することになる（§6.0「サーバを呼ぶ前に人に見せる」）
          toolInput: event.pending.input,
        };
        // **承認をすべて自動で許可する**（追加・2026-10-05、v4-frontend.md §6.4）。判断待ちは出して、そのまま host が
        // 答える——会話には答え済みのカードが残り、何を自動で通したかが読める。受信箱に未解決は残らない
        if (deps.autoApproveAll?.(thread.projectId) === true) {
          const judgment = await raiseAutoApprovedJudgment(deps.inbox, raise);
          event.pending.resolve({ behavior: "allow" });
          yield {
            type: "judgment",
            judgmentId: judgment.id,
            kind: "approval",
            toolName: event.pending.toolName,
            toolInput: event.pending.input,
            message: judgment.message,
          };
          yield { type: "answered", judgmentId: judgment.id, answer: AUTO_APPROVED_ANSWER_TEXT };
          pending = settle(gen.next());
          continue;
        }
        const judgment = await deps.inbox.raiseJudgment(raise);
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
    // 書き終えた発言は記録にある。結果が来ないまま切れた画面つきの呼び出しも書いておく（黙って落とさない）。書けなければ
    // 書き残してから、元の失敗を返す
    const unanswered = replies.takePending();
    if (unanswered.length > 0) {
      await deps.projectThread
        .appendMessage(input.threadId, "assistant", "", unanswered)
        .catch((e: unknown) => console.warn(`[host] ${input.threadId} の画面つきの呼び出しを記録できませんでした:`, e));
    }
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  } finally {
    unsubscribeSide?.();
  }

  if (stoppedByHuman) {
    yield await settleStoppedTurn(deps, {
      threadId: input.threadId,
      // 切れたターンの会話を続けたなら、その会話を始めたときの Thread として見る（どこで切るか・新しい会話か）
      thread: session ? { ...thread, resumePoint: resumeFrom, rewindTo: undefined, resumeAnchor: undefined } : thread,
      ...(session && "resume" in session ? { continuedSession: session.resume } : {}),
      forkSession,
      messages,
      replies,
      initSessionId,
      humanSeq,
      deliveredCount: delivered.length,
      withdrawn: { text: input.prompt, images: imageNames },
      raisedJudgments,
      sentPrompt: `${turnContext}\n\n${prompt}`,
      cwd: input.cwd,
    });
    return;
  }

  // 返事は書き終えるごとに書いてある。結果が来ないまま終わった画面つきの呼び出しだけ、ここで書く（黙って落とさない）
  const unanswered = replies.takePending();
  if (unanswered.length > 0) await deps.projectThread.appendMessage(input.threadId, "assistant", "", unanswered);
  if (sessionId) {
    // このターンの最後のやり取りも残す——次のターンで人が発言を取り消したら、ここまでで切る（§6.31）
    await deps.projectThread.updateResumePoint(input.threadId, sessionId, lastChainUuid(messages));
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

/** 起こし直しで切れたターンの、返事の末尾に添える一行（追加・2026-10-05、アーキ仕様 §2.5） */
export const INTERRUPTED_NOTE = "（起こし直しで切れました）";

/**
 * **起こし直しで切れたターンの記録を締める**（追加・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに記録する」）。
 * 起き直した host が、`listInterruptedTurns` の返したターンに呼ぶ。切れるまでに書き終えた発言はもう記録にあり、
 * この一行はその後ろに続く（fold が同じ吹き出しにまとめる）。書いている途中だった文と、結果の来ていなかった画面つきの
 * 呼び出しは、プロセスと一緒に消えている。
 *
 *  - **切れたターンにだけ足す**（`listInterruptedTurns` と同じ条件、`notInterruptedReason`）。もう Thread の最後の
 *    ターンでない・終わりが書かれた・resume-point が書かれた・人がやめたターンには足さずに断る
 *  - **1つのターンに一度だけ**。もう足してあれば何もしない（続けば何度も起き直しうる）。足したかは記録から見る——
 *    そのターンの吹き出し（始まりより後ろの AI の発言）がこの一行で終わっているか
 */
export async function noteInterruptedTurn(
  projectThread: ProjectThreadStore,
  turn: Pick<InterruptedTurn, "threadId" | "turnId">,
): Promise<void> {
  const thread = projectThread.getThread(turn.threadId);
  const last = thread?.lastTurn;
  if (last?.turnId !== turn.turnId) {
    throw new Error(`${turn.threadId} の最後のターンは ${turn.turnId} ではありません（${last?.turnId ?? "ターン無し"}）`);
  }
  const reason = notInterruptedReason(last);
  if (reason !== undefined) throw new Error(`${turn.threadId} のターン ${turn.turnId} は切れていません：${reason}`);
  const reply = thread!.messages.at(-1);
  const noted =
    reply?.role === "assistant" &&
    reply.seq > last.startedSeq &&
    (reply.text === INTERRUPTED_NOTE || reply.text.endsWith(`\n\n${INTERRUPTED_NOTE}`));
  if (noted) return;
  await projectThread.appendMessage(turn.threadId, "assistant", INTERRUPTED_NOTE);
}

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
  deps: {
    projectThread: ProjectThreadStore;
    inbox: InboxStore;
    pendingApprovals: PendingApprovalRegistry;
    findRewindPoint?: typeof findRewindBeforePrompt;
  },
  turn: {
    threadId: string;
    /** ターンを始めたときの Thread */
    thread: ThreadState;
    /**
     * 切れたターンの会話（Thread の resume-point に無いもの）を続けたなら、その会話（追加・2026-10-05）。止めても
     * Thread の会話として残す——`system/init` の前に止めると名乗った id が無く、残さないと次のターンが新しい会話になる
     */
    continuedSession?: string;
    forkSession: boolean;
    messages: readonly unknown[];
    /** 書き終えた発言をもう書いたもの。止めたときは、まだ書いていない残りだけを書く */
    replies: ReplyRecorder;
    initSessionId: string | undefined;
    humanSeq: number | undefined;
    deliveredCount: number;
    withdrawn: WithdrawnMessage;
    raisedJudgments: readonly string[];
    /** CLI に送った発言の文（ターンに添えたもの込み）。切る位置を CLI の記録から引くときの目印 */
    sentPrompt: string;
    cwd?: string;
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
  // **取り消すかはターン全体で見る**（AI が文も tool の呼び出しも出していない）。そのときは記録にも AI の発言は
  // 1つも書いていない——書くのは文か画面つきの呼び出しがある発言だけで、どちらも「出した」に数える
  const candidate = turn.humanSeq !== undefined && turn.deliveredCount === 0 && !hasVisibleOutput(turn.messages);
  let rewindTo = thread.rewindTo ?? thread.resumeAnchor;
  if (candidate && !startsFresh && rewindTo === undefined) {
    // **切る位置を覚えていない**（この仕組みより前から続く会話・止めたターンが続いた会話——改訂・2026-10-02、
    // ユーザー報告「Fork だと戻らない」）。以前は取り消さず止めるだけにしていたが、止めたターンは位置を残さないので
    // 一度そうなると抜けられなかった。CLI の記録を SDK の公式の口で読み、送った発言の手前を引く
    const sessionId = turn.initSessionId ?? thread.resumePoint!;
    try {
      rewindTo = await (deps.findRewindPoint ?? findRewindBeforePrompt)(sessionId, turn.sentPrompt, turn.cwd);
    } catch (err) {
      // 読めなければ取り消さない——黙らずに書き残す（規則2）
      console.warn(`[host] ${turn.threadId} の取り消す発言の手前を引けませんでした（止めるだけにします）:`, err);
    }
  }
  const withdrawable = candidate && (startsFresh || rewindTo !== undefined);
  if (withdrawable) {
    await deps.projectThread.withdrawMessage(turn.threadId, turn.humanSeq!, startsFresh ? undefined : rewindTo);
    return { type: "stopped", withdrawn: turn.withdrawn };
  }

  // 取り消さない——CLI のセッションにはこのターンが載っているので、次はその続きから。**切る位置は残さない**
  // （途中で止めたやり取りのどこで切れば壊れないか分からない。次に最後まで走ったターンがまた残す）
  const kept = turn.initSessionId ?? turn.continuedSession;
  if (kept) await deps.projectThread.updateResumePoint(turn.threadId, kept);
  // 書き終えた発言はもう記録にある——**まだ書いていない残り**（結果の来ていない画面つきの呼び出し）だけを、止めた印と
  // 一緒に書く。同じターンの発言は fold が1件にまとめる（前に書いた分の後ろに「ここで止めました」が続く）
  await deps.projectThread.appendMessage(turn.threadId, "assistant", STOPPED_NOTE, turn.replies.takePending());
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
 * **AI の発言を、書き終えるごとに Thread の記録へ足す**（追加・2026-10-05、アーキ仕様 §2.5「書き終えた発言ごとに
 * 記録する」）。以前はターンの最後にまとめて1回書いていたので、途中で host が落ちると AI の返事が1つも残らなかった。
 *
 *  - **文**は、その発言（SDK の assistant のメッセージ）が届いた時点で書く。流れている途中の文は SDK が1つの
 *    メッセージとして渡さないので、ここには来ない
 *  - **画面つきの tool の呼び出し**（決定・2026-09-07、ユーザー報告）は、結果（次の user のメッセージの
 *    tool_result）が揃ってから書く——リロードしたら記録から Module の画面を出し直すので、どの tool を、どの引数で
 *    呼んで、何が返ったかが要る。**画面を持つ tool だけ**が対象。結果の来ていないものは `takePending` で取り出す
 *
 * 同じターンの発言は、fold が会話の1件にまとめる（`message.appended`）
 */
class ReplyRecorder {
  private readonly byToolName: Map<string, UiToolBinding>;
  /** 呼んだが、まだ結果が来ていない画面つきの呼び出し（呼んだ順） */
  private readonly pending = new Map<string, UiToolCallEntry>();

  constructor(
    private readonly store: ProjectThreadStore,
    private readonly threadId: string,
    uiTools: UiToolBinding[],
  ) {
    this.byToolName = new Map(uiTools.map((t) => [t.toolName, t]));
  }

  async add(raw: unknown): Promise<void> {
    const message = raw as { type?: string; message?: { content?: unknown } };
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    if (message.type === "assistant") {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_use") continue;
        const name = typeof block.name === "string" ? block.name : undefined;
        const id = typeof block.id === "string" ? block.id : undefined;
        const binding = name ? this.byToolName.get(name) : undefined;
        if (!id || !name || !binding) continue;
        this.pending.set(id, {
          toolCallId: id,
          toolName: name,
          server: binding.server,
          resourceUri: binding.resourceUri,
          ...(binding.card ? { card: binding.card } : {}),
          args: block.input,
        });
      }
      const text = extractAssistantText([raw]);
      if (text !== "") await this.store.appendMessage(this.threadId, "assistant", text);
    } else if (message.type === "user") {
      const settled: UiToolCallEntry[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type !== "tool_result") continue;
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const call = id ? this.pending.get(id) : undefined;
        if (!id || !call) continue;
        this.pending.delete(id);
        settled.push({ ...call, result: block.is_error ? { error: block.content } : block.content });
      }
      if (settled.length > 0) await this.store.appendMessage(this.threadId, "assistant", "", settled);
    }
  }

  /** まだ書いていない（結果の来ていない）画面つきの呼び出しを取り出す。取り出したものはもう持たない */
  takePending(): UiToolCallEntry[] {
    const calls = [...this.pending.values()];
    this.pending.clear();
    return calls;
  }
}
