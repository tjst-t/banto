import { randomUUID } from "node:crypto";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { inboxFold } from "./fold.js";
import type { InboxItem, JudgmentItem, JudgmentSource, NoticeItem, ReviewItem } from "./types.js";

export class InboxStore {
  private readonly projection: SnapshotProjection<ReturnType<typeof inboxFold.initial>>;

  /** 変わったら知らせる相手（host から画面への出来事の流れ、追加・2026-09-25） */
  private readonly listeners = new Set<() => void>();

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "inbox", log, inboxFold);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 判断待ちに答えが付いたら知らせる相手（追加・2026-10-05、どの道で答えても——人・畳んだ host・止めたターン） */
  private readonly answeredListeners = new Set<(item: JudgmentItem, answer: unknown) => void>();

  /**
   * **判断待ちに答えが付いたら知らせる**（追加・2026-10-05、docs/notes/2026-10-05-relay-card-followups.md）。
   * 画面のカードはターンの流れで答えを受け取っていたが、ターンが先に終わると流れが無く、host が畳んだカードが
   * 答えられるように見えたまま残った。ターンをまたぐ知らせ（`judgment.answered`）の元
   */
  onJudgmentAnswered(listener: (item: JudgmentItem, answer: unknown) => void): () => void {
    this.answeredListeners.add(listener);
    return () => this.answeredListeners.delete(listener);
  }

  private apply(event: Parameters<SnapshotProjection<ReturnType<typeof inboxFold.initial>>["applyOne"]>[0]): void {
    this.projection.applyOne(event);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[host] 受信箱の変化の聞き手が例外を投げました:", err);
      }
    }
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  /** 判断待ちを先に、それぞれ新しい順。1つの入れ物にまとめる（§2.4決定）。 */
  listOpen(): InboxItem[] {
    const all = Array.from(this.projection.current.items.values());
    const judgments = all.filter(
      (i): i is JudgmentItem => i.kind === "judgment" && i.liveness !== "answered",
    );
    const reviews = all.filter((i): i is ReviewItem => i.kind === "review" && !i.acknowledged);
    // お知らせは判断待ちの次、レビューの前——**止まっているものが先**（§2.4）だが、
    // 「Module が繋がっていない」は放っておくと静かに機能が減るので、レビューより前
    const notices = all.filter((i): i is NoticeItem => i.kind === "notice" && !i.acknowledged);
    const byNewest = (a: InboxItem, b: InboxItem) => b.createdAt.localeCompare(a.createdAt);
    return [...judgments.sort(byNewest), ...notices.sort(byNewest), ...reviews.sort(byNewest)];
  }

  get(id: string): InboxItem | undefined {
    return this.projection.current.items.get(id);
  }

  /** その Thread の判断待ち（答えた・期限切れも含む）。起こし直しで切れたターンの続きの文を組むのに使う */
  listJudgmentsForThread(threadId: string): JudgmentItem[] {
    return Array.from(this.projection.current.items.values()).filter(
      (i): i is JudgmentItem => i.kind === "judgment" && i.threadId === threadId,
    );
  }

  async raiseJudgment(input: {
    threadId: string;
    source: JudgmentSource;
    message: string;
    mode?: "form" | "url";
    requestedSchema?: unknown;
    url?: string;
    toolCallId?: string;
    withinToolCallId?: string;
    toolInput?: unknown;
    serverName?: string;
    choices?: string[];
  }): Promise<JudgmentItem> {
    const id = randomUUID();
    const event = await this.log.append("inbox.judgment_raised", { id, ...input });
    this.apply(event);
    return this.get(id) as JudgmentItem;
  }

  async answerJudgment(id: string, answer: unknown): Promise<void> {
    const event = await this.log.append("inbox.judgment_answered", { id, answer });
    this.apply(event);
    const item = this.get(id);
    if (item?.kind !== "judgment") return;
    for (const listener of this.answeredListeners) {
      try {
        listener(item, answer);
      } catch (err) {
        console.warn("[host] 判断待ちの答えの聞き手が例外を投げました:", err);
      }
    }
  }

  /**
   * 起動時に、**前のプロセスが抱えていた判断待ち**を期限切れにする
   * （決定・2026-09-06、見直し起点）。
   *
   * 判断待ちを止めているのは走行中のプロセス（canUseTool の hold-the-line）。
   * host を再起動するとその走行は消えるが、記録は `live` のまま残るので、
   * 画面には答えられるカードが出て、答えても何も起きない——「承認した」と
   * 見えているのにターンは死んだまま（規則2）。起動時に畳んでおく。
   */
  async expireOrphanedJudgments(): Promise<number> {
    const orphaned = Array.from(this.projection.current.items.values()).filter(
      (i): i is JudgmentItem => i.kind === "judgment" && i.liveness === "live",
    );
    for (const item of orphaned) await this.timeoutJudgment(item.id);
    return orphaned.length;
  }

  async timeoutJudgment(id: string): Promise<void> {
    const event = await this.log.append("inbox.judgment_timed_out", { id });
    this.apply(event);
  }

  /**
   * レビュー待ちを出す——**ターンが終わった**（決定・2026-09-27、ユーザー。アーキ仕様 §2.4「レビュー待ち」の
   * 「Base/Fork Thread 自身の完了」）。**1つの Thread に未確認は1件まで**：前のものは「見た」にして、新しいもの
   * だけを残す（同じ Thread の古い終わりを積み上げない）
   */
  async raiseReview(input: { threadId: string; summary: string }): Promise<ReviewItem> {
    await this.acknowledgeReviewsFor(input.threadId);
    const id = randomUUID();
    const event = await this.log.append("inbox.review_raised", { id, ...input });
    this.apply(event);
    return this.get(id) as ReviewItem;
  }

  /**
   * お知らせを1件出す（決定・2026-09-07）。**同じ鍵のものが未確認で残っていれば
   * 積み増さない**——「毎ターン同じことが出る」を止めるのがこの入れ物の目的。
   * 既にあるものを返す（何も書かない）。
   */
  async raiseNotice(input: {
    projectId?: string;
    dedupeKey: string;
    title: string;
    detail: string;
    /** 人が「続ける」を押せるお知らせ（追加・2026-10-05、`NoticeItem.resume`） */
    resume?: { threadId: string; turnId: string };
  }): Promise<NoticeItem> {
    const open = this.listOpen().find(
      (i): i is NoticeItem =>
        i.kind === "notice" && i.projectId === input.projectId && i.dedupeKey === input.dedupeKey,
    );
    if (open) return open;
    // **書き込み中の同じ鍵も1件に数える**（追加・2026-09-25）。確かめてから書くまでの間に `await` があるので、
    // ほぼ同時に来た2つが両方「まだ無い」と見て2件になっていた——同じ Module の起動を会話と画面が同時に
    // 頼み、同じ失敗を2か所で受けたとき（Project のコンテナを用意する待ちが入って表に出た）
    const key = `${input.projectId ?? ""}\u0000${input.dedupeKey}`;
    const inFlight = this.raisingNotices.get(key);
    if (inFlight) return inFlight;
    const raising = (async () => {
      const id = randomUUID();
      const event = await this.log.append("inbox.notice_raised", { id, ...input });
      this.apply(event);
      return this.get(id) as NoticeItem;
    })().finally(() => this.raisingNotices.delete(key));
    this.raisingNotices.set(key, raising);
    return raising;
  }
  private readonly raisingNotices = new Map<string, Promise<NoticeItem>>();

  async acknowledgeNotice(id: string): Promise<void> {
    const event = await this.log.append("inbox.notice_acknowledged", { id });
    this.apply(event);
  }

  async acknowledgeReview(id: string): Promise<void> {
    const event = await this.log.append("inbox.review_acknowledged", { id });
    this.apply(event);
  }

  /**
   * **自動で続けるのをやめたお知らせを片づける**（追加・2026-10-05、アーキ仕様 §2.5「上限」）。そのターンの続きを
   * 引き継いだターンが始まった（人が送った・「続ける」を押した）。片づけた数を返す
   */
  async acknowledgeResumeNotices(threadId: string, turnId: string): Promise<number> {
    const open = this.listOpen().filter(
      (i): i is NoticeItem => i.kind === "notice" && i.resume?.threadId === threadId && i.resume.turnId === turnId,
    );
    for (const n of open) await this.acknowledgeNotice(n.id);
    return open.length;
  }

  /** その Thread のレビュー待ちを全部「見た」にする（人がその Thread で送った・開いて見ている）。消した数を返す */
  async acknowledgeReviewsFor(threadId: string): Promise<number> {
    const open = this.listOpen().filter((i): i is ReviewItem => i.kind === "review" && i.threadId === threadId);
    for (const r of open) await this.acknowledgeReview(r.id);
    return open.length;
  }
}
