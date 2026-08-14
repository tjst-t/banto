/**
 * 滞留を帳簿から導出する（realign 第2便・rethink C-3 第1手）。
 *
 * **時間は保存しない**（D3）。「いつからこの状態なのか」は `state_transitioned` の
 * 並びが既に持っており、別に持つと必ず食い違う。ここにあるのは、その並びから
 * 時間を読み出す純関数だけ——判断（閾値を超えたか、誰に知らせるか）は呼び出し側。
 *
 * なぜ要るのか：状態は「いつからその状態か」を答えられなかったので、**何日詰まって
 * いても誰も気づけなかった**（実測 19.2h / 28.6h / 16.8h）。task-0100 の 19.2 時間は
 * 「`blockedBy` が 18 時間変わらなかった」というだけの事実で、それを言える機構が
 * 無かった。閾値を超えた `blockedBy` の不変は、機構が壊れている合図（P6）そのもので
 * あり、機械が言える。
 *
 * D6: 標準ライブラリのみ（依存なし）。
 */

import type { OrchestrationEvent, TaskStatus } from "./events.js";

/**
 * 状態ごとの既定の警告閾値（分）。層B設定 `limits.dwell_warn_minutes` で上書きする。
 *
 * **数字の根拠**は実測（`2026-08-13-kobo-vs-po-intent.md`）：職人が動いている状態
 * （implementing）は短く、人の判断を待つ状態（review-ready / paused）は長く取る。
 * `failed` が短いのは、落ちたまま置かれるのがいちばん見落とされるため。
 * ここに無い状態は**見張らない**——通り過ぎるだけの状態（ready / merging 等）で
 * 鳴らしても、読む側には何もできない。
 */
export const DEFAULT_DWELL_WARN_MINUTES: Readonly<Partial<Record<TaskStatus, number>>> =
  Object.freeze({
    queued: 120,
    implementing: 90,
    "review-ready": 240,
    failed: 60,
    paused: 240,
  });

/** そのタスクのイベントだけを、帳簿の順（＝ eventId 昇順）で取り出す。 */
function taskEvents(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): OrchestrationEvent[] {
  return events.filter(
    (e) =>
      e.projectTag === projectTag &&
      (e as { taskId?: string }).taskId === taskId
  );
}

/**
 * いまの状態に**入った時刻**（最後の `state_transitioned` の timestamp）。
 *
 * 一度も遷移していないタスク（`draft` のまま）は `task_created` の時刻。
 * どちらも無ければ `undefined`——「分からない」を 0 やいまの時刻で埋めない（I2）。
 */
export function stateEnteredAt(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): string | undefined {
  const mine = taskEvents(events, projectTag, taskId);
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e.type === "state_transitioned") return e.timestamp;
  }
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e.type === "task_created") return e.timestamp;
  }
  return undefined;
}

/**
 * いまの状態にいる長さ（ms）。基準時刻は `now`（既定はいま）。
 *
 * 入った時刻が分からなければ `undefined`。**0 を返さない**——「入ったばかり」と
 * 「分からない」は別のことで、混ぜると閾値の判定が静かに緩む。
 */
export function dwellMs(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string,
  now: number = Date.now()
): number | undefined {
  const at = stateEnteredAt(events, projectTag, taskId);
  if (at === undefined) return undefined;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, now - t);
}

/**
 * 最後に**外から見える変化**があった時刻。
 *
 * 状態が変わらなくても職人は動いていることがある——それを「止まっている」と
 * 呼ぶと、動いているものを叩くことになる。ここで見るのは
 * `agent_spawned` / `audit_started` / `merge_gate_evaluated` / `state_transitioned`。
 *
 * 見つからなければ `undefined`。
 */
export function lastObservableChangeAt(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): string | undefined {
  const observable = new Set([
    "agent_spawned",
    "audit_started",
    "merge_gate_evaluated",
    "state_transitioned",
  ]);
  const mine = taskEvents(events, projectTag, taskId);
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (observable.has(e.type)) return e.timestamp;
  }
  return undefined;
}

/**
 * **もうこの状態で鳴らしたか**（同じ状態のあいだ再発火しないための判定）。
 *
 * 「最後の `state_transitioned` より後に `task_stalled` があるか」を見るだけ。
 * D3: 鳴らした印をどこかに持たない——帳簿がそれを持っている。持つと、再起動で
 * 消える印になり、起動のたびに 35 件が鳴り直す（実測でその形の事故があった）。
 */
export function stalledAlreadyRecorded(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): boolean {
  const mine = taskEvents(events, projectTag, taskId);
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e.type === "state_transitioned") return false;
    if (e.type === "task_stalled") return true;
  }
  return false;
}

/**
 * いま**何に阻まれているか**（最新の `gate_evaluated.blockedBy`）。
 *
 * 依存で止まっていないなら空配列。知らせの文面が「なぜ止まっているか」を
 * 言えるようにするための材料。
 */
export function currentBlockedBy(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): string[] {
  const mine = taskEvents(events, projectTag, taskId);
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e.type === "gate_evaluated") return e.blockedBy ?? [];
  }
  return [];
}

/**
 * **どの契約に対しての判定か**（realign 第2便・段1）。
 *
 * 契約を定めた最後のイベントの `eventId` を返す——`task_contract_amended` があれば
 * その最新、無ければ `task_created`。
 *
 * **新しい版番号を持たない。** 契約の版は既に帳簿が表しており（決定64 改訂：
 * 「凍結ではなく版で答える」）、別に数えると二重管理になって食い違う。
 * 監査の証拠にこの値を刻んでおくと、「その判定はまだ有効か」が
 * `contractVersionOf(いまの帳簿) === verdict.contractVersion` で計算できる。
 *
 * 契約を定めたイベントが1つも無ければ `undefined`。
 */
export function contractVersionOf(
  events: readonly OrchestrationEvent[],
  projectTag: string,
  taskId: string
): number | undefined {
  const mine = taskEvents(events, projectTag, taskId);
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e.type === "task_contract_amended") return e.eventId;
  }
  for (let i = mine.length - 1; i >= 0; i--) {
    const e = mine[i]!;
    if (e.type === "task_created") return e.eventId;
  }
  return undefined;
}

/** 人が読む長さ（「3時間20分」）。知らせと `kobo.list` の両方で使う。 */
export function formatDwell(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}日` : `${days}日${restHours}時間`;
}
