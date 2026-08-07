/**
 * 検証環境の衛生を番頭の会話へ返す（task-0067）。
 *
 * Environment Pool は中立な事実を並べるだけで、**意味は引いた側が与える**（決定29d）
 * ——`worker-notice.ts` / `kobo-notice.ts` と同じ形。だからこの翻訳は Environment Pool
 * ではなく banto-host に置く。
 *
 * **宛先は既定のスレッド。** `env.provision` は `origin`（決定35a）を受けておらず、
 * 畳み忘れ・孤児は環境1つの話ではなく**置き場全体の衛生**なので、スレッドへ振り分ける
 * 意味が薄い。振り分けるなら origin を provision の呼び出し側（Kobo を含む）まで
 * 通す必要があり、それは別の話。
 *
 * **読み位置はファイルに持つ**（`kobo-notice.ts` と同じ）。職人の知らせは「起動時の位置から」
 * でよかったが、こちらは**外に残ったリソース＝費用**（I3）。番頭が落ちている間に漏れた分が
 * 消えると、気づく契機がサービスのログしか無くなる。Environment Pool 側が同じ出来事を
 * 1度しか積まないので、追いついても同じ文面が並びはしない。
 *
 * D5: 判断は無い。何を番頭に見せるかの選別と、日本語への言い換えだけ。
 * I2: 引けなかったことを「何も起きていない」と混同しない。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EnvEvent } from "@banto/environment-pool";
import type { NamespacedToolDefinition } from "./tool-registry.js";

export interface EnvNoticeOptions {
  /** `env.*` Tool（モジュールから束ねたもの）。 */
  tools: NamespacedToolDefinition[];
  /** 会話へ知らせる。 */
  notify(message: string): Promise<void>;
  /** どこまで読んだかの置き場。 */
  cursorPath: string;
  /** 引く間隔（ms）。既定 30 秒——検証環境の掃除は毎分の tick なので、これより細かくしても何も出ない */
  intervalMs?: number;
  log?(message: string): void;
}

/**
 * 検証環境の知らせを引き始める。返り値で止める。
 *
 * 独立サービス（決定61）なので同一プロセスの購読は使えない——`env.events` を
 * `afterEventId` 付きで追う。
 */
export function startEnvNotices(options: EnvNoticeOptions): () => void {
  const interval = options.intervalMs ?? 30_000;
  const log = options.log ?? ((m: string) => console.error(m));
  const invoke = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const tool = options.tools.find((t) => t.name === name);
    // I2: 配線されていないことを「結果なし」にしない
    if (!tool) throw new Error(`${name} が登録されていません（Environment Pool モジュールが未配線）`);
    const result = await tool.execute(args as never, { toolCallId: `env-notice-${Date.now()}` });
    return (result.details ?? {}) as Record<string, unknown>;
  };

  let cursor = readCursor(options.cursorPath);
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const details = await invoke("env.events", { afterEventId: cursor, limit: 100 });
      const events = (details["events"] ?? []) as EnvEvent[];
      for (const event of events) {
        cursor = Math.max(cursor, event.id ?? 0);
        const notice = renderEnvNotice(event);
        if (!notice) continue;
        await options.notify(notice);
      }
      writeCursor(options.cursorPath, cursor);
    } catch (err) {
      // I2: 引けなかったことを黙って握らない。写しを進めないので次の tick で取り直す
      log(`[banto] 検証環境の知らせを引けませんでした: ${String(err)}`);
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
 * どれも「何かが外に残っているかもしれない」話なので、**何を確かめるか**まで書く
 * ——「孤児が3件あります」だけでは受け取った側が動けない。
 */
export function renderEnvNotice(event: EnvEvent): string | undefined {
  const where = event.envId ? `${event.envId}${event.profile ? `（${event.profile}）` : ""}` : "";

  if (event.type === "env_expired") {
    return [
      `検証環境 ${where} を期限切れで畳みました`,
      "",
      "**起きたこと**",
      "期限（TTL）が過ぎたので機構が畳みました。**あなたが畳んだのではありません**——" +
        "畳み忘れると、期限が来るまでその環境は動き続けます。",
      "",
      "**求める判断**",
      "要らなくなった時点で `env.teardown` を呼んでください。使い捨てなら `env.verify` が" +
        "畳みまで持ちます（SKILL `environment`）。まだ検証の途中だったなら立て直しが要ります。",
    ].join("\n");
  }

  if (event.type === "env_teardown_failed") {
    return [
      `検証環境 ${where} を畳めませんでした`,
      "",
      "**起きたこと**",
      `${String(event.data["attempts"] ?? "複数")}回試しても畳めませんでした。` +
        `理由: ${String(event.data["error"] ?? "（記録されていません）")}`,
      "",
      "**求める判断**",
      "**外にリソースが残っている可能性があります**（費用が出続けます）。`env.list` で状態を" +
        "確かめ、もう一度 `env.teardown` を試してください。それでも畳めないなら、機構では" +
        "片付かないので PO へ上げてください——放置は損失になります。",
    ].join("\n");
  }

  if (event.type === "env_orphans_found") {
    const orphans = (event.data["orphans"] ?? []) as Array<{ driver?: string; name?: string }>;
    return [
      `台帳に無い検証環境のリソースが ${orphans.length} 件あります`,
      "",
      "**起きたこと**",
      "照合（ドライバの `list` と台帳の突き合わせ）で、Banto が把握していない実リソースが" +
        "見つかりました。落ちている間に生じた孤児か、Banto 以外が作ったものです。",
      ...(orphans.length > 0
        ? ["", orphans.map((o) => `- ${o.name ?? "(名前なし)"}（${o.driver ?? "?"}）`).join("\n")]
        : []),
      "",
      "**求める判断**",
      "**機構は消しません**——台帳に無いものを勝手に消すと、Banto 以外が作ったものまで" +
        "巻き込みます。何なのかを確かめて、Banto のものなら手で片付けてください。",
    ].join("\n");
  }

  return undefined;
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
    console.error(`[banto] 検証環境の読み位置を保存できません: ${String(err)}`);
  }
}
