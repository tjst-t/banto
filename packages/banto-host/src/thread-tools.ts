/**
 * `thread.*` Tool — 番頭が自分で分身する口（ADR-0010 決定2・task-0035）。
 *
 * **「いつ分身するか」の判断はここに無い**（epic-0006 のスコープ外）。機構だけ用意し、
 * プロンプトでも促さない——まず手動で複数スレッドを持てる状態を作り、自動化はその後。
 *
 * 番頭が分身できることが要件なのは、「番頭は分身する」（vision）の主語が番頭だから。
 * PO しか新しい会話を作れないなら、それは分身ではなく画面の操作でしかない。
 *
 * **会話に名前を付け直す口（`thread.rename`）もここ**（PO要望 2026-08-05）。開くときに
 * 付けた名前は仮のもので、話が進めば合わなくなる——名付けの主語も番頭にする。
 * 「いつ付け直すか」の促しだけは例外的にプロンプトへ置く（分身と違い、これは要件）。
 *
 * D5: 判断は無い。スレッドを起こす・名前を書き換える・並べるだけ。
 */

import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { BranchNoteKind, TranscriptEntry } from "./protocol.js";
import { trunkIdOf, type Thread, type ThreadRegistry } from "./threads.js";

export interface ThreadToolsOptions {
  threads: ThreadRegistry;
  /**
   * この Tool を渡す先のスレッド。**番頭には書かせない**（決定35a と同じ理由——
   * 番頭は自分の threadId を知らないし、書かせれば別の会話に名前を付けてしまう）。
   */
  threadId: string;
  /**
   * 新しいスレッドへ最初の一言を届ける。ターンが回り、分身が話し始める。
   * 省略すると、開くだけで何も起きない（PO が話しかけるまで待つ）。
   *
   * **返る約束はターンの完走**（`server.notify`）。だから呼ぶ側は待たない
   * （下の `handOff` を通す）——待つと、開いた側の会話がその間ずっと止まる。
   */
  seed?: (threadId: string, message: string) => Promise<void>;
  /**
   * 幹を終うときに**持って出る記憶**を横断の層へ上げる（PO裁定 2026-08-09）。
   *
   * 枝を畳むと結論1行が幹へ還るのと同じ形が、一段上で繰り返される——幹を終うと、
   * その仕事で得た一般解が横断の層へ還る。**選別するのは番頭**（何を持って出るかは
   * 判断であって、機械には決められない）。渡さないと `thread.close_trunk` は生えない。
   *
   * @returns 実際に足した件数
   */
  carryOut?: (texts: readonly string[]) => Promise<number> | number;
  /**
   * **別の幹へ言伝を届ける**（PO要望 2026-08-10）。届いた側はターンが回り、番頭が読む。
   *
   * `seed` と同じ経路（`server.notify`）だが、こちらは**開くためではなく渡すため**。
   * 渡さないと `thread.send` は生えない。
   */
  deliver?: (threadId: string, message: string) => Promise<void>;
  /**
   * **記録は済んでいる前提で、宛先の番頭のターンだけ回す**（決定107）。
   *
   * `deliver` との違いは、会話に知らせの行を積まないこと——枝からの相談は
   * `ThreadRegistry.consult` が既に**札**として幹へ積んでいるので、ここで知らせも積むと
   * 同じ一言が2行に見える。渡さないと `thread.consult` は生えない。
   */
  nudge?: (threadId: string, message: string) => Promise<void>;
}

/** `thread.read` が1回に返す記録の既定の件数。 */
const READ_DEFAULT_LIMIT = 20;
/**
 * 1回に返せる記録の上限。**全文を無条件に返さない**——枝のやりとりは幹の文脈より
 * 長いことがあり、丸ごと載せると読むために開いた側が先に潰れる。
 * 大きくなった結果は退避され、栞から `artifact.read` で引ける（決定47a）。
 */
const READ_MAX_LIMIT = 100;
/** 記録1行あたりの上限（文字）。長い発話はここで切る。 */
const ENTRY_MAX_CHARS = 400;

function clip(text: string, max = ENTRY_MAX_CHARS): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…（略）` : flat;
}

/**
 * 記録1行を、番頭が読める1行にする（決定105）。
 *
 * **思考は中身を出さない。** 番頭の思考は本文の何倍にもなるうえ、他の会話の思考を
 * 読んでも判断の足しにならない——在ったことと長さだけ出す。
 */
export function renderTranscriptEntry(entry: TranscriptEntry): string {
  switch (entry.role) {
    case "po":
      return `PO: ${clip(entry.text)}`;
    case "banto":
      return `番頭: ${clip(entry.text)}`;
    case "reasoning":
      return `（思考 ${entry.text.length}字）`;
    case "notice":
      return `知らせ[${entry.source}]: ${clip(entry.text)}`;
    case "tool":
      return `道具 ${entry.name}（${entry.state}）`;
    case "utsuwa":
      return `器（${entry.utsuwa.kind}）`;
    case "branch":
      return `枝の札 → ${entry.branchId}`;
    case "branch_result":
      return `枝「${entry.title}」を畳んだ：${clip(entry.conclusion)}`;
    case "branch_note":
      return `枝「${entry.title}」からの${entry.kind === "question" ? "問い" : "報告"}：${clip(entry.text)}`;
    case "chapter":
      return `— 第${entry.chapter}章までを畳んだ（${entry.topic}）—`;
    case "error":
      return `失敗: ${clip(entry.text)}`;
  }
}

/**
 * 畳むときの詳細を1枚の書き付けにする（決定108）。
 *
 * **書かれた欄だけを出す。** 空の見出しを並べると、読む側は「調べなかった」のか
 * 「書かなかった」のか区別できない。何も渡されなければ詳細そのものを作らない。
 */
export function renderMergeDetail(params: {
  investigated?: readonly string[];
  decided?: readonly string[];
  remaining?: readonly string[];
}): string | undefined {
  const sections: Array<[string, readonly string[] | undefined]> = [
    ["調べたこと", params.investigated],
    ["決めたこと", params.decided],
    ["残ったこと", params.remaining],
  ];
  const out: string[] = [];
  for (const [heading, items] of sections) {
    const lines = (items ?? []).map((t) => t.trim()).filter((t) => t !== "");
    if (lines.length === 0) continue;
    out.push(`## ${heading}`, ...lines.map((t) => `- ${t}`), "");
  }
  const text = out.join("\n").trim();
  return text === "" ? undefined : text;
}

/**
 * 会話の頭書き（決定105）。**状態と、いま何を待っているか**を先に出す。
 *
 * 中身より先にこれが要る——「まだ動いているのか、もう畳んだのか」で読み方が変わるし、
 * 畳んだ枝なら結論と詳細だけで用が足りることが多い。
 */
function renderThreadHead(thread: Thread, registry: ThreadRegistry): string[] {
  const what = thread.isMain ? "帳場" : thread.kind === "trunk" ? "幹" : "枝";
  const state = thread.state === "open" ? "開いている" : "畳んである";
  const lines = [`${what}「${thread.title}」（${thread.id}・${state}）`];
  if (thread.parentId) {
    const parent = registry.get(thread.parentId);
    lines.push(`親：${parent ? `幹「${parent.title}」（${parent.id}）` : thread.parentId}`);
  }
  if (thread.returnCondition) lines.push(`還す条件：${thread.returnCondition}`);
  if (thread.openReason) {
    lines.push(`開いた理由：${thread.openReason}（${thread.openedBy === "po" ? "POの指示" : "番頭の判断"}）`);
  }
  if (thread.conclusion) lines.push(`結論：${thread.conclusion}`);
  if (thread.conclusionDetail) {
    // **詳細はここで全部出す**（決定108）。幹に流していないので、開いたときに読めなければ
    // どこにも無いのと同じになる
    lines.push("詳細：", thread.conclusionDetail);
  }
  lines.push(`最後に何かが記録されたのは ${thread.lastActivityAt}`);
  return lines;
}

/**
 * 別の会話へ一言を**渡すだけ渡して、待たない**（PO報告 2026-08-11）。
 *
 * `server.notify` が返るのは**宛先のターンが完走したとき**。待つと、枝を開いた幹が
 * 枝の調べ物が終わるまで「思考中」のまま固まり、終わった途端に動き出して**同じ検討を
 * もう一度やる**（枝が何を出したかは幹の文脈に入らないので、続きから再開してしまう）。
 * 実際に起きた形なので、機構で切る。
 *
 * I2: 渡せなかったことは黙らせない。宛先の会話には `notify` 側が error を記録するが、
 * 宛先そのものが引けない場合はそこにも残らないので、ここでログに出す。
 */
function handOff(
  deliver: (threadId: string, message: string) => Promise<void>,
  threadId: string,
  message: string,
  what: string
): void {
  void deliver(threadId, message).catch((err) => {
    console.error(`[banto] ${what}（${threadId}）を渡せませんでした: ${String(err)}`);
  });
}

/**
 * 言伝の**出どころの名乗り**（PO報告 2026-08-11）。
 *
 * もとは送り手を無条件に `幹「…」` と書いていた。だが**枝からも言伝は出せる**ので、
 * 枝の名前が幹の名前として届いていた——実際に「幹『単語の固まり表示と絵』から言伝です」
 * と名乗っており、受け手はそんな名前の幹があると読む。
 *
 * 記憶も文脈も分かれる単位は**幹**（ADR-0003 追補）なので、受け手が知りたいのは
 * 「どの幹の話か」。枝から出たなら**親の幹を主にして、枝を添える**。
 *
 * I1: 出所を偽らない。分からないものを幹と言い切らない。
 */
export function senderLabel(threads: ThreadRegistry, me: Thread | undefined): string {
  if (!me) return "別の会話";
  if (me.kind !== "branch") return `幹「${me.title}」`;
  const parent = me.parentId ? threads.get(me.parentId) : undefined;
  // 親が引けないなら幹の名前は騙らない。枝であることだけ言う
  return parent
    ? `幹「${parent.title}」の枝「${me.title}」`
    : `枝「${me.title}」`;
}

/**
 * 幹どうしの言伝が往復し続けるのを止める（P4）。
 *
 * **頼むだけでは止まらない。** 両側とも番頭なので、「返事をありがとう」「こちらこそ」で
 * いくらでも続けられる——PO の見ていないところでトークンだけが減る。だから機構で止める。
 *
 * 数えるのは**向きのある組**（A→B と B→A は別）。窓の中で上限に達したら断り、
 * 「PO に上げるか、直接その幹で話してもらえ」と理由を返す。
 */
const SEND_WINDOW_MS = 10 * 60 * 1000;
const SEND_MAX_PER_WINDOW = 5;
/**
 * 幹と枝の間（`thread.steer` / `thread.consult`）の上限（決定106・107）。
 *
 * **幹どうしより緩くする。** 親子の往復は仕事そのもので、方針を渡す・相談が返る・
 * また渡す、は正常な進み方である。それでも上限を置くのは、両側とも番頭なので
 * 「ありがとうございます」「こちらこそ」が無限に続けられるから（P4）。
 */
const STEER_MAX_PER_WINDOW = 10;

/** 直近の言伝（送り元→宛先ごとの時刻）。プロセスの寿命でよい——長期の事実ではない。 */
const recentSends = new Map<string, number[]>();

/** 窓の中の回数を数え、上限内なら記録して true。 */
export function allowSend(
  from: string,
  to: string,
  now: number,
  window = SEND_WINDOW_MS,
  max = SEND_MAX_PER_WINDOW
): boolean {
  const key = `${from}\u0000${to}`;
  const fresh = (recentSends.get(key) ?? []).filter((at) => now - at < window);
  if (fresh.length >= max) {
    recentSends.set(key, fresh);
    return false;
  }
  fresh.push(now);
  recentSends.set(key, fresh);
  return true;
}

/** 試験用：数えた分を忘れる。 */
export function resetSendCounters(): void {
  recentSends.clear();
}

/**
 * 特定の引数を**固定して**Tool を渡す。
 *
 * 職人を起こすとき、番頭に「自分がどのスレッドか」を書かせない（決定35a）。
 * 書かせると間違えるし、そもそも番頭は自分の threadId を知らない——`worker.report` で
 * 職人に自分の識別子を書かせないのと同じ理由（決定29e）。
 *
 * 呼び出し側の引数で**上書きされない**ように後ろに置く。あるスレッドの番頭が
 * 別スレッド宛に職人を起こせてしまうと、報告が知らない会話に現れる。
 */
export function bindToolArgs(
  tool: NamespacedToolDefinition,
  fixed: Record<string, unknown>
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args, ctx) {
      return tool.execute({ ...(args as Record<string, unknown>), ...fixed }, ctx);
    },
  };
}

export function createThreadTools(options: ThreadToolsOptions): NamespacedToolDefinition[] {
  const open = defineNamespacedTool({
    name: "thread.open",
    label: "Thread: Open",
    description:
      "**枝**を開いて続く議論・調査をそちらへ移す。開いた瞬間に幹へ札が1行立つ。\n例: {title: \"道具定義の圧縮\", returnCondition: \"前後の対比較が出たら\", reason: \"幹と混ざる\", message: \"実ログ由来の題材で測ってほしい\"} → 枝の id\n**渡したら手を離す**（同じ調べ物をこの会話で始めない）。",
    parameters: Type.Object({
      title: Type.String(),
      returnCondition: Type.String(),
      reason: Type.String(),
      message: Type.Optional(Type.String())
    }),
    async execute(params) {
      // 番頭が開いたので openedBy は banto。深さ1段は帳簿が実行時に縛る（決定77）
      const thread = await options.threads.open(
        {
          kind: "branch",
          title: params.title,
          returnCondition: params.returnCondition,
          openedBy: "banto",
          reason: params.reason,
        },
        options.threadId
      );
      if (params.message && options.seed) {
        // 種を蒔くのは開いたあと。**待たない**（handOff）——待つと、この幹が枝の作業の間
        // ずっと止まる。失敗しても開いたことは取り消さない（スレッドは既にある・I2）
        handOff(options.seed, thread.id, params.message, "枝への最初の一言");
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `枝「${thread.title}」を開きました (threadId: ${thread.id})。` +
              `還す条件：${params.returnCondition}。幹に札を立てました。` +
              (params.message
                ? "**この枝はもう自分で動いています**——同じ調べ物をここで始めないこと。" +
                  "結論は畳まれたときに幹へ1行還ります"
                : "まだ誰も話しかけていません"),
          },
        ],
        details: thread.view(),
      };
    },
  });

  /**
   * **枝の中身を読む**（決定105・PO指示 2026-08-13）。
   *
   * 決定77 では、幹から枝へ見えるのは札と結論1行だけだった——**枝の中で何が起きているか
   * 幹から確かめる手段が無い**ので、番頭は「枝で見ています」と言ったきり、止まっているのか
   * 進んでいるのかも分からなかった。畳んだ枝の中身も同じで、消えていないのに読めなかった。
   *
   * **全文は返さない。** 範囲で切り（既定は末尾 `READ_DEFAULT_LIMIT` 件）、1行ずつも切り詰める。
   * それでも大きければ退避されて栞になる（決定47a）ので、`artifact.read` で辿れる。
   *
   * **幹をまたいで読ませない。** 記憶も文脈も幹ごとに分かれている（ADR-0003 追補）ので、
   * 隣の幹の中身が読めると分けた意味が消える。用があるなら `thread.send`。
   */
  const read = defineNamespacedTool({
    name: "thread.read",
    label: "Thread: Read",
    description:
      "枝の様子と、そこでのやりとりを読む（開いている枝も、畳んだ枝も）。\n" +
      '入: `{ threadId: "thread-12" }` → 出: 「枝「再現条件の特定」（開いている）／還す条件：…／' +
      "記録 全84件のうち 65〜84件目」と、その20行。\n" +
      "頭から辿るなら `{ threadId, offset: 1, limit: 50 }`。読めるのはこの幹とその枝だけ。",
    parameters: Type.Object({
      threadId: Type.String({ description: "読む会話の id（thread.list・幹の札で分かる）" }),
      offset: Type.Optional(
        Type.Number({
          description: "何件目から読むか（1始まり）。省略すると末尾から",
        })
      ),
      limit: Type.Optional(
        Type.Number({ description: `何件読むか（既定 ${READ_DEFAULT_LIMIT}・上限 ${READ_MAX_LIMIT}）` })
      ),
    }),
    async execute(params) {
      const me = options.threads.get(options.threadId);
      const target = options.threads.get(params.threadId);
      // I2: 知らないIDを黙って自分の会話にしない（別の枝の中身を読んだと誤解する）
      if (!target) {
        throw new Error(
          `${params.threadId} という会話はありません（thread.list で確かめてください）`
        );
      }
      if (me && trunkIdOf(target) !== trunkIdOf(me)) {
        throw new Error(
          `${target.id} は別の幹の会話です。幹をまたいで中身は読めません` +
            "（伝えたいことがあるなら thread.send で言伝を渡してください）"
        );
      }
      const all = target.transcript;
      const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? READ_DEFAULT_LIMIT)), READ_MAX_LIMIT);
      const from =
        params.offset !== undefined
          ? Math.max(1, Math.trunc(params.offset))
          : Math.max(1, all.length - limit + 1);
      const slice = all.slice(from - 1, from - 1 + limit);
      const to = from + slice.length - 1;
      const body =
        all.length === 0
          ? "まだ何も記録されていません"
          : slice.length === 0
            ? `${from} 件目から先には何もありません（全 ${all.length} 件）`
            : [`記録 全 ${all.length} 件のうち ${from}〜${to} 件目`, ...slice.map(renderTranscriptEntry)].join(
                "\n"
              );
      const more: string[] = [];
      if (from > 1) more.push(`前を読む: thread.read({ threadId: "${target.id}", offset: ${Math.max(1, from - limit)}, limit: ${limit} })`);
      if (to < all.length)
        more.push(`続きを読む: thread.read({ threadId: "${target.id}", offset: ${to + 1}, limit: ${limit} })`);
      return {
        content: [
          {
            type: "text" as const,
            text: [...renderThreadHead(target, options.threads), "", body, ...more].join("\n"),
          },
        ],
        details: { thread: target.view(), total: all.length, from, to },
      };
    },
  });

  /**
   * **開いている枝へ、途中から言伝を渡す**（決定106・PO指示 2026-08-13）。
   *
   * いままで枝へ渡せるのは `thread.open` の `message` だけで、**起動後は外から話しかけ
   * られなかった**。方針が変わっても、前提が崩れても、枝が畳むまで待つしかない。
   *
   * 決定77 の「枝には送れない（1つの問いに閉じているので割り込ませない）」は、
   * **親の幹からに限って覆る**（PO指示）。隣の幹からは相変わらず渡せない——それは
   * 割り込みであって差配ではない。
   */
  const steer = defineNamespacedTool({
    name: "thread.steer",
    label: "Thread: Steer",
    description:
      "開いている**自分の枝**へ、途中から言伝を渡す（方針が変わった・前提が崩れた・返事）。\n" +
      '入: `{ threadId: "thread-12", message: "計測は不要になった。再現条件だけで畳んでよい" }`' +
      " → 出: 「枝「…」へ渡しました」。枝は知らせとして受け取り、そのまま動き出す。\n" +
      "他の幹の枝へは渡せない。幹へ渡すなら thread.send。",
    parameters: Type.Object({
      threadId: Type.String({ description: "宛先の枝の id（thread.list・幹の札で分かる）" }),
      message: Type.String({
        description:
          "渡す言伝。枝はこの会話の続きを知らないので、**何をどう変えてほしいか**を書き切る",
      }),
    }),
    async execute(params) {
      if (!options.deliver) {
        throw new Error("この構成では言伝を渡せません（deliver が渡されていません）");
      }
      const me = options.threads.get(options.threadId);
      const to = options.threads.get(params.threadId);
      if (!to) {
        throw new Error(
          `${params.threadId} という会話はありません（thread.list で確かめてください）`
        );
      }
      if (to.kind !== "branch") {
        throw new Error(`${to.title} は幹です。幹へ渡すなら thread.send を使ってください`);
      }
      // 差配の口は幹が持つ。枝から隣の枝へ渡せると、深さ1段（決定77）が横に破れる
      if (me && me.kind === "branch") {
        throw new Error(
          "枝から枝へは渡せません（深さは1段・決定77）。幹へ還してから幹に渡してもらってください"
        );
      }
      if (me && to.parentId !== me.id) {
        throw new Error(
          `${to.title} はこの幹の枝ではありません。他の幹の枝には渡せません` +
            "（用があるならその幹へ thread.send）"
        );
      }
      if (to.state === "closed") {
        throw new Error(
          `枝「${to.title}」は畳んであります（結論：${to.conclusion ?? "なし"}）。` +
            "続きが要るなら開き直してから渡してください"
        );
      }
      if (params.message.trim() === "") throw new Error("空の言伝は渡せません");
      // P4: 幹と枝でも往復は続く。親子は仕事そのものなので幹どうしより緩いが、止まらないのは困る
      if (!allowSend(options.threadId, to.id, Date.now(), SEND_WINDOW_MS, STEER_MAX_PER_WINDOW)) {
        throw new Error(
          `「${to.title}」への言伝が続きすぎています（10分で ${STEER_MAX_PER_WINDOW} 通）。` +
            "枝の中で決まらないなら、畳ませて幹で話してください"
        );
      }
      const from = senderLabel(options.threads, me);
      // **待たない**（handOff）。待つと、枝が読み終えるまでこの幹が固まる
      handOff(options.deliver, to.id, `${from}から途中の言伝です：\n\n${params.message}`, "枝への言伝");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `枝「${to.title}」へ渡しました。あちらの番頭が読んで続けます` +
              "（結論は畳まれたときに幹へ還ります）",
          },
        ],
        details: { threadId: to.id, title: to.title },
      };
    },
  });

  /**
   * **枝から幹へ、畳む前に相談する**（決定107・PO指示 2026-08-13）。
   *
   * 決定77 では幹へ還るのは結論1行だけだったので、枝は**畳むまで黙る**しかなかった。
   * 前提が崩れた・思っていたより大きい・どちらの筋で行くか——どれも畳む前に幹の判断が
   * 要る。黙って進めるか、結論を捏造して畳むかの二択を無くす。
   *
   * **札として幹に立つ**（知らせに混ぜない）ので、幹の帯を読み返せば残っている。
   */
  const consult = defineNamespacedTool({
    name: "thread.consult",
    label: "Thread: Consult",
    description:
      "**いまのこの枝**から親の幹へ、畳む前に問いか報告を還す。幹に札が1枚立ち、番頭が読む。\n" +
      '入: `{ kind: "question", message: "前提だった計測が無い。取り直すか、別筋にするか" }`' +
      " → 出: 「幹「…」へ還しました」。返事は言伝でこの枝へ返る。\n" +
      "枝はそのまま続けてよい。畳むのは thread.merge（結論が出たとき）。",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("question"), Type.Literal("report")], {
        description:
          "**返事が要るか**。question＝幹の判断を待つ（返事が来る）／report＝知らせるだけで進む",
      }),
      message: Type.String({
        description:
          "還す一言。幹はこの枝の中を見ていないので、**いまどこまで来ていて何が要るか**を書く" +
          "（question なら選べる筋を並べる）",
      }),
    }),
    async execute(params) {
      // I2: 配線されていないことを「還したつもり」にしない
      if (!options.nudge) {
        throw new Error("この構成では幹へ還せません（nudge が渡されていません）");
      }
      const me = options.threads.get(options.threadId);
      const trunkId = me?.parentId;
      // P4: 数えてから積む。断られた相談の札が幹に残ると、読み返したとき辻褄が合わない
      if (
        trunkId &&
        !allowSend(options.threadId, trunkId, Date.now(), SEND_WINDOW_MS, STEER_MAX_PER_WINDOW)
      ) {
        throw new Error(
          `幹への相談が続きすぎています（10分で ${STEER_MAX_PER_WINDOW} 通）。` +
            "往復で決着していないので、いったん「保留：…」で畳んで幹で話してください"
        );
      }
      const { trunk, entry } = options.threads.consult(options.threadId, {
        kind: params.kind,
        message: params.message,
      });
      const what = params.kind === "question" ? "問い" : "報告";
      // **待たない**（handOff）。待つと、幹が読んで喋り終えるまでこの枝が固まる
      handOff(
        options.nudge,
        trunk.id,
        `枝「${entry.title}」からの${what}です：\n\n${entry.text}\n\n` +
          `（この枝はまだ開いています。返すなら thread.steer({ threadId: "${entry.branchId}", message: … })）`,
        "枝からの相談"
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              `幹「${trunk.title}」へ${what}を還しました（札が立ちました）。` +
              (params.kind === "question"
                ? "返事は言伝でこの枝へ届きます。**待つ間に進められることは進めてよい**"
                : "返事は要りません。このまま続けてください"),
          },
        ],
        details: { trunkId: trunk.id, kind: params.kind, at: entry.at },
      };
    },
  });

  /**
   * 枝を畳んで幹へ還す（決定77）。
   *
   * **出口は「結論」であって「実装」ではない**——incident を起票し task を積んだ時点で
   * 畳む。実装の寿命まで開いておくと、結局 Slack になる。**保留も結論の一種**として
   * 「保留：理由」で畳み、開き直せるようにする。
   *
   * **詳細（何を調べ・何を決め・何が残ったか）も渡せる**（決定108）。**幹へは流さない**
   * ——幹に積むのは結論1行のままで、詳細は枝に残り `thread.read` で開いたときに読める。
   * 一覧が読めなくなる作りにはしない、が決定77 から引き継ぐ縛り。
   *
   * 宛先は**自分の枝に固定**する（決定35a と同じ理由）。
   */
  const merge = defineNamespacedTool({
    name: "thread.merge",
    label: "Thread: Merge",
    description:
      "**いまのこの枝**を畳んで幹へ還す（幹の末尾に結論が1行積まれる）。\n例: {conclusion: \"inc-0048 を起票し task-0091 を積んだ\", investigated: [\"10回走らせて3回落ちた\"], decided: [\"待ちを延ばさず機構を直す\"], remaining: [\"task-0092 を積んだ\"]} → 畳んだ旨\n**出口は結論であって実装ではない。** 幹は畳めない。決めきれないものは「保留：理由」で畳んでよい。\n調べた・決めた・残った（investigated / decided / remaining）は**幹へは流れず枝に残る**——`thread.read` で開いたときに読める。",
    parameters: Type.Object({
      conclusion: Type.String(),
      investigated: Type.Optional(Type.Array(Type.String())),
      decided: Type.Optional(Type.Array(Type.String())),
      remaining: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(params) {
      const detail = renderMergeDetail(params);
      const thread = options.threads.merge(options.threadId, params.conclusion, {
        ...(detail ? { detail } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `枝「${thread.title}」を畳んで幹へ還しました。結論：${thread.conclusion}` +
              (thread.conclusionDetail
                ? "。詳細はこの枝に残ります（幹からは thread.read で読めます）"
                : ""),
          },
        ],
        details: thread.view(),
      };
    },
  });

  /**
   * 会話に名前を付け直す口（PO要望 2026-08-05）。
   *
   * **判断はここに無い**（D5）。「いつ付け直すか」——話が変わったかどうか——は番頭が決め、
   * その促しはシステムプロンプトに置く。ここは名前を書き換えて知らせるだけ。
   *
   * 宛先は**自分の会話に固定**する。番頭に threadId を書かせると、隣の会話に別の話題の
   * 名前が付く（`thread.open` で開いた分身の id は返しているので、書けてしまう）。
   */
  const rename = defineNamespacedTool({
    name: "thread.rename",
    label: "Thread: Rename",
    description:
      "**いまのこの会話**に名前を付け直す。タブと履歴の表示がその場で変わり、次に開いたときも残る。" +
      "何の話か決まったとき、また**話が別のことへ移ったとき**に付け直すと、" +
      "POがタブを見ただけでどの会話か分かる。他の会話の名前は変えられない。",
    parameters: Type.Object({
      title: Type.String({
        description:
          "新しい名前。何の話かが一目で分かる短い語にする（15文字程度。長い分は切り詰められる）",
      }),
    }),
    async execute(params) {
      const thread = options.threads.rename(options.threadId, params.title);
      return {
        content: [{ type: "text" as const, text: `この会話の名前を「${thread.title}」にしました` }],
        details: thread.view(),
      };
    },
  });

  /**
   * 幹を終う（PO裁定 2026-08-09）。
   *
   * **枝を畳むのは「回収」、幹を終うのは「店じまい」。** 還す先が無いので結論は取らず、
   * 代わりに**持って出る記憶**を選ぶ。ここが番頭の判断——その幹でしか通じない事情は
   * 置いていき、他の仕事でも効く一般解だけを横断の層へ上げる。
   */
  const closeTrunk = defineNamespacedTool({
    name: "thread.close_trunk",
    label: "Thread: Close Trunk",
    description:
      "**幹を終う**（プロジェクトが終わったとき）。畳んだ幹は履歴に残り、開き直せる。" +
      "開いている枝が1本でもあると終えない——先に畳んで還すこと。\n" +
      "**持って出る記憶を選ぶのはあなた**（`carry`）。その幹でしか通じない事情は置いていき、" +
      "他の仕事でも効く一般解だけを横断の層へ上げる。選ばなかったものは幹と一緒に畳まれ、" +
      "会話としては残るが、以後の会話には注入されない。",
    parameters: Type.Object({
      threadId: Type.String({ description: "終う幹の threadId（thread.list で確認できる）" }),
      carry: Type.Array(Type.String(), {
        description:
          "**横断の層へ持って出る記憶**。1件1行で、その幹の外でも意味が通る形に書き直すこと" +
          "（「この幹では〜」ではなく「〜のときは〜する」）。持って出るものが無ければ空の配列",
      }),
    }),
    async execute(params) {
      // I2: 配線されていないことを「終えたつもり」にしない
      if (!options.carryOut) {
        throw new Error("この会話では幹を終えません（記憶の口が配線されていません）");
      }
      const carried = params.carry.map((t) => t.trim()).filter((t) => t !== "");
      const added = await options.carryOut(carried);
      // **記憶を先に上げてから終う。** 逆だと、終うのに失敗したとき記憶だけが残る
      const thread = options.threads.closeTrunk(params.threadId);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `幹「${thread.title}」を終いました。持って出た記憶 ${added} 件。` +
              (carried.length === 0 ? "（持って出るものはありませんでした）" : ""),
          },
        ],
        details: { thread: thread.view(), carried: added },
      };
    },
  });

  /**
   * 新しい幹を起こす（PO裁定 2026-08-10）。
   *
   * **幹＝プロジェクトの単位**なので、判定は「その記憶を、もう一方の会話に混ぜたいか」。
   * 混ぜたくないなら別の幹、混ぜたいなら既にある幹で話す。帳場（メインの幹）は
   * どの幹の話でもないものの受け皿で、**新しい幹はそこから生まれる**。
   */
  const openTrunk = defineNamespacedTool({
    name: "thread.open_trunk",
    label: "Thread: Open Trunk",
    description:
      "**新しい幹（プロジェクト）を起こす**。幹は記憶が分かれる単位なので、" +
      "判定は「その記憶を、いまの幹の会話に混ぜたいか」——混ぜたくないなら別の幹にする。\n" +
      "混ぜたいなら幹を増やさず、いまの幹で話すこと。往復が続くだけなら枝（thread.open）。" +
      "**理由を書けないなら起こさない**（幹が増えるほど記憶が細切れになる）。",
    parameters: Type.Object({
      title: Type.String({ description: "プロジェクトの名前。レールに頭文字が出る" }),
      reason: Type.String({
        description:
          "**なぜ既にある幹ではなく新しい幹なのか**を1行で（例：「loamium の事情を banto の" +
          "判断に混ぜたくない」）",
      }),
      message: Type.Optional(
        Type.String({ description: "新しい幹へ渡す最初の一言。省略すると開くだけ" })
      ),
    }),
    async execute(params) {
      const thread = await options.threads.open({ kind: "trunk", title: params.title });
      // 開いた理由は幹の1行目に残す（あとから「なぜ分けたか」を読めるように）
      thread.record({
        role: "notice",
        source: "thread",
        text: `この幹を起こしました。理由：${params.reason}`,
      });
      // 枝と同じく**待たない**——待つと、起こした側の会話が向こうのターンの間止まる
      if (params.message && options.seed) {
        handOff(options.seed, thread.id, params.message, "新しい幹への最初の一言");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `幹「${thread.title}」を起こしました (threadId: ${thread.id})`,
          },
        ],
        details: thread.view(),
      };
    },
  });

  const list = defineNamespacedTool({
    name: "thread.list",
    label: "Thread: List",
    description:
      "幹と、開いている枝の一覧（**還す条件**つき）。「＊」が**いまのこの会話**。\n例: {} → \"thread-7 道具定義の圧縮 — 還す条件: 前後の対比較が出たら ＊いまのこの会話\"\n`{includeClosed: true}` で畳んだ枝と幹も並ぶ（中身は thread.read で読める）。",
    parameters: Type.Object({
      includeClosed: Type.Optional(Type.Boolean()),
    }),
    async execute(params) {
      const threads = params.includeClosed
        ? options.threads.list()
        : options.threads.list({ state: "open" });
      const text =
        threads.length === 0
          ? "開いている会話はありません"
          : threads
              .map(
                (t) =>
                  `${t.isMain ? "帳場" : t.kind === "trunk" ? "幹" : "枝"} ${t.title} (threadId: ${t.id})` +
                  `${t.state === "closed" ? "［畳んである］" : ""}` +
                  `${t.returnCondition ? ` — 還す条件：${t.returnCondition}` : ""}` +
                  `${t.conclusion ? ` — 結論：${t.conclusion}` : ""}` +
                  `${t.id === options.threadId ? " ＊いまのこの会話" : ""}`
              )
              .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { threads: threads.map((t) => t.view()) },
      };
    },
  });

  /**
   * **別の幹へ言伝を渡す**（PO要望 2026-08-10）。
   *
   * 幹は記憶も文脈も分かれている（ADR-0003 追補）。分けたからこそ、**跨いで伝えたいこと**
   * が出てくる——「そちらで踏んだ不具合はこちらの原因だった」「この決定はそちらにも効く」。
   * それを PO が手で運ぶのは、番頭が居る意味を削ぐ。
   *
   * 届いた側は**知らせとして受け取り、ターンが回る**。番頭が読んで、要れば動く。
   * 相手の会話に割り込んで喋るのではなく、**渡すだけ**——何をするかは相手の番頭が決める。
   */
  const send = defineNamespacedTool({
    name: "thread.send",
    label: "Thread: Send",
    description:
      "**別の幹へ言伝を渡す**（幹は記憶も文脈も分かれている）。\n例: {threadId: \"thread-7\", message: \"env.verify の既定 timeout が変わりました\"} → 渡した旨\nthreadId は英語の識別子で埋める。**宛先は幹だけ**（枝には送れない）。",
    parameters: Type.Object({
      threadId: Type.String(),
      message: Type.String()
    }),
    async execute(params) {
      if (!options.deliver) {
        throw new Error("この構成では言伝を渡せません（deliver が渡されていません）");
      }
      const me = options.threads.get(options.threadId);
      const to = options.threads.get(params.threadId);
      // I2: 宛先の取り違えを黙って既定へ落とさない
      if (!to) throw new Error(`${params.threadId} という会話はありません（thread.list で確かめてください）`);
      if (to.id === options.threadId) {
        throw new Error("自分自身へは渡せません（いま話しているのがその会話です）");
      }
      if (to.kind === "branch") {
        throw new Error(
          `${to.title} は枝です。枝は1つの問いに閉じているので割り込ませません——` +
            `親の幹（${to.parentId ?? "?"}）へ渡してください`
        );
      }
      if (to.state === "closed") {
        throw new Error(`幹「${to.title}」は終えています。開き直さないと渡せません`);
      }
      if (params.message.trim() === "") throw new Error("空の言伝は渡せません");
      // P4: 往復し続けるのを機構で止める。頼むだけでは止まらない
      if (!allowSend(options.threadId, to.id, Date.now())) {
        throw new Error(
          `「${to.title}」への言伝が続きすぎています（10分で ${SEND_MAX_PER_WINDOW} 通）。` +
            "往復で決着していないので、PO に上げるか、その幹へ移って直接話してください"
        );
      }

      // I1: 出所を偽らない。**PO の発言に見えてはいけない**——受け手はどちらの幹の話かで
      //     判断が変わる。宛先の番頭が「誰が言ったか」を読めるように、出どころを添える
      const from = senderLabel(options.threads, me);
      // **待たない**（handOff）。待つと、相手の番頭が読み終えるまでこちらが固まる
      handOff(options.deliver, to.id, `${from}から言伝です：\n\n${params.message}`, "言伝");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `幹「${to.title}」へ渡しました。あちらの番頭が読みます` +
              "（返事が要るなら、あちらから言伝で返ってきます）",
          },
        ],
        details: { threadId: to.id, title: to.title },
      };
    },
  });

  return [
    open,
    openTrunk,
    merge,
    rename,
    list,
    // 幹と枝の対話（決定105〜107）。読む口は常に生える——配信を要らないので
    read,
    ...(options.deliver ? [send, steer] : []),
    ...(options.nudge ? [consult] : []),
    ...(options.carryOut ? [closeTrunk] : []),
  ];
}
