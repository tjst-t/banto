// 予定（定期実行）（決定・2026-10-13、ユーザー。Fork「定期実行（Cron）の検討」、未実装の見本）。
//
// - 予定は core が持つ（Module にしない）。時刻が来たら、予定ごとに1本ある専用の Fork に「Thread に届ける」口
//   （アーキ §4.2）で指示を届けて起こす
// - 起こし方は予定ごとに選ぶ：毎回まっさら（既定。起こす前に Clear——前の回の会話は横線の上に残る）／前の回を引き継ぐ
// - 前の回が走っている・人の答えを待っているなら、その回は飛ばして記録する
// - banto が止まっていた間の分は、起き直したら一番最近の1回だけ走らせ、古いものは捨てる
// - 承認が要る操作は今どおり人を待つ（Project の「承認をすべて自動で許可する」がオンなら通る）
// - AI も作れるが、作る・変えるときは会話のカードで人が承認する
// - 予定で起きたターンは受信箱にお知らせを出さず、サイドバーの未読だけ。受信箱に出るのは判断待ちのときだけ
//
// モックなので時計は動かない。「次は」「前の回」は固定の文字
import { getThread } from "./threads";
import { notifyMockStoreChange } from "./store-events";

export type ScheduleRepeat =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "interval"; hours: number }
  | { kind: "cron"; expr: string };

/** 1回分の結果。飛ばした理由は人が読める文で持つ */
export interface ScheduleRun {
  at: string;
  result: "done" | "skipped" | "waiting" | "failed" | "running";
  note?: string;
}

export interface MockSchedule {
  id: string;
  projectId: string;
  /** 予定の名前。専用の Fork の名前と同じ */
  name: string;
  /** 毎回届ける指示 */
  instruction: string;
  repeat: ScheduleRepeat;
  timeZone: string;
  /** fresh＝毎回まっさら（起こす前に Clear）、continue＝前の回を引き継ぐ */
  mode: "fresh" | "continue";
  paused: boolean;
  /** 専用の Fork */
  threadId: string;
  createdBy: { kind: "human" } | { kind: "ai"; threadTitle: string };
  nextRun: string;
  /** 新しい順 */
  runs: ScheduleRun[];
}

/** label は選ぶ欄、short は文の中に添える呼び名 */
export const TIME_ZONES = [
  { id: "Asia/Tokyo", label: "東京（UTC+9）", short: "東京時間" },
  { id: "UTC", label: "UTC", short: "UTC" },
  { id: "America/Los_Angeles", label: "ロサンゼルス（UTC-7）", short: "ロサンゼルス時間" },
] as const;

const DAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function describeRepeat(r: ScheduleRepeat): string {
  switch (r.kind) {
    case "daily":
      return `毎日 ${r.time}`;
    case "weekdays":
      return `平日 ${r.time}`;
    case "weekly":
      return `毎週${DAYS[r.day]}曜 ${r.time}`;
    case "interval":
      return `${r.hours} 時間ごと`;
    case "cron":
      return `cron ${r.expr}`;
  }
}

export function timeZoneLabel(id: string): string {
  return TIME_ZONES.find((z) => z.id === id)?.short ?? id;
}

let schedules: MockSchedule[] = [
  {
    id: "sch.morning",
    projectId: "banto",
    name: "毎朝のまとめ",
    instruction:
      "昨日から今朝までに main に入ったコミットと、Backlog で閉じたもの・新しく積まれたものをまとめて。気になる点があれば最後に挙げて。",
    repeat: { kind: "weekdays", time: "9:00" },
    timeZone: "Asia/Tokyo",
    mode: "fresh",
    paused: false,
    threadId: "sch-morning",
    createdBy: { kind: "human" },
    nextRun: "明日 9:00",
    runs: [
      { at: "今日 9:00", result: "done" },
      { at: "昨日 9:00", result: "done" },
      { at: "10/9 9:00", result: "done" },
      {
        at: "10/8 9:00",
        result: "skipped",
        note: "banto が止まっていた間の時刻なので捨てました（起き直したときは、一番最近の1回だけ走らせます）",
      },
      { at: "10/7 9:00", result: "done" },
    ],
  },
  {
    id: "sch.deps",
    projectId: "banto",
    name: "依存の更新を確かめる",
    instruction:
      "npm outdated を見て、前回から新しく出た更新だけを挙げて。前回の結果は notes/deps-watch.md にあるので読んで比べ、最後に今回の結果を書き足して。",
    repeat: { kind: "weekly", day: 1, time: "10:00" },
    timeZone: "Asia/Tokyo",
    mode: "fresh",
    paused: false,
    threadId: "sch-deps",
    createdBy: { kind: "ai", threadTitle: "Base Thread" },
    nextRun: "10/19（月）10:00",
    runs: [
      { at: "10/12 10:00", result: "waiting", note: "Shell の runCommand の承認を待っています" },
      { at: "10/5 10:00", result: "done" },
    ],
  },
  {
    id: "sch.health",
    projectId: "banto",
    name: "公開中のサービスの見張り",
    instruction:
      "Publish しているサービスに順に繋いで、返事が無いもの・エラーを返すものだけ知らせて。前の回で落ちていたものが戻ったかも見て。",
    repeat: { kind: "interval", hours: 1 },
    timeZone: "Asia/Tokyo",
    mode: "continue",
    paused: true,
    threadId: "sch-health",
    createdBy: { kind: "human" },
    nextRun: "一時停止中",
    runs: [
      { at: "今日 14:00", result: "done" },
      { at: "今日 13:00", result: "skipped", note: "前の回がまだ走っていたので飛ばしました" },
      { at: "今日 12:00", result: "done" },
      { at: "今日 11:00", result: "failed", note: "ターンが途中で切れました（banto を起こし直したため）" },
      { at: "今日 10:00", result: "done" },
    ],
  },
];

export function getSchedules(projectId: string): readonly MockSchedule[] {
  return schedules.filter((s) => s.projectId === projectId);
}

/** その Thread が予定の専用の Fork なら、その予定 */
export function scheduleOfThread(threadId: string): MockSchedule | undefined {
  return schedules.find((s) => s.threadId === threadId);
}

export function setSchedulePaused(id: string, paused: boolean): void {
  schedules = schedules.map((s) =>
    s.id === id ? { ...s, paused, nextRun: paused ? "一時停止中" : "次の時刻から" } : s,
  );
  notifyMockStoreChange();
}

export function runScheduleNow(id: string): void {
  schedules = schedules.map((s) =>
    s.id === id ? { ...s, runs: [{ at: "いま", result: "running" as const }, ...s.runs] } : s,
  );
  notifyMockStoreChange();
}

export function removeSchedule(id: string): void {
  schedules = schedules.filter((s) => s.id !== id);
  notifyMockStoreChange();
}

export interface ScheduleInput {
  name: string;
  instruction: string;
  repeat: ScheduleRepeat;
  timeZone: string;
  mode: "fresh" | "continue";
}

export function saveSchedule(projectId: string, input: ScheduleInput, id?: string): void {
  if (id) {
    schedules = schedules.map((s) => (s.id === id ? { ...s, ...input } : s));
  } else {
    // 本物は専用の Fork もここで立てる。モックは既存の見本の Fork を借りない——一覧に出すだけ
    schedules = [
      ...schedules,
      {
        id: `sch.${Date.now()}`,
        projectId,
        ...input,
        paused: false,
        threadId: "",
        createdBy: { kind: "human" },
        nextRun: "次の時刻から",
        runs: [],
      },
    ];
  }
  notifyMockStoreChange();
}

/** 専用の Fork がモックに実在するか（新しく足した予定は会話を持たない） */
export function hasScheduleThread(s: MockSchedule): boolean {
  return s.threadId !== "" && getThread(s.threadId) !== undefined;
}
