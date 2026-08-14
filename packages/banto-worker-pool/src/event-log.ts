/**
 * 職人のライフサイクルのイベントログ（ADR-0010 決定29c）。
 *
 * **職人の真実は Worker Pool に一箇所**（D3）。起動元（Kobo・番頭・将来のモジュール）は
 * ここを購読する。起動時にコールバックURLを渡す案は不採用だった——起動元が落ちている間の
 * 報告が消え、再送を作り始めると結局ログが必要になるため。取りこぼしは `afterEventId` で
 * 追いつける。決定20 が Kobo→Banto で採った形と同じ。
 *
 * D5: ここに意味の解釈は無い。中立な事実と主張を並べるだけで、Kobo のステートマシンへの
 *     写しも番頭の会話への写しも、それぞれの起動元が自分でやる。
 * D6: node 標準のみ（JSONL）。
 * I2: 壊れた行は黙って捨てず、読めなかったことを呼び出し側へ返す。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * イベントの種類。
 *
 * 決定29(a): **完了は「事実」と「主張」を分ける。** プロセス終了は事実、職人の完了報告は
 * 主張。番頭は主張を参考にしつつ成果は自分で確かめる（I1）。どちらかに寄せると、
 * 「終わったと言っている」と「終わった」の区別がログの時点で消える。
 */
export type WorkerEventType =
  /** 起動した（事実）。 */
  | "worker_started"
  /** プロセスが終わった（事実）。 */
  | "worker_exited"
  /**
   * 職人を畳んだ（事実）。`data.reason` に done / idle / stopped が入る（決定30e）。
   * 理由が消えると履歴が「なぜ終わったのか」に答えられない。
   */
  | "worker_closed"
  /** 職人が「終わった／こうした」と報告した（主張）。 */
  | "worker_reported"
  /** 職人が質問した（主張）。答えが来るまで職人は待つ。 */
  | "worker_asked"
  /** 起動元が答えた・指示を足した（事実）。 */
  | "worker_answered"
  /**
   * **職人が喋り終わった**（事実。PO要望 2026-08-11）。
   *
   * ランタイムはターンの終わりを知っている。それを積むことで、起動元は「明示の報告」か
   * 「安全弁の時間切れ」を待たずに、**出力が終わった時点で**手が空いたことを知れる。
   * 「終わった」と言っているのではなく「喋り終わった」という事実なので、`fact`。
   * 意味（完了なのか、答え待ちで止まっただけか）は起動元が与える（決定29d）。
   */
  | "worker_turn_ended"
  /**
   * **職人の下で動いている実プロセスの pid が分かった**（事実。inc-0066）。
   *
   * 台帳は職人を畳むと消えるので、事故のあとに履歴から引けるようにここにも積む
   * （決定30c と同じ理由）。`data.children` に pid・親 pid・名前、突き止められなければ
   * `data.error` に理由が入る——空を「子が居なかった」と読ませないため（I2）。
   */
  | "worker_child_pids";

/** 事実か主張か。決定29(a)・I1。 */
export type WorkerEventKind = "fact" | "claim";

/** どの種類がどちらかは Worker Pool が決める（起動元ごとにぶれさせない）。 */
const KIND_OF: Record<WorkerEventType, WorkerEventKind> = {
  worker_started: "fact",
  worker_exited: "fact",
  worker_closed: "fact",
  worker_answered: "fact",
  worker_turn_ended: "fact",
  worker_child_pids: "fact",
  worker_reported: "claim",
  worker_asked: "claim",
};

export interface WorkerEvent {
  /** 1から始まる連番。購読の再開点（afterEventId）に使う。 */
  id: number;
  at: string;
  type: WorkerEventType;
  kind: WorkerEventKind;
  /**
   * 宛先＝この職人を起こしたのは誰か（決定29）。
   * **projectTag とは別物。** projectTag は作業の名前空間で、Kobo は複数の projectTag を
   * 持つため宛先にならない。
   */
  origin: string;
  projectTag: string;
  taskId: string;
  sessionId: string;
  /** 種類ごとの中身。Worker Pool は解釈しない（D5）。 */
  data: Record<string, unknown>;
}

/** 購読・取得の絞り込み。起動元は自分が起こした職人の分だけを見られる（a4）。 */
export interface WorkerEventFilter {
  origin?: string;
  projectTag?: string;
  sessionId?: string;
  type?: WorkerEventType;
}

export type WorkerEventHandler = (event: WorkerEvent) => void;

/** append に渡す形。id・at・kind はログが付ける。 */
export type WorkerEventInput = Omit<WorkerEvent, "id" | "at" | "kind">;

function matches(event: WorkerEvent, filter: WorkerEventFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.origin !== undefined && event.origin !== filter.origin) return false;
  if (filter.projectTag !== undefined && event.projectTag !== filter.projectTag) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.type !== undefined && event.type !== filter.type) return false;
  return true;
}

/**
 * 追記専用のイベントログ。
 *
 * ファイルは `<dataDir>/worker-events.jsonl`。追記のみで書き換えないので、
 * 途中で落ちても既に書いた分は失われない。
 */
export class WorkerEventLog {
  private readonly filePath: string;
  private readonly events: WorkerEvent[] = [];
  private readonly handlers = new Set<{ handler: WorkerEventHandler; filter?: WorkerEventFilter }>();

  private constructor(filePath: string, events: WorkerEvent[]) {
    this.filePath = filePath;
    this.events = events;
  }

  /**
   * 開く（無ければ作る）。
   *
   * @returns corruptionError は、読めた分は使いつつ「読めなかった行があった」ことを伝える。
   *          I2: 黙って捨てない。ただし1行壊れただけで全部を失わせもしない（追記専用ログの常）。
   */
  static open(dataDir: string): { log: WorkerEventLog; corruptionError: string | null } {
    fs.mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, "worker-events.jsonl");
    if (!fs.existsSync(filePath)) {
      return { log: new WorkerEventLog(filePath, []), corruptionError: null };
    }

    const events: WorkerEvent[] = [];
    let broken = 0;
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as WorkerEvent;
        if (typeof parsed.id === "number" && typeof parsed.type === "string") events.push(parsed);
        else broken++;
      } catch {
        broken++;
      }
    }
    return {
      log: new WorkerEventLog(filePath, events),
      corruptionError: broken > 0 ? `worker-events.jsonl: ${broken} unreadable line(s)` : null,
    };
  }

  /** 1件積む。積んだ内容（id つき）を返す。 */
  append(input: WorkerEventInput): WorkerEvent {
    const event: WorkerEvent = {
      id: (this.events[this.events.length - 1]?.id ?? 0) + 1,
      at: new Date().toISOString(),
      kind: KIND_OF[input.type],
      ...input,
    };
    this.events.push(event);
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);

    for (const { handler, filter } of this.handlers) {
      if (!matches(event, filter)) continue;
      try {
        handler(event);
      } catch {
        // I2 の例外: 購読側の失敗で Worker Pool を止めない。握りつぶす範囲は
        // 「1つの購読者の失敗が他の購読者と本体に波及しないこと」に限る
      }
    }
    return event;
  }

  /**
   * `afterEventId` より後のイベントを返す。取りこぼした分を後から追いつくための口（a1）。
   * @param afterEventId これより大きい id のものを返す（省略時は最初から）
   */
  since(afterEventId = 0, filter?: WorkerEventFilter, limit?: number): WorkerEvent[] {
    const found = this.events.filter((e) => e.id > afterEventId && matches(e, filter));
    return limit === undefined ? found : found.slice(0, limit);
  }

  /** 直近のイベント。 */
  last(filter?: WorkerEventFilter): WorkerEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i]!;
      if (matches(event, filter)) return event;
    }
    return undefined;
  }

  /** 最後に振った id。購読を始める側が「ここから先」を指定するのに使う。 */
  get lastEventId(): number {
    return this.events[this.events.length - 1]?.id ?? 0;
  }

  /**
   * 購読する。戻り値で解除。
   *
   * `afterEventId` を渡すと、まず溜まっている分を配ってから以後の分を流す——
   * 起動元が落ちていた間の報告を取りこぼさないため（決定29c）。
   */
  subscribe(
    handler: WorkerEventHandler,
    options: WorkerEventFilter & { afterEventId?: number } = {}
  ): () => void {
    const { afterEventId, ...filter } = options;
    const entry = { handler, ...(Object.keys(filter).length > 0 ? { filter } : {}) };
    this.handlers.add(entry);

    if (afterEventId !== undefined) {
      for (const event of this.since(afterEventId, filter)) {
        try {
          handler(event);
        } catch {
          // append と同じ理由（購読側の失敗を本体に波及させない）
        }
      }
    }
    return () => this.handlers.delete(entry);
  }

  /** 購読をすべて解除する。 */
  clearSubscribers(): void {
    this.handlers.clear();
  }
}
