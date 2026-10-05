// **起こし直しで切れたターンを続ける**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の
// 「1. Thread のターンを続ける」）。
//
// host が起き直したら、切れたターン（`listInterruptedTurns`）を1件ずつ：
//   - 発言を1つも積まないうちに切れたもの → 続けずに閉じる（届いたものは待ち行列に残り、`resumeAll` が起こす）
//   - 続けて切れた回数が上限に達したもの → 続きを待ち行列に積むが起こさず、受信箱に「続ける」を押せるお知らせを
//     出す。お知らせが開いている間は、ほかの届いたものでもその Thread を起こさない（`resumeHoldReason`）。次に始まる
//     ターン——人が「続ける」を押した・人がその Thread で送った——が続きを引き継ぐ（`attempt` は 0 から）
//   - それ以外 → 記録に「（起こし直しで切れました）」を足し、**送り手 banto の届いたもの**で続きを起こす
//
// 続きを人の発言にしないのは、画面に人の吹き出しが出る・止めたときの取り消し（v4-frontend.md §6.31）が機械の文を
// 入力欄へ戻す・CLI の記録から切る位置を引く目印（`findRewindBeforePrompt`）が狂うため（Fable のレビュー）。届いた
// ものは記録に残るので、続きを起こす前に host がまた落ちても失われない。どのターンも、見たら必ず `turn.ended` を
// 書く——起きるたびに同じターンを見つけ直さない。

import { getSessionInfo, getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { InterruptedTurn } from "../project-thread/interrupted-turns.js";
import { normalizeProjectRoot, type ProjectThreadStore } from "../project-thread/store.js";
import type { PendingDelivery, ThreadState, TurnContinuation } from "../project-thread/types.js";
import type { InboxStore } from "../inbox/store.js";
import { noteInterruptedTurn } from "../http/turn-runner.js";
import { FORK_SERVER_NAME, FORK_TOOL_NAME } from "../http/fork-tool.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";

/**
 * **続けて切れた回数の上限**。切れたターン（続きの続きも含め、`attempt`＋1 回目の切れ）がこれに達したら自動で
 * 続けない——AI の動きそのものが落ちる原因のとき、落ちる→続ける→落ちるを繰り返して他の会話まで止めないため
 * （§2.5「上限」）。3：切れたら続け、その続きもまた切れたらもう一度だけ続け、それも切れたら（続けて3回目の切れで）
 * やめる（ユーザーとの合意・2026-10-05）
 */
export const RESUME_CUT_LIMIT = 3;

/** 続きを届ける送り手（Module の名前ではなく banto 自身） */
export const RESUME_SENDER = "banto";

export const RESUME_TITLE = "banto を起こし直したため、直前のターンが途中で切れました";
export const RESUME_GAVE_UP_TITLE = "この会話は起こし直しのたびに切れるので、自動で続けるのをやめました";

/**
 * CLI の会話の記録を読む口（SDK）。試験は差し替える。`dir` は Runner の cwd（Project の root）——CLI は記録を
 * cwd ごとの置き場に書く
 */
export interface SessionReader {
  /** 会話の記録があるか（`getSessionInfo`、実測 M2・F1——失敗の文言に頼らない） */
  exists(sessionId: string, dir?: string): Promise<boolean>;
  /** 会話の鎖（`getSessionMessages`） */
  messages(sessionId: string, dir?: string): Promise<SessionMessage[]>;
}

/**
 * SDK の口。**置き場（`dir`）で引き、無ければ全体から**（`runner/adapter.ts` の `findRewindBeforePrompt` と同じ——
 * 置き場の名前の付け方が食い違うと空が返る）
 */
export const sdkSessionReader: SessionReader = {
  exists: async (sessionId, dir) =>
    (dir !== undefined && (await getSessionInfo(sessionId, { dir })) !== undefined) ||
    (await getSessionInfo(sessionId)) !== undefined,
  messages: async (sessionId, dir) => {
    const chain = dir !== undefined ? await getSessionMessages(sessionId, { dir }) : [];
    return chain.length > 0 ? chain : getSessionMessages(sessionId);
  },
};

export interface TurnContinuationDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  deliveries: ThreadDeliveries;
  sessions?: SessionReader;
  /**
   * **続けると答えた Module の仕事**（§2.5 の 2. への接ぎ目、2026-10-05）。Module の札の判定で残した返事待ち
   * （続けると答えて覚え直した札）のうち、その Thread のもの。続きの文に「<Module> の仕事は続いています（終わったら
   * 届きます）」と書く。**いまは渡さない**——「続けられる」と名乗る Module がまだ無く、札は全部「途中で終わりました」
   * になる（cli.ts の `deliverLostReply`）
   */
  keptReplies?(threadId: string): Array<{ moduleName: string }>;
}

export type InterruptedTurnHandling =
  | { action: "continued"; deliveryId?: string }
  | { action: "closed"; reason: string }
  | { action: "stopped-retrying"; noticeId: string };

/**
 * **起き直したとき、切れたターンを1件ずつ片づける**。Module の札の判定（§2.5 の 2.）のあと、ターンを開く口が
 * できる前に呼ぶ——ここで届けた続きは、待ち受けを始めてから `resumeAll` が起こす（Runner は中継の口に繋ぐので、
 * 先に起こすと繋がらない）。1件で失敗しても残りは続ける（失敗したターンは閉じずに残す——次に起きたらもう一度見る）
 */
export async function resumeInterruptedTurns(
  deps: TurnContinuationDeps,
): Promise<Array<{ turn: InterruptedTurn } & (InterruptedTurnHandling | { action: "failed"; error: string })>> {
  const results: Array<{ turn: InterruptedTurn } & (InterruptedTurnHandling | { action: "failed"; error: string })> = [];
  for (const turn of deps.projectThread.listInterruptedTurns()) {
    try {
      results.push({ turn, ...(await handleInterruptedTurn(deps, turn)) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn(`[host] 切れたターン（Thread ${turn.threadId} ターン ${turn.turnId}）を片づけられませんでした:`, err);
      results.push({ turn, action: "failed", error });
    }
  }
  return results;
}

async function handleInterruptedTurn(deps: TurnContinuationDeps, turn: InterruptedTurn): Promise<InterruptedTurnHandling> {
  const { projectThread } = deps;
  /** 続けて切れた回数（このターンの切れも入れて） */
  const cuts = turn.attempt + 1;
  const gaveUp = cuts >= RESUME_CUT_LIMIT;
  if (turn.stackedMessages === 0) {
    // **続きを引き継いだターンが、続きを積む前に切れた**——続きは待ち行列に残っている。切れた回数は数える（数えないと、
    // `turn.started` と発言を積む間で切れ続けたとき、同じ `attempt` で起こし直し続けて上限が効かない）。同じ届いたものを
    // 進めた `attempt` で出し直す
    const queued = turn.continuesTurnId !== undefined ? queuedContinuation(projectThread.getThread(turn.threadId), turn.continuesTurnId) : undefined;
    if (queued) {
      await redeliverContinuation(deps, turn.threadId, queued, cuts);
      const notice = gaveUp ? await raiseGaveUp(deps, turn.threadId, queued.continues.turnId, cuts) : undefined;
      await projectThread.endTurn(turn.threadId, turn.turnId, "failed");
      return notice ? { action: "stopped-retrying", noticeId: notice.id } : { action: "continued" };
    }
    // AI にはまだ何も渡っていない。人の発言は要求の中にしか無かった。届いたものは待ち行列に残っている
    await projectThread.endTurn(turn.threadId, turn.turnId, "failed");
    return { action: "closed", reason: "発言を1つも積まないうちに切れた（届いたものは待ち行列に残っている）" };
  }
  await noteInterruptedTurn(projectThread, turn);
  // 続きをもう届けてあれば届け直さない（届けたあと、閉じる前に落ちた）。上限に達したら、続きは積むが起こさない——
  // 次に始まるターン（人が「続ける」を押した・人が送った）が引き継ぐ。お知らせが開いている間は起こさない
  const pending = queuedContinuation(projectThread.getThread(turn.threadId), turn.turnId) !== undefined;
  const deliveryId = pending ? undefined : await deliverContinuation(deps, turn, cuts, { wake: !gaveUp });
  if (gaveUp) {
    const notice = await raiseGaveUp(deps, turn.threadId, turn.turnId, cuts);
    await projectThread.endTurn(turn.threadId, turn.turnId, "failed");
    return { action: "stopped-retrying", noticeId: notice.id };
  }
  await projectThread.endTurn(turn.threadId, turn.turnId, "failed");
  return { action: "continued", ...(deliveryId ? { deliveryId } : {}) };
}

/** 「自動で続けるのをやめました」のお知らせ。`turnId` は続ける（切れた）ターン——待ち行列の続きの `continues.turnId` */
async function raiseGaveUp(deps: TurnContinuationDeps, threadId: string, turnId: string, cuts: number) {
  const thread = deps.projectThread.getThread(threadId)!;
  const project = deps.projectThread.getProject(thread.projectId);
  const where = `${project?.name ?? "Project"} の ${thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread")}`;
  return deps.inbox.raiseNotice({
    projectId: thread.projectId,
    dedupeKey: `turn-resume:${threadId}:${turnId}`,
    title: RESUME_GAVE_UP_TITLE,
    detail: `${where}——起こし直しで続けて ${cuts} 回切れました。続けるなら「続ける」を押すか、この会話で次を送ってください`,
    resume: { threadId, turnId },
  });
}

/** 待ち行列にある、そのターンの続き */
function queuedContinuation(
  thread: ThreadState | undefined,
  turnId: string,
): (PendingDelivery & { continues: TurnContinuation }) | undefined {
  return thread?.deliveries?.find((d): d is PendingDelivery & { continues: TurnContinuation } => d.continues?.turnId === turnId);
}

/** 待ち行列の続きを、`attempt` を変えて出し直す（同じ届いたものを置き換える。起こさない） */
async function redeliverContinuation(
  deps: TurnContinuationDeps,
  threadId: string,
  queued: PendingDelivery & { continues: TurnContinuation },
  attempt: number,
): Promise<void> {
  await deps.deliveries.deliver(
    {
      threadId,
      from: queued.from,
      title: queued.title,
      text: queued.text,
      hop: queued.hop,
      notify: false,
      continues: { ...queued.continues, attempt },
      replaces: queued.deliveryId,
    },
    { wake: false },
  );
}

/**
 * **自動で続けるのをやめた Thread を留める理由**（`ThreadDeliveries` の `hold`）。「続ける」のお知らせが開いていて、
 * その続きがまだ待ち行列にある間は、届いたもの（Module の「途中で終わりました」など）でも起こさない——起こすと、
 * 続きを引き継いだターンが人の判断を待たずに走り、上限が効かない
 */
export function resumeHoldReason(deps: Pick<TurnContinuationDeps, "projectThread" | "inbox">, threadId: string): string | undefined {
  const thread = deps.projectThread.getThread(threadId);
  const held = deps.inbox
    .listOpen()
    .some((i) => i.kind === "notice" && i.resume?.threadId === threadId && queuedContinuation(thread, i.resume.turnId) !== undefined);
  return held ? "起こし直しのたびに切れるので、自動で続けるのをやめています（受信箱の「続ける」で続きます）" : undefined;
}

/** 「続ける」を押して、いま続けているお知らせ（同時に押されても二重に届けない） */
const resuming = new Set<string>();

/**
 * **自動で続けるのをやめたターンを、人が「続ける」と言った**（受信箱のお知らせのボタン）。待ち行列の続きを
 * `attempt` 0 で出し直し（人の判断——切れた回数を数え直す）、お知らせを片づけてから起こす。続きがもう待ち行列に
 * 無い（人が送ったターンが引き継いだ・Clear・閉じた）なら断る
 */
export async function continueStoppedTurn(
  deps: TurnContinuationDeps,
  noticeId: string,
): Promise<{ ok: true } | { ok: false; status: 404 | 409; error: string }> {
  const notice = deps.inbox.get(noticeId);
  if (notice?.kind !== "notice" || !notice.resume) return { ok: false, status: 404, error: "続けられるお知らせではありません" };
  const refuse = (error: string) => ({ ok: false as const, status: 409 as const, error });
  if (notice.acknowledged) return refuse("このお知らせはもう片づいています");
  if (resuming.has(noticeId)) return refuse("いま続けています");
  resuming.add(noticeId);
  try {
    const thread = deps.projectThread.getThread(notice.resume.threadId);
    if (!thread) return refuse("この会話はもうありません");
    if (thread.status === "closed" || deps.projectThread.getProject(thread.projectId)?.status === "closed") {
      return refuse("この会話は閉じられています");
    }
    const queued = queuedContinuation(thread, notice.resume.turnId);
    if (!queued) {
      return refuse(thread.lastTurn?.abandonedBy !== undefined ? "この会話は畳まれています（Clear・閉じた）" : "この会話はもう先へ進んでいます");
    }
    // 出し直してから片づける——片づけたあとで出し直しに失敗すると、続きが上限の `attempt` のまま留めが外れる
    await redeliverContinuation(deps, thread.id, queued, 0);
    await deps.inbox.acknowledgeNotice(noticeId);
    deps.deliveries.kick(thread.id);
    return { ok: true };
  } finally {
    resuming.delete(noticeId);
  }
}

async function deliverContinuation(
  deps: TurnContinuationDeps,
  turn: InterruptedTurn,
  attempt: number,
  opts: { wake: boolean },
): Promise<string> {
  const plan = await planContinuation(deps, turn);
  const continues: TurnContinuation = {
    turnId: turn.turnId,
    attempt,
    fromSeq: turn.fromSeq,
    ...(plan.session ? { session: plan.session } : {}),
  };
  const result = await deps.deliveries.deliver(
    {
      threadId: turn.threadId,
      from: RESUME_SENDER,
      title: RESUME_TITLE,
      text: plan.text,
      // 切れたターンと同じホップ（人のターンを続けるだけ）。受信箱には出さない——会話は続いている
      hop: turn.hop,
      notify: false,
      continues,
    },
    { wake: opts.wake },
  );
  return result.deliveryId;
}

export interface ContinuationPlan {
  text: string;
  session?: TurnContinuation["session"];
}

/**
 * **続きの文と、続ける会話を決める**。文面は §2.5 のとおり、分かったものだけ続ける：
 *  - 実行中だった呼び出し：CLI の会話の鎖（`getSessionMessages`）で、切れたターン（鎖の最後の人の側の発言より後ろ）
 *    の結果の無い tool_use。読めなければ「分かりません」。**巻き戻しの上で切れたとき**、SDK が返すのは切れたターンを
 *    含む新しい鎖で、CLI が `resumeSessionAt` で続けるのはその手前（実測 M1）——呼び出しを拾うのは新しい鎖から、
 *    続けるのは手前から（なので切れたターンの発言は入れ直す）。ただし CLI が何も書く前に切れたら、SDK が返すのは取り消した
 *    古いターンの鎖——鎖の最後の人の発言が切れたターンで送った文と一致しなければ「分かりません」
 *  - 承認を待っていた呼び出し：起き直したときに期限切れにした（またはターンの中で期限切れになった）判断待ちの
 *    toolCallId と照らす——実行されていない
 *  - このターンで予約した Fork：予約はメモリだけなので立っていない（予約の tool の呼び出しが鎖にある）
 *  - 続けると答えた Module の仕事（`keptReplies`。いまは無い）
 *  - 切れたターンの発言（人の発言・届いたもの）を入れ直す：巻き戻しの上で切れた（CLI から丸ごと消える）・会話の
 *    記録が無い（AI に何も届いていない）・鎖に見つからない（届いたか分からない）とき
 *
 * 続ける会話：新しい会話・Fork の最初のターンは、切れたターンが自分の会話を書いていればそれを続け（`resume`）、
 * 書く前に切れていれば、新しい会話は同じ id で最初から（`fresh`、実測 M2）、Fork は親から新しい id で分け直す
 * （同じ id は「already in use」、実測 F1——何も渡さなければ Thread の resume-point から分ける）。続いている会話は
 * Thread の resume-point と巻き戻しの位置のまま
 */
export async function planContinuation(deps: TurnContinuationDeps, turn: InterruptedTurn): Promise<ContinuationPlan> {
  const sessions = deps.sessions ?? sdkSessionReader;
  const thread = deps.projectThread.getThread(turn.threadId);
  if (!thread) throw new Error(`Thread ${turn.threadId} がありません`);
  const stacked = thread.messages.filter((m) => m.role === "user" && m.seq > turn.startedSeq);
  const dir = runnerCwdOf(deps.projectThread, thread);
  // **続きの続き**：切れたターンが Thread の resume-point に無い会話を続けていた（新しい会話の最初のターン・Fork の最初の
  // ターンが会話を書いてから切れ、その続きもまた切れた）——同じ会話を続ける。会話の id を名乗る前に切れていても
  // （`sessionId` が無い）続けた会話は `resumePoint` にある。渡さないと Thread の resume-point（無ければ新しい会話）で
  // 走り、切れた会話を黙って捨てる
  const continuedOther = turn.resumePoint !== undefined && turn.resumePoint !== thread.resumePoint;
  const ownsConversation = !continuedOther && (turn.resumePoint === undefined || !thread.ownsSession);

  let session: ContinuationPlan["session"];
  /** AI に何も届いていない（会話の記録が無い） */
  let nothingReached = false;
  let chainOf: string | undefined;
  if (ownsConversation) {
    // 新しい会話の最初のターン・Fork の最初のターン——会話の id は切れたターンが持っている
    const own = turn.sessionId;
    const exists = own === undefined ? false : await sessions.exists(own, dir).catch((err: unknown) => {
      // 分からない——記録はふつう `system/init` の直後に書かれるので、あるものとして続ける（無ければそのターンが失敗する）
      console.warn(`[host] 会話 ${own} の記録があるか分かりません（あるものとして続けます）:`, err);
      return true;
    });
    if (own !== undefined && exists) {
      session = { resume: own };
      chainOf = own;
    } else {
      nothingReached = true;
      if (turn.resumePoint === undefined && own !== undefined) session = { fresh: own };
    }
  } else {
    chainOf = turn.sessionId ?? turn.resumePoint;
    if (continuedOther) session = { resume: turn.resumePoint! };
  }

  let chain: SessionMessage[] | undefined;
  if (chainOf !== undefined) {
    chain = await sessions.messages(chainOf, dir).catch((err: unknown) => {
      console.warn(`[host] 会話 ${chainOf} の記録を読めませんでした（実行中だった呼び出しは分からないと書きます）:`, err);
      return undefined;
    });
    if (chain?.length === 0) chain = undefined;
  }

  const tail = chain ? lastTurnOfChain(chain) : undefined;
  /** 鎖の最後の人の側の発言に、切れたターンで渡した文が全部ある（CLI まで届いた） */
  const reached = tail !== undefined && stacked.every((m) => m.text === "" || tail.humanText.includes(m.text));
  // **鎖の末尾が切れたターンか**。巻き戻しの上で、CLI が何も書く前に切れたとき、SDK が返す鎖は取り消した古いターンの
  // もの（新しい鎖がまだ無い）——その末尾を切れたターンと読むと、取り消したターンの呼び出しを「実行中だった」と書く。
  // 巻き戻しの上では、鎖の最後の人の発言が切れたターンで送った文と一致するときだけ、鎖から呼び出しを拾う（文の無い
  // 発言だけなら照らせない——拾わない）
  const cutTail = turn.rewindTo === undefined || (reached && stacked.some((m) => m.text !== "")) ? tail : undefined;
  const expired = deps.inbox
    .listJudgmentsForThread(turn.threadId)
    .filter((j) => j.liveness === "timed_out" && j.toolCallId !== undefined && j.createdAt >= turn.startedAt);
  const expiredIds = new Set(expired.map((j) => j.toolCallId!));
  const forkTool = `mcp__${FORK_SERVER_NAME}__${FORK_TOOL_NAME}`;

  const when = new Date(turn.startedAt).toLocaleString("ja-JP", { hour12: false });
  const lines: string[] = [];
  lines.push(
    nothingReached
      ? `banto を起こし直したため、直前のターン（${when} に始めたもの）は AI に届く前に切れました。`
      : `banto を起こし直したため、直前のターンが途中で切れました（${when} に始めたターン）。`,
  );
  if (!nothingReached) {
    if (cutTail) {
      for (const call of cutTail.unanswered) {
        if (expiredIds.has(call.id) || call.name === forkTool) continue;
        lines.push(
          `切れたとき実行中だった呼び出し：${call.name}（${argsHead(call.input)}）——結果は分かりません（コマンドならまだ動いて` +
            `いるかもしれません）。確かめてから進めてください`,
        );
      }
    } else if (tail) {
      lines.push("切れたとき実行中だった呼び出しは分かりません（切れたターンが会話の記録に見つかりませんでした）");
    } else {
      lines.push("切れたとき実行中だった呼び出しは分かりません（会話の記録を読めませんでした）");
    }
  }
  for (const j of expired) {
    const name = cutTail?.unanswered.find((c) => c.id === j.toolCallId)?.name ?? j.message.replace(/^tool呼び出しの承認: /, "");
    lines.push(`${name} は承認を待ったまま無効になりました（実行されていません）。要るならもう一度呼んでください`);
  }
  if (cutTail?.calledNames.includes(forkTool)) lines.push("このターンで頼んだ Fork は立っていません");
  for (const kept of deps.keptReplies?.(turn.threadId) ?? []) {
    lines.push(`${kept.moduleName} の仕事は続いています（終わったら届きます）`);
  }

  const reinsert = nothingReached || turn.rewindTo !== undefined || !reached || stacked.every((m) => m.text === "");
  if (reinsert && stacked.length > 0) {
    lines.push(
      nothingReached
        ? "そのとき渡したものを、ここに入れ直します："
        : turn.rewindTo !== undefined
          ? "切れたターンは会話の記録から外れるので、そのとき渡したものをここに入れ直します："
          : "切れたターンで渡したものが届いたか分からないので、ここに入れ直します：",
    );
    for (const m of stacked) {
      const images = m.images && m.images.length > 0 ? `\n（画像 ${m.images.length} 枚が添えられていました——ここには入れ直せません）` : "";
      lines.push(m.origin ? `【${m.origin.from} から届いたもの：${m.origin.title}】\n${m.text}${images}` : `【人の発言】\n${m.text}${images}`);
    }
  }
  lines.push("続きをお願いします。");
  return { text: lines.join("\n\n"), ...(session ? { session } : {}) };
}

/** Runner の cwd（Project の root、`http/app.ts` と同じ正規化）。CLI の記録の置き場を引くのに使う。決まらなければ無し */
function runnerCwdOf(projectThread: ProjectThreadStore, thread: ThreadState): string | undefined {
  const project = projectThread.getProject(thread.projectId);
  if (!project) return undefined;
  try {
    return normalizeProjectRoot(project.root);
  } catch {
    return undefined; // 置き場を全部から探す（`sdkSessionReader`）
  }
}

/** 鎖の最後のターン：最後の人の側の発言（tool の結果ではない user）の文と、それより後ろの tool の呼び出し */
function lastTurnOfChain(chain: SessionMessage[]): {
  humanText: string;
  unanswered: Array<{ id: string; name: string; input: unknown }>;
  calledNames: string[];
} {
  const contentOf = (m: SessionMessage): unknown[] => {
    const content = (m.message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
  };
  const isHuman = (m: SessionMessage) =>
    m.type === "user" && !contentOf(m).some((b) => (b as { type?: string })?.type === "tool_result");
  let start = chain.length - 1;
  while (start >= 0 && !isHuman(chain[start]!)) start--;
  const humanText =
    start >= 0
      ? contentOf(chain[start]!)
          .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
          .map((b) => b.text)
          .join("")
      : "";
  const calls = new Map<string, { id: string; name: string; input: unknown }>();
  const answered = new Set<string>();
  const calledNames: string[] = [];
  for (const m of chain.slice(start + 1)) {
    for (const raw of contentOf(m)) {
      const b = raw as { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string };
      if (m.type === "assistant" && b.type === "tool_use" && b.id && b.name) {
        calls.set(b.id, { id: b.id, name: b.name, input: b.input });
        calledNames.push(b.name);
      } else if (m.type === "user" && b.type === "tool_result" && b.tool_use_id) {
        answered.add(b.tool_use_id);
      }
    }
  }
  return { humanText, unanswered: [...calls.values()].filter((c) => !answered.has(c.id)), calledNames };
}

/** 引数の頭（1行に収まる長さ） */
function argsHead(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}
