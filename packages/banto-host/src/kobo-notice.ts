/**
 * 工場（Kobo）に起きたことを、**積んだ会話へ**返す（ADR-0013 決定58・68、task-0065）。
 *
 * Kobo は PO へ直接積まない——判断待ちはまず番頭に届き、番頭が捌けないものだけ取次へ上がる
 * （決定58）。宛先は決定35 の `origin` をそのまま使う：番頭が `kobo.enqueue` するとき
 * 自分のスレッドを渡してあり、Kobo はそれをタスクの契約と一緒に固めている。
 *
 * **意味を与えるのは受け手**（決定29d）。Kobo は中立な事実を並べるだけで、
 * 「これは判断待ちだ」「これは終わった」という読みは番頭側のもの——だからこの翻訳は
 * Kobo ではなくここに置く（`worker-notice.ts` と同じ形）。
 *
 * D5: 判断は無い。何を番頭に見せるかの選別と、日本語への言い換えだけ。
 * D3: どこまで読んだかは1つのファイルに持つ。会話の記録から導けないので写しではなく状態。
 * I2: 到達できないことを「何も起きていない」と混同しない——理由をログに出して次の tick へ。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { threadIdOfOrigin } from "./worker-notice.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";

/**
 * 止まった理由ごとに、番頭に求める判断を変える（PO裁定 2026-08-07・task-0071）。
 *
 * **「直して積み直すか、畳むか」だけでは足りない。** 止まり方によって次にやることが違い、
 * 一番違うのが**時間切れ**——テストが落ちたのではなく、待ち切れなかった。ここで
 * 「直して積み直せ」とだけ言うと、番頭は落ちてもいないテストを直そうとする。
 *
 * 機構は既に**上限まで延ばして1回やり直している**（`merge-gate.ts`）。それでも駄目という
 * ことは、**検証が長すぎる**という別の問題が出ているということ——それを番頭に伝える。
 */
function adviceForFailure(reason: string): string {
  if (/verify_timeout/.test(reason)) {
    return (
      "**テストが落ちたのではなく、待ち切れませんでした。** 工場は制限時間を延ばして" +
      "もう一度試したうえで、それでも終わらなかったと言っています——" +
      "**検証が長すぎる**という別の問題が出ている見込みです。\n" +
      "手は3つ：(1) `meta/config.yaml` の `limits.verify_timeout_minutes` を延ばす" +
      "（上限60分。マージキューは直列なので、長い1本は後ろを全部止めます）、" +
      "(2) 受け入れ条件の `verify` を分けて、1本を短くする、" +
      "(3) 検証そのものが遅い（＝直すべき）なら、それをタスクとして積む。\n" +
      "**どれも利用体験は変えない**ので、あなたの判断で決めてよい（D9）。" +
      "延ばし続けるだけになりそうなら、そのときは PO に上げてください。"
    );
  }
  if (/audit_session_exited_without_verdict/.test(reason)) {
    return (
      "**監査人が判定を出さずに落ちました**（テストの結果ではありません）。" +
      "工場は上限まで起こし直したうえで諦めています——2回とも落ちるのは、たいてい" +
      "**監査に渡している中身の問題**（スコープが大きすぎる・文脈が入り切らない）です。" +
      "タスクを分けて積み直すことを考えてください。`kobo.task` で経緯を辿れます。"
    );
  }
  if (/scope_violation/.test(reason)) {
    return (
      "**スコープの外を触っています。** 職人が契約を超えて変更したので、機構が止めました。" +
      "スコープを広げてよいかは契約の話です——**広げるのは PO の判断**（決定64 改訂）。" +
      "定義ファイルを直して `kobo.amend` を通す道はありますが、広げる方向はあなたには通りません。" +
      "**黙って広げない。** 範囲内で直せるなら `kobo.reopen` で同じタスクをやり直せます。"
    );
  }
  return (
    "原因は kobo.task で辿れます（検証ログの末尾まで出ます）。" +
    "**タスクは切り直さないこと**——中身の問題なら `kobo.reopen` の rework、" +
    "検証環境の問題なら reverify、契約そのものが間違っていたなら定義ファイルを直して " +
    "`kobo.amend`。どうしようもなければ `kobo.abandon` で畳んでください" +
    "——**どの状態のタスクでも畳めます**（落ちたものに限りません）。"
  );
}

/** 工場の出来事のうち、番頭に知らせるもの。 */
const NOTICEWORTHY = new Set([
  "state_transitioned",
  "task_failed",
  "task_merged",
  "audit_verdict",
  // **止まっている**（realign 第2便）。工場は同じ状態のあいだ1回しか積まないので、
  // ここで拾っても鳴り続けることはない
  "task_stalled",
]);

/**
 * 知らせる状態遷移。**進行の実況は流さない**——番頭の会話が工場の中継になってしまう。
 *
 * 「止まった」「終わった」はここに入れない：`task_failed` / `task_merged` が同じ出来事を
 * 詳しく持っており、両方を拾うと**同じことが2通届く**（職人の `worker_closed` で踏んだのと同じ形）。
 */
const NOTICEWORTHY_STATES = new Set(["review-ready", "paused"]);

/** Kobo の1イベント（この層に要るところだけ）。 */
interface KoboEventView {
  eventId: number;
  type: string;
  timestamp: string;
  projectTag: string;
  taskId?: string;
  to?: string;
  from?: string;
  reason?: string;
  verdict?: string;
  findings?: string[];
  commitSha?: string;
  /** `task_stalled`：どの状態で、どれだけ、何に阻まれて止まっているか。 */
  status?: string;
  dwellMs?: number;
  thresholdMs?: number;
  blockedBy?: string[];
}

/** タスク1件の見え方（`kobo.task` の返り）。 */
interface KoboTaskView {
  status: string;
  title?: string;
  origin?: string;
  originRef?: string;
  review?: { policy?: string };
  governance?: boolean;
  scope?: { paths?: string[] };
}

export interface KoboNoticeOptions {
  /** `kobo.*` Tool（モジュールから束ねたもの）。 */
  tools: NamespacedToolDefinition[];
  /** 会話へ知らせる（宛先スレッドつき）。 */
  notify(message: string, target: { threadId?: string }): Promise<void>;
  /** どこまで読んだかの置き場。 */
  cursorPath: string;
  /** 引く間隔（ms）。 */
  intervalMs?: number;
  log?(message: string): void;
}

/**
 * 工場の知らせを引き始める。返り値で止める。
 *
 * **引きに行く形**にしているのは、Kobo が別プロセスだから（決定27b）。職人（同一プロセス）は
 * 購読で受けるが、こちらは `afterEventId` で追いつける口を叩く——落ちている間に起きたことも
 * 取りこぼさない。
 */
export function startKoboNotices(options: KoboNoticeOptions): () => void {
  const interval = options.intervalMs ?? 5000;
  const log = options.log ?? ((m: string) => console.error(m));
  const invoke = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tool = options.tools.find((t) => t.name === name);
    // I2: 配線されていないことを「結果なし」にしない
    if (!tool) throw new Error(`${name} が登録されていません（Kobo モジュールが未配線）`);
    const result = await tool.execute(args as never, { toolCallId: `kobo-notice-${Date.now()}` });
    return (result.details ?? {}) as Record<string, unknown>;
  };

  let cursor = readCursor(options.cursorPath);
  let running = false;
  let stopped = false;

  /** 1通届ける。宛先が畳まれていたら既定の宛先へ逃がす（**消えたことにしない**・I2）。 */
  const deliver = async (notice: { origin: string; text: string }): Promise<void> => {
    const threadId = threadIdOfOrigin(notice.origin);
    try {
      await options.notify(notice.text, threadId ? { threadId } : {});
    } catch (err) {
      // 決定68: 宛先が畳まれていたら起こし直して届ける——のが本筋だが、起こし直せない
      // ときは既定の宛先へ逃がす
      log(`[banto] 工場の知らせの宛先 ${String(threadId)} へ届きません: ${String(err)}`);
      await options.notify(notice.text, {}).catch(() => undefined);
    }
  };

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const details = await invoke("kobo.events", { afterEventId: cursor, limit: 100 });
      const events = (details["events"] ?? []) as KoboEventView[];
      const origins = (details["origins"] ?? {}) as Record<string, string>;

      /**
       * **同じ理由の知らせは束ねる**（realign 第2便）。
       *
       * 1件1通で流すと、溜まっていた分がそのまま通数になる——実測で35件が35回
       * 届いた事例がある。そうなると番頭は読まなくなり、**知らせないのと同じ**になる。
       * 束ねてよいのは「同じことが並んでいるだけ」のもの＝滞留の知らせ。
       * 「止まった」「落ちた」は1件ずつ理由が違うので、今までどおり1通ずつ。
       */
      const stalled = events.filter((e) => e.type === "task_stalled");
      for (const event of events) {
        cursor = Math.max(cursor, event.eventId ?? 0);
        if (event.type === "task_stalled") continue;
        const notice = await renderNotice(event, origins, invoke);
        if (!notice) continue;
        await deliver(notice);
      }
      for (const bundle of bundleStalled(stalled, origins)) {
        await deliver(bundle);
      }
      writeCursor(options.cursorPath, cursor);
    } catch (err) {
      // I2: 引けなかったことを黙って握らない。写しを進めないので次の tick で取り直す
      log(`[banto] 工場の知らせを引けませんでした: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
  // 起動直後に一度引く（落ちている間に溜まったものを待たせない）
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * 滞留の知らせを**宛先ごとに1通へ束ねる**（realign 第2便）。
 *
 * 束ねる単位は宛先（会話）。同じ会話へ「止まっています」を N 通送るのは、
 * 1通に N 行書くのと情報は同じで、読まれなさだけが増える——実測で 35 件が
 * 35 回届いた事例がある。
 *
 * D5: 判断は無い。並べ替え（長く止まっているものが上）と日本語への言い換えだけ。
 */
export function bundleStalled(
  events: KoboEventView[],
  origins: Record<string, string>
): Array<{ origin: string; text: string }> {
  const byOrigin = new Map<string, KoboEventView[]>();
  for (const event of events) {
    if (!event.taskId) continue;
    const origin = origins[`${event.projectTag}/${event.taskId}`] ?? "";
    const list = byOrigin.get(origin);
    if (list) list.push(event);
    else byOrigin.set(origin, [event]);
  }

  const bundles: Array<{ origin: string; text: string }> = [];
  for (const [origin, group] of byOrigin) {
    const sorted = [...group].sort((a, b) => (b.dwellMs ?? 0) - (a.dwellMs ?? 0));
    const lines = sorted.map((e) => {
      const blocked = (e.blockedBy ?? []).length > 0 ? `／待ち: ${e.blockedBy!.join(", ")}` : "";
      return `- ${e.taskId}（${e.status ?? "?"}）${formatDuration(e.dwellMs ?? 0)}${blocked}`;
    });
    const head =
      sorted.length === 1
        ? `${sorted[0]!.taskId} が止まっています`
        : `${sorted.length} 件が止まっています`;
    bundles.push({
      origin,
      text: [
        head,
        "",
        "**起きたこと**",
        "状態が変わらないまま、決めてある時間を超えました（工場が帳簿から測っています）。",
        ...lines,
        "",
        "**求める判断**",
        "**待てば進むのか、詰まっているのかを見分けてください。** `kobo.task` で経緯を読み、" +
          "「待ち」に出ているタスクがそれ自体止まっているなら、そこが本当の原因です。\n" +
          "手は：職人が居ないなら `kobo.reopen`、レビュー待ちなら `kobo.approve` か `kobo.send_back`、" +
          "**もう工場の外で決着しているなら `kobo.settle`**（失敗としては残りません）。\n" +
          "この知らせは**同じ状態のあいだ一度だけ**出ます——次に鳴るのは状態が動いてからです。",
      ].join("\n"),
    });
  }
  return bundles;
}

/** 人が読む長さ。`banto-core` の `formatDwell` と同じ形（この層は Kobo に依存しない）。 */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}日` : `${days}日${restHours}時間`;
}

/**
 * **そこまでの作業が残っている枝**を1行で返す（無ければ `undefined`）。
 *
 * 引き先は Worker Pool の `worker.keeps`。**新しい依存は足さない**——`invoke` は
 * Tool 名で引く汎用の口なので、この層は Worker Pool のコードを読み込まない（決定27）。
 *
 * I2 の例外としてここは握る：取り置きが引けなかったことを理由に**知らせ自体を落とさない**。
 * 落ちたことを伝える方が、在り処を添えることより先である（届かないより粗い方がまし）。
 * 呼び先がまだ無い構成でも、ここで catch されて何も足さずに成立する。
 *
 * **無いときは何も足さない。** 「取り置きはありません」を毎回出すと札が読みにくくなり、
 * 本当に読ませたい「求める判断」が埋もれる。
 */
async function keepBranchLine(
  invoke: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  projectTag: string,
  taskId: string
): Promise<string | undefined> {
  let branches: string[];
  try {
    const details = await invoke("worker.keeps", { projectTag, taskId });
    branches = keepBranches(details);
  } catch {
    // 取り置きが引けなくても知らせは出す（呼び先が無い構成でもここに落ちる）
    return undefined;
  }
  /**
   * **先頭が最新**。`worker.keeps` は `lastKeptAt` の降順で返す
   * （`banto-worker-pool/src/work-keep.ts` の `listKeepBranches`：
   * `found.sort((a, b) => b.lastKeptAt.localeCompare(a.lastKeptAt))`）。
   *
   * **並び順は呼び先の都合なので、根拠をここに書いておく。** 枝名の末尾に起動時刻が
   * 入っているため末尾を最新と読み違えやすく、実際に一度間違えた——2本以上あるときに
   * **いちばん古い枝を番頭に案内する**形になっていた（1本のときだけ偶然合う）。
   */
  const latest = branches[0];
  if (!latest) return undefined;
  // **切ったことを黙らせない。** 2本以上あるなら本数を添える（1本目だけ見て
  // 「これで全部」と読まれると、拾い残しに気づけない）
  const others = branches.length > 1 ? `（他に ${branches.length - 1} 本）` : "";
  return `そこまでの作業は \`${latest}\` に残っています（\`git log -p ${latest}\`）${others}`;
}

/**
 * `worker.keeps` の返りから枝名を取り出す。
 *
 * 項目が文字列でも `{ branch }` でも読めるようにしてある——**読めない形なら空**を返し、
 * 推測で組み立てた枝名を番頭に見せない（存在しない枝を `git log` させることになる）。
 */
function keepBranches(details: Record<string, unknown>): string[] {
  const raw = details["keeps"];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      typeof item === "string"
        ? item
        : typeof (item as { branch?: unknown })?.branch === "string"
          ? ((item as { branch: string }).branch)
          : ""
    )
    .filter((branch) => branch.length > 0);
}

/**
 * 1件を知らせに言い換える。知らせないものは undefined。
 *
 * **1行目が見出し**で、以降が詳細（UI は畳んだ状態で1行目だけを見せる）。
 * 判断を求めるものは**経緯・起きたこと・求める判断**の三部構成にする（`spec-ui` §3・決定58）
 * ——「起きたこと」しか書けない札は、受け取った側が判断できない。
 */
async function renderNotice(
  event: KoboEventView,
  origins: Record<string, string>,
  invoke: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
): Promise<{ origin: string; text: string } | undefined> {
  if (!NOTICEWORTHY.has(event.type)) return undefined;
  if (event.type === "state_transitioned" && !NOTICEWORTHY_STATES.has(event.to ?? "")) return undefined;
  if (event.type === "audit_verdict" && event.verdict !== "fail") return undefined;
  const taskId = event.taskId;
  if (!taskId) return undefined;

  /**
   * 宛先。**無くても捨てない**（PO報告 2026-08-07）。
   *
   * もとは「番頭が積んだものだけを会話へ返す。PO が直にファイルを置いたものは宛先が無い」
   * として `undefined` を返していた。だが `origin` が付くのは会話から積まれたものだけで、
   * 当時の正規の入口だったファイル経由（watcher）には付かなかった。結果、そのタスクの
   * 知らせは**1通残らず捨てられていた**——loamium/task-0001 は監査が判定を出さずに落ちて
   * failed になったのに、番頭は最後まで知らなかった。
   *
   * **第4便で入口が1つになり、会話から積めば宛先は必ず付く。** それでも捨てない：
   * Kobo の内部口（`POST /api/v1/…/tasks`）から載ったものには宛先が無い。
   *
   * 宛先が分からないことは、知らせなくてよい理由にならない（I2）。既定のスレッドへ返す。
   */
  const origin = origins[`${event.projectTag}/${taskId}`] ?? "";

  let task: KoboTaskView | undefined;
  // **レビューの段は工場に聞く**（決定57・66）。判定表はプロジェクトのリポジトリにあり、
  // ここからは読めない——推測すると、PO 直行のタスクを「通してよい」と見せてしまう
  let stage = "banto";
  let envUrl: string | undefined;
  try {
    const details = await invoke("kobo.task", { projectTag: event.projectTag, taskId });
    task = details["task"] as KoboTaskView | undefined;
    if (typeof details["reviewStage"] === "string") stage = details["reviewStage"];
    // 決定59: 触れる場所があるなら札に添える（「見て決めて」ではなく「触って決めて」）
    if (typeof details["envUrl"] === "string") envUrl = details["envUrl"];
  } catch {
    // 詳細が引けなくても知らせは出す（届かないより粗い方がまし）
  }
  const title = task?.title ? `：${task.title}` : "";

  if (event.type === "task_failed") {
    const reason = event.reason ?? "";
    /**
     * **そこまでの作業の在り処**（realign 第2便・機構が職人の成果を取り置く）。
     *
     * 落ちた札を受け取った番頭がまず知りたいのは「やり直しか、拾えるのか」である。
     * 取り置きの枝があれば拾える——無いと、既にあるコミットを捨てて最初からやり直す
     * 判断をしてしまう。`envUrl`（決定59）と同じ扱いで「求める判断」の直前に置く。
     *
     * **落ちたときだけ。** 監査の不通過（`audit_verdict` の fail）には載せない
     * ——職人はまだ生きており、取り置きを案内する場面ではない。
     */
    const keep = await keepBranchLine(invoke, event.projectTag, taskId);
    return {
      origin,
      text: [
        `${taskId} が止まりました${title}`,
        "",
        ...(task?.originRef ? ["**経緯**", task.originRef, ""] : []),
        "**起きたこと**",
        reason || "（理由が記録されていません）",
        "",
        ...(keep ? [keep, ""] : []),
        "**求める判断**",
        adviceForFailure(reason),
      ].join("\n"),
    };
  }

  if (event.type === "audit_verdict") {
    return {
      origin,
      text: [
        `${taskId} が監査に落ちました${title}`,
        "",
        "**起きたこと**",
        (event.findings ?? []).map((f) => `- ${f}`).join("\n") || "（指摘が記録されていません）",
        "",
        "**求める判断**",
        "工場が指摘を渡して直させています（1回目）。2回続けて落ちたら止まります——" +
          "指摘が的外れなら、契約の書き方を見直して積み直すことを考えてください。",
      ].join("\n"),
    };
  }

  if (event.type === "task_merged") {
    return {
      origin,
      text: [
        `${taskId} がマージされました${title}`,
        "",
        "マージ前ゲート（スコープ違反の検査と検証コマンド）を通っています。" +
          (event.commitSha ? `コミット: ${event.commitSha}` : ""),
      ].join("\n"),
    };
  }

  if (event.type === "state_transitioned" && event.to === "paused") {
    return {
      origin,
      text: [
        `${taskId} が止まって待っています${title}`,
        "",
        "**起きたこと**",
        event.reason ?? "コンフリクト等で保留されています",
        "",
        "**求める判断**",
        /**
         * **同じ札が何度も来たら、それは進んでいないという意味**（inc-0063）。
         *
         * もとは「解決のタスクが自動で積まれている場合があります」で終わっていた。
         * だが実際に起きたのは、マージキューが同じコンフリクトで 1 分ごとに解消タスクを
         * 積み直し、番頭には**待つ以外の読み方が無かった**という事故である。
         * 待てば済むのか、機構が回っているのかを見分ける手と、止める手をここで名指しする。
         */
        "解決のタスクが自動で積まれている場合があります。まず kobo.task で経緯を確かめてください。\n" +
          "**同じ札が繰り返し届くなら、それは待ちではなく周回です**——" +
          "`kobo.list --state queued` に同じ表題の解消タスクが 2 本以上並んでいたら、" +
          "`kobo.set_merge_queue(enabled: false)` でそのプロジェクトのマージキューを止めてから" +
          "原因を調べること（止めても他のプロジェクトは回ります）。" +
          "そのタスク自体を降ろすなら `kobo.supersede`（置き換えるタスクを先に積む）。",
      ].join("\n"),
    };
  }

  // review-ready＝**判断待ち**。ここが決定57 の一次受け
  const forPo = stage === "po";
  return {
    origin,
    text: [
      `${taskId} がレビュー待ちです${title}`,
      "",
      ...(task?.originRef ? ["**経緯**", task.originRef, ""] : []),
      "**起きたこと**",
      "実装が終わり、**別セッションの監査を通りました**（実装者とは別の目で見ています）。" +
        (task?.scope?.paths?.length ? `\n変更の範囲: ${task.scope.paths.join(", ")}` : ""),
      "",
      // 決定59: 見るだけでなく触れる状態で差し出す。**押せば会話と面が同時に開く**
      ...(envUrl
        ? [`**触れる場所**`, `${envUrl}（判断が付くと畳まれます）`, ""]
        : []),
      "**求める判断**",
      forPo
        ? "これは **PO の判断が要る**もの（統治コード、または PO 必須の面に触る）です。" +
          "あなたは通せません——`inbox.post` で取次へ上げてください（決定57）。" +
          "札には**経緯**（このタスクを積んだときの originRef）・起きたこと・求める判断を書き、" +
          "`canvasKind: \"kobo.review\"` を添えると、POが押したときに会話と面が同時に開きます。" +
          "書き方は SKILL `kobo-review` に。"
        : "成果を確かめて、良ければ `kobo.approve` で通してください。" +
          "**通しても関所は飛びません**——この後マージ前ゲートが回ります。" +
          "捌けない（利用体験を変える・本物のトレードオフがある）なら `inbox.post` で" +
          "取次へ上げてください（D9）。手順は SKILL `kobo-review`。",
    ].join("\n"),
  };
}

/** どこまで読んだか。壊れていたら 0 から読み直す（多く届く方が、消えるよりよい）。 */
function readCursor(cursorPath: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf-8")) as { lastEventId?: number };
    return typeof parsed.lastEventId === "number" ? parsed.lastEventId : 0;
  } catch {
    return 0;
  }
}

function writeCursor(cursorPath: string, lastEventId: number): void {
  try {
    fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
    fs.writeFileSync(cursorPath, JSON.stringify({ lastEventId }), "utf-8");
  } catch (err) {
    // 書けなくても知らせは届いている。次の起動で読み直すと重複するだけ
    console.error(`[banto] 工場の読み位置を保存できません: ${String(err)}`);
  }
}
