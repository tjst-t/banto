// きっかけ（トリガー）（決定・2026-10-15、ユーザー。Fork「定期実行（Cron）の検討」、未実装の見本）。
//
// - きっかけ＝出どころ（何が起きたか）＋条件＋届け先。core が持つ（Module にしない）。届けるのは既存の
//   「Thread に届ける」口（アーキ §4.2）
// - 出どころ：段1は時刻と Webhook（LAN の中から）。段2で Module が名乗る出来事、段3で外の出来事
// - 届け先：既定はきっかけごとに1本ある専用の Fork。起こし方は毎回まっさら（既定。起こす前に Clear）／前の回を引き継ぐ。
//   既存の Thread（Base 等）にも届けられる——そのときは Clear しない
// - 前の回が動いている・人の答えを待っているとき：時刻は飛ばす、出来事（Webhook）は溜めて空いたら一度に届ける
// - banto が止まっていた間の時刻は、起き直したら一番最近の1回だけ。Webhook は止まっている間は受けられない（送り手が失敗を見る）
// - 承認が要る操作は今どおり人を待つ。AI が作る・変えるときは会話のカードで人が許す
// - 動いた回は受信箱に出さずサイドバーの未読だけ。受信箱は判断待ちのときだけ
//
// モックなので時計も待ち受けも動かない。「次は」「前の回」は固定の文字
import { getThread } from "./threads";
import { notifyMockStoreChange } from "./store-events";

export type TimeRepeat =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "interval"; hours: number }
  | { kind: "cron"; expr: string };

export type TriggerSource =
  | { kind: "time"; repeat: TimeRepeat; timeZone: string }
  | {
      kind: "webhook";
      /** きっかけごとの秘密の URL（LAN と Tailscale の中からだけ届く） */
      url: string;
      /** 署名を確かめるか（GitHub 型の HMAC-SHA256）。鍵は Vault の alias */
      signature?: { header: string; secretAlias: string };
      /** 本文のうち AI に渡す上限 */
      maxBytes: number;
      /** 出来事をまとめて1回にする待ち時間（秒） */
      batchSeconds: number;
    };

/** 届け先。dedicated＝きっかけ専用の Fork、thread＝既存の Thread（Clear しない） */
export type TriggerTarget =
  | { kind: "dedicated"; threadId: string; mode: "fresh" | "continue" }
  | { kind: "thread"; threadId: string; threadTitle: string };

/** 1回分の結果。飛ばした理由は人が読める文で持つ */
export interface TriggerRun {
  at: string;
  result: "done" | "skipped" | "waiting" | "failed" | "running" | "queued" | "rejected";
  note?: string;
}

export interface MockTrigger {
  id: string;
  projectId: string;
  /** きっかけの名前。専用の Fork の名前と同じ */
  name: string;
  /** 毎回届ける指示（Webhook なら、その下に受けた中身を添える） */
  instruction: string;
  source: TriggerSource;
  target: TriggerTarget;
  paused: boolean;
  createdBy: { kind: "human" } | { kind: "ai"; threadTitle: string };
  /** 時刻なら次の時刻、Webhook なら最後に受けた時刻 */
  nextRun: string;
  /** 新しい順 */
  runs: TriggerRun[];
}

/** label は選ぶ欄、short は文の中に添える呼び名 */
export const TIME_ZONES = [
  { id: "Asia/Tokyo", label: "東京（UTC+9）", short: "東京時間" },
  { id: "UTC", label: "UTC", short: "UTC" },
  { id: "America/Los_Angeles", label: "ロサンゼルス（UTC-7）", short: "ロサンゼルス時間" },
] as const;

const DAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function describeRepeat(r: TimeRepeat): string {
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

/** 一覧と帯に出す「いつ動くか」の1文 */
export function describeSource(s: TriggerSource): string {
  return s.kind === "time"
    ? `${describeRepeat(s.repeat)}（${timeZoneLabel(s.timeZone)}）`
    : "Webhook を受けたとき";
}

export function describeTarget(t: TriggerTarget): string {
  if (t.kind === "thread") return `「${t.threadTitle}」に届ける`;
  return t.mode === "fresh" ? "毎回まっさら" : "前の回を引き継ぐ";
}

/** 新しいきっかけの Webhook の URL（モック。本物は推測できない印を発行する） */
export function newWebhookUrl(): string {
  return "https://banto.banto.tjstkm.net/hooks/k7Qp2vX9mT4wL8sR3nYb";
}

let triggers: MockTrigger[] = [
  {
    id: "trg.morning",
    projectId: "banto",
    name: "毎朝のまとめ",
    instruction:
      "昨日から今朝までに main に入ったコミットと、Backlog で閉じたもの・新しく積まれたものをまとめて。気になる点があれば最後に挙げて。",
    source: { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" },
    target: { kind: "dedicated", threadId: "sch-morning", mode: "fresh" },
    paused: false,
    createdBy: { kind: "human" },
    nextRun: "明日 9:00",
    runs: [
      { at: "今日 9:00", result: "done" },
      { at: "昨日 9:00", result: "done" },
      { at: "10/9 9:00", result: "done" },
      {
        at: "10/8 9:00",
        result: "skipped",
        note: "banto が止まっていた間の時刻なので捨てました（起き直したときは、一番最近の1回だけ動かします）",
      },
      { at: "10/7 9:00", result: "done" },
    ],
  },
  {
    id: "trg.deps",
    projectId: "banto",
    name: "依存の更新を確かめる",
    instruction:
      "npm outdated を見て、前回から新しく出た更新だけを挙げて。前回の結果は notes/deps-watch.md にあるので読んで比べ、最後に今回の結果を書き足して。",
    source: { kind: "time", repeat: { kind: "weekly", day: 1, time: "10:00" }, timeZone: "Asia/Tokyo" },
    target: { kind: "dedicated", threadId: "sch-deps", mode: "fresh" },
    paused: false,
    createdBy: { kind: "ai", threadTitle: "Base Thread" },
    nextRun: "10/19（月）10:00",
    runs: [
      { at: "10/12 10:00", result: "waiting", note: "Shell の runCommand の承認を待っています" },
      { at: "10/5 10:00", result: "done" },
    ],
  },
  {
    id: "trg.ci",
    projectId: "banto",
    name: "夜間ビルドの失敗を調べる",
    instruction:
      "家の CI（Woodpecker）から、ビルドが落ちたと届きました。下の中身にある失敗したジョブのログを読み、原因の見当と直し方を挙げて。直すのは私が頼んでから。",
    source: {
      kind: "webhook",
      url: "https://banto.banto.tjstkm.net/hooks/Fz3mQ8rW1pLc6YtN0kVa",
      signature: { header: "X-Woodpecker-Signature", secretAlias: "woodpecker-hook-secret" },
      maxBytes: 65536,
      batchSeconds: 30,
    },
    target: { kind: "dedicated", threadId: "sch-ci", mode: "fresh" },
    paused: false,
    createdBy: { kind: "human" },
    nextRun: "最後に受けたのは 今日 3:12",
    runs: [
      { at: "今日 3:12", result: "done" },
      { at: "10/13 3:10", result: "queued", note: "前の回が動いていたので溜め、空いてから 2 件まとめて届けました" },
      { at: "10/13 3:09", result: "done" },
      { at: "10/11 3:15", result: "rejected", note: "署名が合いませんでした。AI は動かさず、送り手には 401 を返しました" },
    ],
  },
  {
    id: "trg.health",
    projectId: "banto",
    name: "公開中のサービスの見張り",
    instruction:
      "Publish しているサービスに順に繋いで、返事が無いもの・エラーを返すものだけ知らせて。前の回で落ちていたものが戻ったかも見て。",
    source: { kind: "time", repeat: { kind: "interval", hours: 1 }, timeZone: "Asia/Tokyo" },
    target: { kind: "dedicated", threadId: "sch-health", mode: "continue" },
    paused: true,
    createdBy: { kind: "human" },
    nextRun: "一時停止中",
    runs: [
      { at: "今日 14:00", result: "done" },
      { at: "今日 13:00", result: "skipped", note: "前の回がまだ動いていたので飛ばしました" },
      { at: "今日 12:00", result: "done" },
      { at: "今日 11:00", result: "failed", note: "ターンが途中で切れました（banto を起こし直したため）" },
      { at: "今日 10:00", result: "done" },
    ],
  },
];

export function getTriggers(projectId: string): readonly MockTrigger[] {
  return triggers.filter((t) => t.projectId === projectId);
}

/** その Thread がきっかけの専用の Fork なら、そのきっかけ */
export function triggerOfThread(threadId: string): MockTrigger | undefined {
  return triggers.find((t) => t.target.kind === "dedicated" && t.target.threadId === threadId);
}

export function setTriggerPaused(id: string, paused: boolean): void {
  triggers = triggers.map((t) =>
    t.id === id
      ? {
          ...t,
          paused,
          nextRun: paused ? "一時停止中" : t.source.kind === "time" ? "次の時刻から" : "次に受けたときから",
        }
      : t,
  );
  notifyMockStoreChange();
}

export function runTriggerNow(id: string): void {
  triggers = triggers.map((t) =>
    t.id === id ? { ...t, runs: [{ at: "いま", result: "running" as const }, ...t.runs] } : t,
  );
  notifyMockStoreChange();
}

export function removeTrigger(id: string): void {
  triggers = triggers.filter((t) => t.id !== id);
  notifyMockStoreChange();
}

export interface TriggerInput {
  name: string;
  instruction: string;
  source: TriggerSource;
  target: TriggerTarget;
}

export function saveTrigger(projectId: string, input: TriggerInput, id?: string): void {
  if (id) {
    triggers = triggers.map((t) => (t.id === id ? { ...t, ...input } : t));
  } else {
    // 本物は専用の Fork もここで立てる。モックは会話を持たない——一覧に出すだけ
    triggers = [
      ...triggers,
      {
        id: `trg.${Date.now()}`,
        projectId,
        ...input,
        paused: false,
        createdBy: { kind: "human" },
        nextRun: input.source.kind === "time" ? "次の時刻から" : "まだ受けていません",
        runs: [],
      },
    ];
  }
  notifyMockStoreChange();
}

/** 届け先の会話がモックに実在するか（新しく足したきっかけの専用の Fork は会話を持たない） */
export function triggerThreadId(t: MockTrigger): string | null {
  const id = t.target.threadId;
  return id !== "" && getThread(id) !== undefined ? id : null;
}
