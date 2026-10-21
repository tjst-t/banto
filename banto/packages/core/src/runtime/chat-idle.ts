// **使わなくなったチャットを眠らせる・触らなくなったチャットを閉じる**（決定・2026-10-21、アーキ仕様 §2.2「チャット——Project を
// 作る前の相談」の「コンテナは試作を始めたときに作る」）。
//
// - 眠らせる：試作を始めた（`prototyping`）チャットを、AI も人も使っていない時間が `chat.sleepAfterMinutes`（既定 15 分）続いたら、
//   普通の Project のスリープと同じ手順で眠らせる（`ProjectSleep.sleep(…, "auto")`——断る条件・止めないものも同じ）
// - 閉じる：最後に使ってから `chat.closeAfterDays`（既定 14 日、`off` なら閉じない）経ったチャットを閉じる（`project.closed`
//   `by: "auto"`）。閉じるとき Module を畳み、コンテナを消す（会話・Memory・フォルダは残す）
//
// 「使った」は、人の操作（`project-activity.json` の `lastHumanAt`）・ターンが始まった／終わった・作った、のうち一番新しいもの。
// ターンの始まりと終わりは host がメモリで覚える（`noteUse`）。banto を起こし直したら忘れ、会話の記録の最後のターンの始まりに戻る
// ——眠らせるのが少し早くなる側に倒れるが、眠らせても話しかければ起きる。走っているターンがあれば眠らせない・閉じない
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ProjectState } from "../project-thread/types.js";
import type { ProjectActivityEntry } from "./project-idle.js";
import type { RunningItem } from "./project-move.js";

export const CHAT_SLEEP_AFTER_KEY = "chat.sleepAfterMinutes";
export const CHAT_CLOSE_AFTER_KEY = "chat.closeAfterDays";
export const CHAT_SLEEP_AFTER_CHOICES = [5, 15, 60] as const;
export const CHAT_CLOSE_AFTER_CHOICES = [7, 14, 30, "off"] as const;
export type ChatSleepAfterMinutes = (typeof CHAT_SLEEP_AFTER_CHOICES)[number];
export type ChatCloseAfterDays = (typeof CHAT_CLOSE_AFTER_CHOICES)[number];
export const DEFAULT_CHAT_SLEEP_AFTER: ChatSleepAfterMinutes = 15;
export const DEFAULT_CHAT_CLOSE_AFTER: ChatCloseAfterDays = 14;
/** 時計の間隔（眠らせるのは分の単位なので1分ごと） */
export const CHAT_IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function isChatSleepAfter(v: unknown): v is ChatSleepAfterMinutes {
  return (CHAT_SLEEP_AFTER_CHOICES as readonly unknown[]).includes(v);
}

export function isChatCloseAfter(v: unknown): v is ChatCloseAfterDays {
  return (CHAT_CLOSE_AFTER_CHOICES as readonly unknown[]).includes(v);
}

/** 今の設定。無ければ既定。書くときに確かめているので、知らない値は記録が壊れている——黙って既定にしない */
export function chatIdleSettingsOf(config: Pick<RuntimeConfigStore, "layerValue"> | undefined): {
  sleepAfterMinutes: ChatSleepAfterMinutes;
  closeAfterDays: ChatCloseAfterDays;
} {
  const sleep = config?.layerValue(CHAT_SLEEP_AFTER_KEY);
  const close = config?.layerValue(CHAT_CLOSE_AFTER_KEY);
  if (sleep !== undefined && !isChatSleepAfter(sleep)) throw new Error(`${CHAT_SLEEP_AFTER_KEY} の値が不正です: ${JSON.stringify(sleep)}`);
  if (close !== undefined && !isChatCloseAfter(close)) throw new Error(`${CHAT_CLOSE_AFTER_KEY} の値が不正です: ${JSON.stringify(close)}`);
  return { sleepAfterMinutes: sleep ?? DEFAULT_CHAT_SLEEP_AFTER, closeAfterDays: close ?? DEFAULT_CHAT_CLOSE_AFTER };
}

export interface ChatIdleDeps {
  listProjects(): readonly ProjectState[];
  /** その Project の Thread の最後のターンが始まった時刻（会話の記録から。起こし直したあとの拠り所） */
  lastTurnStartedAt(projectId: string): string | undefined;
  activity: { get(projectId: string): ProjectActivityEntry | undefined };
  settings(): { sleepAfterMinutes: ChatSleepAfterMinutes; closeAfterDays: ChatCloseAfterDays };
  /** host が知っている動いているもの（眠らせるときに断る一覧と同じ） */
  hostActivity(projectId: string): RunningItem[];
  /** いま眠らせている途中か */
  sleepInProgress(projectId: string): boolean;
  /** `by: "auto"` で眠らせる（断る条件は人が眠らせるときと同じ） */
  sleep(projectId: string): Promise<unknown>;
  /** `by: "auto"` で閉じ、Module を畳んでコンテナを消す */
  close(projectId: string): Promise<unknown>;
  now?: () => Date;
}

export class ChatIdle {
  /** host が見たターンの始まり・終わり（Project → 時刻 ms） */
  private readonly used = new Map<string, number>();
  private checking: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ChatIdleDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** **AI が使った**（ターンが始まった・終わった）。チャットでなくても覚えてよい（見るのはチャットだけ） */
  noteUse(projectId: string, at: Date = this.now()): void {
    const prev = this.used.get(projectId);
    if (prev === undefined || at.getTime() > prev) this.used.set(projectId, at.getTime());
  }

  /** 最後に使った時刻（ms）——人の操作・ターン・作った、のうち一番新しいもの */
  lastUsedOf(project: ProjectState): number {
    const candidates = [
      Date.parse(project.createdAt),
      this.used.get(project.id),
      ...[this.deps.activity.get(project.id)?.lastHumanAt, this.deps.lastTurnStartedAt(project.id)].map((at) =>
        at === undefined ? undefined : Date.parse(at),
      ),
    ];
    return Math.max(...candidates.filter((t): t is number => t !== undefined && !Number.isNaN(t)));
  }

  /** **時計の1刻み**。同時には1本だけ走る。失敗はここで残す（次の刻みでまた見る） */
  check(opts: { now?: Date } = {}): Promise<void> {
    this.checking = this.checking
      .then(() => this.checkOnce(opts.now ?? this.now()))
      .catch((err: unknown) => console.warn("[host] 使っていないチャットを確かめられませんでした:", err));
    return this.checking;
  }

  private async checkOnce(now: Date): Promise<void> {
    const { sleepAfterMinutes, closeAfterDays } = this.deps.settings();
    for (const project of this.deps.listProjects()) {
      if (project.kind !== "chat" || project.status !== "active" || project.move) continue;
      if (this.deps.sleepInProgress(project.id) || this.deps.hostActivity(project.id).length > 0) continue;
      const idleMs = now.getTime() - this.lastUsedOf(project);
      if (closeAfterDays !== "off" && idleMs >= closeAfterDays * DAY_MS) {
        try {
          await this.deps.close(project.id);
          this.used.delete(project.id);
          console.log(`[host] ${closeAfterDays}日使っていないチャット ${project.id} を閉じて、コンテナを消しました`);
        } catch (err) {
          console.warn(`[host] 使っていないチャット ${project.id} を閉じられませんでした:`, err instanceof Error ? err.message : err);
        }
        continue;
      }
      if (!project.prototyping || project.sleep || idleMs < sleepAfterMinutes * MINUTE_MS) continue;
      try {
        await this.deps.sleep(project.id);
        console.log(`[host] ${sleepAfterMinutes}分使っていない試作中のチャット ${project.id} を眠らせました`);
      } catch (err) {
        // 確かめてから眠らせるまでの間に何か始まった等——次の刻みでまた見る（黙らない）
        console.warn(`[host] 使っていないチャット ${project.id} を眠らせられませんでした:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** 時計を回す（起きたときに1回、そのあと1分ごと）。止める関数を返す */
  start(intervalMs = CHAT_IDLE_CHECK_INTERVAL_MS): () => void {
    void this.check();
    const timer = setInterval(() => void this.check(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
