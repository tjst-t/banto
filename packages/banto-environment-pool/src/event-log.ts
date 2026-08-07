/**
 * 検証環境の衛生に関わる出来事のイベントログ（task-0067）。
 *
 * **なぜ要るか。** Environment Pool が独立サービスになったとき（task-0066）、畳み忘れ・
 * 畳み損ね・孤児の知らせがサービスのログに落ちるだけになった。番頭ホストに同居していた
 * 頃は `onAttention` のコールバックが会話へ繋がっていたが、別プロセスには繋げられない。
 *
 * 起動時にコールバックURLを渡す案は職人（決定29c）で既に不採用になっている——起動元が
 * 落ちている間の知らせが消え、再送を作り始めると結局ログが必要になる。だから同じく
 * **追記専用のログを置き、起動元が `afterEventId` で引きに行く**。
 *
 * D5: ここに意味の解釈は無い。中立な事実を並べるだけで、会話への言い換えは番頭側
 *     （`banto-host/src/env-notice.ts`）が持つ。
 * D6: node 標準のみ（JSONL）。
 * I2: 壊れた行は黙って捨てず、読めなかったことを呼び出し側へ返す。
 * I3: 外に残った検証環境は金銭的実害。**気づく契機を必ず1つは残す**。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * イベントの種類。**衛生に関わる3つだけ**（spec-environment §5）。
 *
 * 立てた・畳んだの実況は残さない——番頭の会話が検証環境の中継になる。Kobo は自分の帳簿に
 * `env_provisioned` を持ち、画面は `env.list` を見るので、読み手のいないイベントは増やさない。
 */
export type EnvEventType =
  /** 期限切れで機構が畳んだ（＝呼び出し側の畳み忘れ）。 */
  | "env_expired"
  /** リトライしても畳めなかった（＝外にリソースが残っている可能性）。 */
  | "env_teardown_failed"
  /** 照合で台帳に無い実リソースが見つかった（＝孤児）。 */
  | "env_orphans_found";

export interface EnvEvent {
  /** 1から始まる連番。購読の再開点（`afterEventId`）に使う。 */
  id: number;
  at: string;
  type: EnvEventType;
  /** どの環境の話か。孤児は特定の環境の話ではないので付かない。 */
  envId?: string;
  profile?: string;
  /** 種類ごとの中身。Environment Pool は解釈しない（D5）。 */
  data: Record<string, unknown>;
}

/** append に渡す形。id と at はログが付ける。 */
export type EnvEventInput = Omit<EnvEvent, "id" | "at">;

/**
 * 追記専用のイベントログ。
 *
 * ファイルは `<dataDir>/env-events.jsonl`。追記のみで書き換えないので、途中で落ちても
 * 既に書いた分は失われない（`WorkerEventLog` と同じ扱い）。
 */
export class EnvEventLog {
  private readonly filePath: string;
  private readonly events: EnvEvent[] = [];

  private constructor(filePath: string, events: EnvEvent[]) {
    this.filePath = filePath;
    this.events = events;
  }

  /**
   * 開く（無ければ作る）。
   *
   * @returns corruptionError は、読めた分は使いつつ「読めなかった行があった」ことを伝える
   *          （I2: 黙って捨てない。1行壊れただけで全部を失わせもしない）。
   */
  static open(dataDir: string): { log: EnvEventLog; corruptionError: string | null } {
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, "env-events.jsonl");
    if (!fs.existsSync(filePath)) {
      return { log: new EnvEventLog(filePath, []), corruptionError: null };
    }

    const events: EnvEvent[] = [];
    let broken = 0;
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as EnvEvent;
        if (typeof parsed.id === "number" && typeof parsed.type === "string") events.push(parsed);
        else broken++;
      } catch {
        broken++;
      }
    }
    return {
      log: new EnvEventLog(filePath, events),
      corruptionError: broken > 0 ? `env-events.jsonl: ${broken} 行が読めませんでした` : null,
    };
  }

  /** 1件積む。積んだ内容（id つき）を返す。 */
  append(input: EnvEventInput): EnvEvent {
    const event: EnvEvent = {
      id: (this.events[this.events.length - 1]?.id ?? 0) + 1,
      at: new Date().toISOString(),
      ...input,
    };
    this.events.push(event);
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
    } catch (err) {
      // I2: 書けなかったことを黙らせない。ただし知らせの記録が取れないからといって
      //     期限の執行（本体）を止めはしない——止めると外にリソースが残る方が悪い（I3）
      console.error(`[env] 出来事を記録できませんでした: ${String(err)}`);
    }
    return event;
  }

  /**
   * `afterEventId` より後のイベントを返す。取りこぼした分を後から追いつくための口。
   * @param afterEventId これより大きい id のものを返す（省略時は最初から）
   */
  since(afterEventId = 0, limit?: number): EnvEvent[] {
    const found = this.events.filter((e) => e.id > afterEventId);
    return limit === undefined ? found : found.slice(0, limit);
  }

  /** 最後に振った id。引く側が「ここから先」を指定するのに使う。 */
  get lastEventId(): number {
    return this.events[this.events.length - 1]?.id ?? 0;
  }
}
