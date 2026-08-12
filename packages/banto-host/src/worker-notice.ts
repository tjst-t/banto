/**
 * 職人のイベントを番頭の会話へ写す（ADR-0010 決定29d）。
 *
 * Worker Pool は中立な事実と主張を並べるだけで、**意味は起動元が与える**。これは番頭側の
 * 解釈——Kobo は同じイベントを自分のステートマシンへ写す（task-0024）。だからこの翻訳は
 * Worker Pool ではなく banto-host に置く。
 *
 * D5: 判断は無い。何を番頭に見せるかの選別と、日本語への言い換えだけ。
 * I1: 職人の報告は**主張**として渡す。「終わったと言っている」を「終わった」に翻訳しない。
 */

import type { WorkerEvent } from "@banto/worker-pool";

/** 番頭が起動元として名乗る名前（決定29の宛先）。 */
export const BANTO_ORIGIN = "banto";

/** スレッド宛の起動元名の区切り。 */
const ORIGIN_SEPARATOR = ":";

/**
 * スレッド宛の起動元名（決定35a）。
 *
 * 職人の報告は**起こしたスレッド**へ返る必要がある。決定29 の `origin` はもともと
 * 「起動元＝報告の宛先」なので、そこをスレッド粒度にするだけで機構はそのまま使える
 * ——Worker Pool 側の改修は要らない。
 */
export function threadOrigin(threadId: string): string {
  return `${BANTO_ORIGIN}${ORIGIN_SEPARATOR}${threadId}`;
}

/**
 * 起動元名からスレッドを引く。番頭が起こしたものでなければ undefined。
 *
 * `banto`（スレッド以前の名乗り）は既定スレッド宛として扱う——過去に起こした職人の
 * 報告が宛先不明で消えないようにするため。Kobo 等、別の起動元の分は拾わない。
 */
export function threadIdOfOrigin(origin: string): string | undefined {
  if (origin === BANTO_ORIGIN) return undefined;
  const prefix = `${BANTO_ORIGIN}${ORIGIN_SEPARATOR}`;
  return origin.startsWith(prefix) ? origin.slice(prefix.length) : undefined;
}

/** 番頭が起こした職人か（他の起動元＝Kobo 等の分は番頭の会話に入れない）。 */
export function isBantoOrigin(origin: string): boolean {
  return origin === BANTO_ORIGIN || origin.startsWith(`${BANTO_ORIGIN}${ORIGIN_SEPARATOR}`);
}

/**
 * 番頭に知らせるイベントかどうか。
 *
 * 起動・停止・回答は**番頭自身がやったこと**なので知らせない。知らせると、番頭の操作が
 * そのまま番頭への入力に戻り、ターンが際限なく回る。番頭が知りたいのは
 * 「自分が起こしていないこと」——職人が言ってきたことと、プロセスが終わったこと。
 *
 * **畳んだこと（`worker_closed`）は知らせない**（PO裁定 2026-08-06）。職人が1人終わるたびに
 * 「畳みました」と「プロセスが終わりました」の2通が並んで届いていた——同じ出来事を2度
 * 読ませている。
 *
 * **番頭が畳んだ結果の `worker_exited` も知らせない**（PO要望 2026-08-11）。上の裁定で
 * 片方を落としたが、残した側も**番頭が自分でやったこと**だった——`close` は kill してから
 * 畳むので、終了は必ず先に積まれる。結局「畳みました」の代わりに「終了しました」を
 * 読まされていただけで、無駄な一通は消えていなかった。予期していない死だけを残す。
 *
 * 決定30b（安全弁が働いたことに気づけるように）は**イベントログ側で保つ**——`reason` は
 * 今までどおり記録され、`worker.list` / `worker.events` と職人ビューアから引ける（決定30e）。
 * 会話へ押し込まないだけで、見えなくはしない。
 */
export function isNoticeworthy(event: WorkerEvent): boolean {
  /**
   * **喋り終わったのに、それが番頭へ伝わっていないとき**は知らせる（PO指摘 2026-08-11）。
   *
   * ターンの終わり方は4つあり、3つは既に何かが届いている（安全弁の代理報告・質問・
   * 完了の報告）。抜けていたのは**進捗だけ報告して手を止めた**とき——番頭には
   * 「着手しました」しか届かず、まだ動いていると読むが、実際は手が空いている。
   * その1つだけを拾う。工房が `settled` として判定済み（台帳が真実・D3）。
   */
  if (event.type === "worker_turn_ended") {
    return event.data["settled"] !== true;
  }
  /**
   * **自分で畳んだ職人の「終わりました」は知らせない**（PO要望 2026-08-11）。
   *
   * `worker.close` は killしてから畳むので、`worker_exited` が必ず先に積まれる
   * ——番頭から見ると「自分で畳んだのに、そのあとプロセス終了を知らされる」ことになり、
   * 一通が必ず無駄に並んでいた（実測：356人中315人）。**起動・停止は番頭自身がやったこと
   * なので知らせない**という、このファイルの元からの決めに揃える。
   *
   * **予期していない死は今までどおり知らせる**——作業中に落ちたことは、番頭がやって
   * いないことで、知らなければ気づけない。工房が `expected` を付けて区別している。
   */
  if (event.type === "worker_exited") {
    return event.data["expected"] !== true;
  }
  return event.type === "worker_reported" || event.type === "worker_asked";
}

/** 1行目に出す見出し。UI は畳んだ状態でここだけを見せるので、短く・中身が分かるように。 */
function headline(event: WorkerEvent): string {
  // UI 側は「職人」の札を別に出すので、ここでは繰り返さない（畳んだ1行は狭い）
  const who = event.taskId;
  switch (event.type) {
    case "worker_asked":
      return `${who}から質問：${firstLine(String(event.data["question"] ?? ""))}`;
    case "worker_reported":
      // 自動報告は職人が書いたものではない。見出しで区別する（I1：出所を偽らない）
      return event.data["auto"] === true
        ? `${who}が報告せずに手を止めました：${firstLine(String(event.data["summary"] ?? ""))}`
        : `${who}から報告：${firstLine(String(event.data["summary"] ?? ""))}`;
    case "worker_turn_ended":
      return `${who}の手が空きました${
        String(event.data["text"] ?? "").trim().length > 0
          ? `：${firstLine(String(event.data["text"]))}`
          : "（発話なし）"
      }`;
    default: {
      const signal = event.data["signal"];
      const code = event.data["exitCode"];
      const how =
        signal !== null && signal !== undefined
          ? `シグナル ${String(signal)} で落ちました`
          : code === 0
            ? "正常に終了しました"
            : `終了コード ${String(code)} で終わりました`;
      return `${who}のプロセスが${how}`;
    }
  }
}

/**
 * 見出し用に1行へ潰す。Markdownの記号は畳んだ表示では邪魔になる。
 *
 * 見出し行（`## 完了報告` 等）は中身を語らないので、本文があればそちらを優先する
 * ——「完了報告」とだけ出ても、何が起きたか分からない。
 */
function firstLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const clean = (l: string): string => l.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
  const body = lines.find((l) => !l.startsWith("#"));
  return clean(body ?? lines[0] ?? "") || "(内容なし)";
}

/**
 * イベントを番頭への知らせに言い換える。知らせないイベントなら undefined。
 *
 * **1行目が見出し**で、以降が詳細。UI は畳んだ状態で1行目だけを見せるため、
 * sessionId のような機械向けの情報は下に置く——畳んだときに中身が見えなくなる。
 */
export function renderWorkerNotice(event: WorkerEvent): string | undefined {
  if (!isNoticeworthy(event)) return undefined;
  const lines = [headline(event), "", `sessionId: ${event.sessionId}`];

  if (event.type === "worker_asked") {
    lines.push(
      "",
      `> ${String(event.data["question"] ?? "")}`,
      "",
      "答えが来るまでこの職人は待っています。答えられるなら worker.steer で返してください。" +
        "不可逆な選択や PO の意向が要る話（D1）なら、あなたの判断で PO に上げてください。"
    );
  } else if (event.type === "worker_turn_ended") {
    const text = String(event.data["text"] ?? "").trim();
    if (text.length > 0) lines.push("", `> ${text}`);
    lines.push(
      "",
      "**報告はありましたが、そのあと手が止まっています。** 続きがあるつもりなら " +
        "worker.steer で渡してください。終わっているなら成果を確かめて worker.close で" +
        "畳んでください——放っておくと安全弁の時間まで残ります（I3）。"
    );
  } else if (event.type === "worker_reported") {
    lines.push("", `> ${String(event.data["summary"] ?? "")}`, "");
    lines.push(
      event.data["auto"] === true
        ? "**これは職人が書いた報告ではありません。** 報告しないまま手を止めたので、" +
            "最後の発話を安全弁が代わりに送っています——作業が本当に終わったのかも含めて" +
            "自分で確かめてください（I1）。続きが要るなら worker.steer、良ければ worker.close。"
        : "**これは職人の主張であって完了の証明ではありません**——必要なら成果を自分で確かめてください（I1）。" +
            "確かめて良ければ worker.close で畳んでください。"
    );
  }

  return lines.join("\n");
}

// ── 引きに行く形（task-0066）──────────────────────────────────────────────────

/** 職人のイベントを引く口（`worker.events` を持つ Tool 群）。 */
export interface WorkerNoticeOptions {
  /** `worker.*` Tool（モジュールから束ねたもの）。 */
  tools: Array<{ name: string; execute(args: never, ctx?: { toolCallId: string }): Promise<unknown> }>;
  /** 会話へ知らせる（宛先スレッドつき）。 */
  notify(message: string, target: { threadId?: string }): Promise<void>;
  /** 引く間隔（ms）。既定 1500——職人の質問を待たせすぎない値 */
  intervalMs?: number;
  log?(message: string): void;
}

/**
 * 職人の知らせを引き始める。返り値で止める。
 *
 * **購読ではなく引きに行く**（task-0066）。工房（Worker Pool）が独立サービスになったので、
 * 同一プロセスの `subscribe` は使えない——Kobo と同じ形（`kobo-notice.ts`）で
 * `worker.events` を `afterEventId` 付きで追う。
 *
 * **起動より前の分は流さない。** 最初の1回で今の位置（`lastEventId`）まで進めてから
 * 追い始める——落ちている間に溜まった古い報告を、今さら会話へ流し込まない
 * （同居していた頃の `afterEventId: pool.lastEventId` と同じ振る舞い）。
 *
 * 宛先は決定35a のとおり**起こしたスレッド**。他の起動元（Kobo 等）の分は届かない。
 */
export function startWorkerNotices(options: WorkerNoticeOptions): () => void {
  const interval = options.intervalMs ?? 1500;
  const log = options.log ?? ((m: string) => console.error(m));
  const invoke = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> => {
    const tool = options.tools.find((t) => t.name === name);
    // I2: 配線されていないことを「結果なし」にしない
    if (!tool) throw new Error(`${name} が登録されていません（Worker Pool モジュールが未配線）`);
    const result = (await tool.execute(args as never, { toolCallId: `worker-notice-${Date.now()}` })) as {
      details?: Record<string, unknown>;
    };
    return (result.details ?? {}) as Record<string, unknown>;
  };

  /** 未設定。最初の tick で今の位置まで進める（起動前の分を流さないため） */
  let cursor: number | undefined;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      if (cursor === undefined) {
        const details = await invoke("worker.events", { limit: 1 });
        cursor = Number(details["lastEventId"] ?? 0);
        return;
      }
      const details = await invoke("worker.events", { afterEventId: cursor, limit: 100 });
      const events = (details["events"] ?? []) as WorkerEvent[];
      for (const event of events) {
        cursor = Math.max(cursor, event.id ?? 0);
        if (!isBantoOrigin(event.origin)) continue;
        const notice = renderWorkerNotice(event);
        if (!notice) continue;
        const threadId = threadIdOfOrigin(event.origin);
        try {
          await options.notify(notice, threadId ? { threadId } : {});
        } catch (err) {
          // 決定35b: 宛先スレッドが畳まれていたら既定へ逃がす。**消えたことにしない**（I2）
          log(`[banto] 知らせの宛先 ${String(threadId)} が見つかりません: ${String(err)}`);
          await options.notify(notice, {}).catch(() => undefined);
        }
      }
    } catch (err) {
      // I2: 引けなかったことを黙って握らない。写しを進めないので次の tick で取り直す
      log(`[banto] 職人の知らせを引けませんでした: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
