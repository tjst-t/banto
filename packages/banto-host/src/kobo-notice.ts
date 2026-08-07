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

/** 工場の出来事のうち、番頭に知らせるもの。 */
const NOTICEWORTHY = new Set([
  "state_transitioned",
  "task_failed",
  "task_merged",
  "audit_verdict",
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

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const details = await invoke("kobo.events", { afterEventId: cursor, limit: 100 });
      const events = (details["events"] ?? []) as KoboEventView[];
      const origins = (details["origins"] ?? {}) as Record<string, string>;
      for (const event of events) {
        cursor = Math.max(cursor, event.eventId ?? 0);
        const notice = await renderNotice(event, origins, invoke);
        if (!notice) continue;
        const threadId = threadIdOfOrigin(notice.origin);
        try {
          await options.notify(notice.text, threadId ? { threadId } : {});
        } catch (err) {
          // 決定68: 宛先が畳まれていたら起こし直して届ける——のが本筋だが、起こし直せない
          // ときは既定の宛先へ逃がす。**消えたことにしない**（I2）
          log(`[banto] 工場の知らせの宛先 ${String(threadId)} へ届きません: ${String(err)}`);
          await options.notify(notice.text, {}).catch(() => undefined);
        }
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
   * として `undefined` を返していた。だが `origin` が付くのは `kobo.enqueue` を通ったものだけで、
   * **タスク定義ファイルを watcher が取り込んだもの（決定64 の正規の入口）には付かない**。
   * 結果、そのタスクの知らせは**1通残らず捨てられていた**——loamium/task-0001 は監査が
   * 判定を出さずに落ちて failed になったのに、番頭は最後まで知らなかった。
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
    return {
      origin,
      text: [
        `${taskId} が止まりました${title}`,
        "",
        ...(task?.originRef ? ["**経緯**", task.originRef, ""] : []),
        "**起きたこと**",
        reason || "（理由が記録されていません）",
        "",
        "**求める判断**",
        "直して積み直すか、要らないなら畳むか。原因は kobo.task で辿れます。" +
          "契約を変えるなら新しいタスクを積み、元を kobo.supersede で置き換えてください（決定64）。",
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
        "解決のタスクが自動で積まれている場合があります。kobo.task で経緯を確かめてください。",
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
