// **Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.2）。
//
// 待たない仕事（サブエージェントの `runInBackground`）の完了も、この先の Thread 間のメッセージも、この1つの口で
// 宛先 Thread に「機械からのメッセージ」を積む。**届いたら AI を起こす**（ユーザー決定）：空いていればすぐ、
// 走っていれば終わってから、その Thread のターンを始める。
//
// - **黙って捨てない**：まず Event Store に残す（`delivery.received`）。会話に積むのはターンを始めるとき
//   （`turn-runner.ts`）。起こさなかったもの（下の上限）は溜めたまま、人が次に送ったターンの頭に積まれる
// - **ループ防止**（RFC 3834 の3点）：送り手の印（`MessageOrigin`）・ホップ数・速度。上限を超えたら起こさず、
//   人に知らせる
// - **人への知らせ**：届くたびに受信箱の「お知らせ」に1件

import { randomUUID } from "node:crypto";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { PendingDelivery } from "../project-thread/types.js";
import type { ThreadTurns } from "./thread-turns.js";

/** 仮置きの値（2026-09-25）——困ったら変える。根拠は `docs/notes/2026-09-25-thread-delivery.md` */
export const DELIVERY_LIMITS = {
  /** 人が送ったターン＝0 から数えて、これを超えたら起こさない */
  maxHop: 10,
  /** 同じ Thread を届いたもので起こすのは、1時間にこの回数まで */
  wakesPerHour: 20,
} as const;

export interface DeliverInput {
  threadId: string;
  /** 送り手（Module の宣言上の名前） */
  from: string;
  /** 画面に出す1行 */
  title: string;
  /** AI に渡す本文 */
  text: string;
  hop: number;
  /**
   * 受信箱に「届きました」を出すか（既定は出す）。AI が立てた Fork の最初の指示は出さない——立てたことは
   * 親の会話に Fork として出て、終わればレビュー待ちが出る（§2.2「AI が Fork を立てる」）
   */
  notify?: boolean;
}

export type WakeDecision =
  | { wake: "now" }
  | { wake: "later" }
  | { wake: "held"; reason: string };

export interface ThreadDeliveriesDeps {
  projectThread: ProjectThreadStore;
  turns: ThreadTurns;
  /** 人への知らせ（受信箱の「お知らせ」） */
  notify(input: { projectId: string; dedupeKey: string; title: string; detail: string }): Promise<void>;
  now?: () => number;
}

export class ThreadDeliveries {
  /** Thread ごとの、届いたもので起こした時刻（速度の上限に使う。起動し直すと数え直す） */
  private readonly wakes = new Map<string, number[]>();
  /**
   * 溜まっているものでターンを1本回す（画面が無くても最後まで）。**鍵は回す側が取る**——取れなければ `false`
   * （人のターンが先に始まった。終わったら `kick` がまた呼ばれる）。ターンを開く口は HTTP の層にあるので、後から渡す
   */
  private runTurn: ((threadId: string, hop: number) => Promise<boolean>) | undefined;

  constructor(private readonly deps: ThreadDeliveriesDeps) {
    // ターンが終わったら、溜まっていれば起こす（人のターンの間に届いたもの・続けて届いたもの）
    deps.turns.onChange((change) => {
      if (change.type === "ended") queueMicrotask(() => this.kick(change.threadId));
    });
  }

  setTurnRunner(run: (threadId: string, hop: number) => Promise<boolean>): void {
    this.runTurn = run;
  }

  /** 届ける。**残してから起こす**——起こせなくても消えない */
  async deliver(input: DeliverInput): Promise<{ deliveryId: string } & WakeDecision> {
    const thread = this.deps.projectThread.getThread(input.threadId);
    if (!thread) throw new Error(`宛先の Thread ${input.threadId} がありません`);
    const deliveryId = randomUUID();
    const { notify = true, ...record } = input;
    await this.deps.projectThread.recordDelivery({ ...record, deliveryId });
    const decision = this.kick(input.threadId);
    if (!notify && decision.wake !== "held") return { deliveryId, ...decision };
    const project = this.deps.projectThread.getProject(thread.projectId);
    const where = `${project?.name ?? "Project"} の ${thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread")}`;
    await this.deps
      .notify({
        projectId: thread.projectId,
        dedupeKey: `delivery:${deliveryId}`,
        title: input.title,
        detail:
          decision.wake === "held"
            ? `${where}に届きました。自動では AI を起こしませんでした——${decision.reason}。次にこの Thread で送ると AI に渡ります`
            : `${where}に届きました。AI が続きをやります`,
      })
      .catch((err: unknown) => console.warn("[host] 届いたことを受信箱に出せませんでした:", err));
    return { deliveryId, ...decision };
  }

  /**
   * **溜まっていれば起こす**。走っていれば何もしない（終わったときにまた呼ばれる）。上限を超えていれば起こさない
   * ——溜めたまま（人が次に送ったターンの頭に積まれる）
   */
  kick(threadId: string): WakeDecision {
    const thread = this.deps.projectThread.getThread(threadId);
    const pending: PendingDelivery[] = thread?.deliveries ?? [];
    if (!thread || pending.length === 0) return { wake: "held", reason: "届いたものがありません" };
    if (this.deps.turns.isRunning(threadId)) return { wake: "later" };
    const held = this.holdReason(threadId, pending);
    if (held) return { wake: "held", reason: held };
    // 起動の途中（ターンを開く口がまだ無い）——起動し終えたら `resumeAll` が起こす
    if (!this.runTurn) return { wake: "later" };
    const hop = Math.max(...pending.map((d) => d.hop));
    this.recordWake(threadId);
    void this.runTurn(threadId, hop)
      .catch((err: unknown) => console.warn(`[host] 届いたもので ${threadId} を起こせませんでした:`, err));
    return { wake: "now" };
  }

  /** 起動したとき：溜まったままの Thread を起こす（host が落ちる前に届いて、起こす前だったもの） */
  resumeAll(): void {
    for (const p of this.deps.projectThread.listProjects()) {
      for (const t of this.deps.projectThread.listThreadsForProject(p.id)) {
        if ((t.deliveries?.length ?? 0) > 0) this.kick(t.id);
      }
    }
  }

  private holdReason(threadId: string, pending: PendingDelivery[]): string | undefined {
    const thread = this.deps.projectThread.getThread(threadId)!;
    if (thread.status === "closed") return "この Thread は閉じられています";
    const project = this.deps.projectThread.getProject(thread.projectId);
    if (project?.status === "closed") return "この Project は閉じられています";
    const hop = Math.max(...pending.map((d) => d.hop));
    if (hop > DELIVERY_LIMITS.maxHop) {
      return `届いたものから起こした連鎖が ${DELIVERY_LIMITS.maxHop} 回を超えました（止まらない往復を防ぐため）`;
    }
    const now = (this.deps.now ?? Date.now)();
    const recent = (this.wakes.get(threadId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    this.wakes.set(threadId, recent);
    if (recent.length >= DELIVERY_LIMITS.wakesPerHour) {
      return `この1時間に届いたもので ${DELIVERY_LIMITS.wakesPerHour} 回起こしました（止まらない往復を防ぐため）`;
    }
    return undefined;
  }

  private recordWake(threadId: string): void {
    const list = this.wakes.get(threadId) ?? [];
    list.push((this.deps.now ?? Date.now)());
    this.wakes.set(threadId, list);
  }
}

/**
 * **ターンに渡す文を組む**——届いたものを先に、人の発言を後に。届いたものは人の発言ではないと AI に分かる形で
 * 包む（RFC 3834 の印を、AI にも見せる）
 */
export function composeTurnPrompt(
  delivered: readonly PendingDelivery[],
  prompt: string,
  /** 人が添えた画像の枚数（追加・2026-09-26）。画像は文より前に置かれるので、誰のものかをここで言う */
  imageCount = 0,
): string {
  if (delivered.length === 0) return prompt;
  const parts = delivered.map(
    (d) => `<banto-delivery from="${d.from}" hop="${d.hop}">\n${d.title}\n\n${d.text}\n</banto-delivery>`,
  );
  const imageNote = imageCount > 0 ? `——先頭の画像 ${imageCount} 枚は人が添えたもの` : "";
  return [
    "（以下は人の発言ではなく、banto が届けたものです——あなたが頼んだ仕事の結果など。必要なら続きをやってください）",
    ...parts,
    ...(prompt || imageCount > 0 ? [`（ここから人の発言${imageNote}）\n${prompt}`] : []),
  ].join("\n\n");
}
