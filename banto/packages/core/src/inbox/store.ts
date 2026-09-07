import { randomUUID } from "node:crypto";
import type { EventLog } from "../event-store/log.js";
import { SnapshotProjection } from "../event-store/snapshot.js";
import { inboxFold } from "./fold.js";
import type { InboxItem, JudgmentItem, JudgmentSource, ReviewItem } from "./types.js";

export class InboxStore {
  private readonly projection: SnapshotProjection<ReturnType<typeof inboxFold.initial>>;

  constructor(dataDir: string, private readonly log: EventLog) {
    this.projection = new SnapshotProjection(dataDir, "inbox", log, inboxFold);
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
    const byNewest = (a: InboxItem, b: InboxItem) => b.createdAt.localeCompare(a.createdAt);
    return [...judgments.sort(byNewest), ...reviews.sort(byNewest)];
  }

  get(id: string): InboxItem | undefined {
    return this.projection.current.items.get(id);
  }

  async raiseJudgment(input: {
    threadId: string;
    source: JudgmentSource;
    message: string;
    mode?: "form" | "url";
    requestedSchema?: unknown;
    url?: string;
    toolCallId?: string;
    toolInput?: unknown;
    serverName?: string;
  }): Promise<JudgmentItem> {
    const id = randomUUID();
    const event = await this.log.append("inbox.judgment_raised", { id, ...input });
    this.projection.applyOne(event);
    return this.get(id) as JudgmentItem;
  }

  async answerJudgment(id: string, answer: unknown): Promise<void> {
    const event = await this.log.append("inbox.judgment_answered", { id, answer });
    this.projection.applyOne(event);
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
    this.projection.applyOne(event);
  }

  async raiseReview(input: { threadId: string; summary: string }): Promise<ReviewItem> {
    const id = randomUUID();
    const event = await this.log.append("inbox.review_raised", { id, ...input });
    this.projection.applyOne(event);
    return this.get(id) as ReviewItem;
  }

  async acknowledgeReview(id: string): Promise<void> {
    const event = await this.log.append("inbox.review_acknowledged", { id });
    this.projection.applyOne(event);
  }
}
