/**
 * T4: **幹で手を動かしたら枝へ促す**（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * ## なぜ機構が要るのか
 *
 * PO の恒久方針は「幹（trunk）は常に PO の入力を受けられる待ち状態でいてほしい」。
 * 知らせへの対応も、調査・検討・委譲も枝でやり、幹には結論が1行返るだけにする。
 *
 * ところが**これを促す仕掛けが1つも無かった**。幹か枝かは
 * システムプロンプトの文言（`describeThread`）を変えるのに使われるだけで、幹で調査を
 * 始めても委譲を始めても機構は何も言わない。結果、「幹で作業しない」が番頭の心がけ
 * 次第になり、守られてこなかった。**心がけを機構にするのがここ。**
 *
 * ## 断らない。促すだけ
 *
 * 一発で終わる小さな確認まで枝に追い出すと往復が増える（枝を開く・還す・読む）。
 * だから第一便は**警告から入る**——`withTierUnassignedNotice` と同じ側で、道具の結果は
 * そのまま返し、後ろに一言足すだけ。効き目が足りなければ後で断る側へ寄せる。その判断は
 * **計測が出てから**なので、この便では台帳（`TurnLogEntry.toolCalls` / `browseCalls`）に
 * 材料を残すところまでをやる。
 *
 * ## 促し文には直し方を書く（D8）
 *
 * 「幹でやるな」だけでは、番頭は同じことを別の道具で始める。`thread.open` の
 * `returnCondition` まで書いて、次の一手をそのまま打てるようにする。
 *
 * ## 同じターンで何度も促さない
 *
 * 2種それぞれ**1ターンに1回だけ**。毎回付けると雑音になって読まれなくなる
 * （ターン予算の警告が 60/100 の一点だけで出すのと同じ理由）。数え直しの切れ目は
 * ターン予算と同じ——`TurnBudget.reset()` に相乗りする（`createTurnBudget({ onReset })`）。
 * 切れ目を自前で持つと、バックエンドを増やしたときに片方だけ数え直されない
 * （それが 2026-08-13 の不具合の形だった）。
 *
 * D5: 判断は無い。数えて、添えるかどうかだけ。
 */

import type { BantoHarness, HarnessPromptOptions } from "@banto/core";

import type { NamespacedToolDefinition } from "./tool-registry.js";
import type { TurnNudgeKind, TurnToolCounts } from "./turn-log.js";

/**
 * 幹で「自分の手で調べ物・手仕事をした」と数える道具。
 *
 * `file.*` / `git.*` の2ドメイン。書き込み（`file.write`）も数える——幹で直に書くのは
 * 閲覧よりさらに「枝でやるべきこと」である。
 */
export function isBrowseTool(tool: string): boolean {
  return tool.startsWith("file.") || tool.startsWith("git.");
}

/** 幹から直に仕事を出す道具。ここを呼んだら、その面倒は枝で見るべきである。 */
export function isDelegateTool(tool: string): boolean {
  return tool === "worker.delegate" || tool === "kobo.enqueue";
}

/**
 * 幹の1ターンで `file.*` / `git.*` を何回呼んだら促すか（暫定の既定）。
 *
 * **根拠**（当てずっぽうを置かないための筋道）:
 *
 *   - ターン予算の 60/100/120 は「1つの入力に対してこれだけ手を動かしているのは、
 *     たいてい終わり方を見失っている」という**暴走の線**。幹が塞がる線はその遥か手前で、
 *     同じ数字を使う意味は無い。
 *   - 幹の1ターンの正しい形は「PO の言葉を受ける → 枝を開く／委譲する → 1行返す」で、
 *     `thread.*` / `worker.*` 中心の数回で終わる。**閲覧系は 0 回が既定**である。
 *   - とはいえ「いま何のブランチにいるか」「その1ファイルを見る」程度の確認まで枝に
 *     追い出すと往復のほうが高くつく。`git.status` → `file.read` → もう1つ確かめる、で 3 回。
 *   - **4 回目からは調査が始まっている**（1つ見て終わりではなく、次を探しに行っている）。
 *
 * よって暫定 4。T1 の台帳に幹のターンの実測（`browseCalls` の分布）が溜まったら、
 * PO の裁定でここを動かす。それまでは環境変数で動かせる。
 */
export const DEFAULT_TRUNK_BROWSE_NUDGE_LIMIT = 4;

/** 閾値の上書き。`0` 以下にすると閲覧の促しを止める（off スイッチ）。 */
export const TRUNK_BROWSE_NUDGE_LIMIT_ENV = "BANTO_TRUNK_BROWSE_NUDGE_LIMIT";

/**
 * 環境変数から閾値を読む。読めない値は既定に戻す——**黙って 0（＝無効）にしない**
 * （I2: 書き間違いで安全装置が消えるのが一番まずい）。
 */
export function browseNudgeLimitFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[TRUNK_BROWSE_NUDGE_LIMIT_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_TRUNK_BROWSE_NUDGE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `[banto] ${TRUNK_BROWSE_NUDGE_LIMIT_ENV}="${raw}" は 0 以上の整数ではないため、` +
        `既定の ${DEFAULT_TRUNK_BROWSE_NUDGE_LIMIT} を使います`
    );
    return DEFAULT_TRUNK_BROWSE_NUDGE_LIMIT;
  }
  return parsed;
}

/**
 * 幹で手を動かしたことを数え、必要なら促す器。**会話ごとに1つ**。
 *
 * 枝でも**数えはする**（台帳の材料は幹・枝の両方で要る。比べられないと「幹が重い」を
 * 示せない）が、**促しは幹でだけ**出る。
 */
export interface TrunkWorkNudge {
  /** この呼び出しを数えて、促し文（1ターンに1回だけ）か undefined を返す。 */
  check(tool: string): string | undefined;
  /** このターンの道具呼び出し回数（台帳 T1 へ残す材料）。 */
  counts(): TurnToolCounts;
  /** 数え直す（新しい入力が来た＝次のターンが始まった）。 */
  reset(): void;
}

export interface TrunkWorkNudgeOptions {
  /** その会話が幹か枝か。**`"trunk"` 以外では促さない**（分からないときも促さない）。 */
  kind?: "trunk" | "branch" | undefined;
  /** 閲覧の促しを出す回数（既定 `browseNudgeLimitFromEnv()`）。0 以下で無効。 */
  browseLimit?: number;
}

export function createTrunkWorkNudge(options: TrunkWorkNudgeOptions = {}): TrunkWorkNudge {
  const isTrunk = options.kind === "trunk";
  const browseLimit = options.browseLimit ?? browseNudgeLimitFromEnv();
  let total = 0;
  let browse = 0;
  let delegateNudged = false;
  /** 閲覧の促しを出した**時点**の回数。出していなければ undefined（0 と混ぜない・I1）。 */
  let browseNudgeAt: number | undefined;

  return {
    check(tool): string | undefined {
      total += 1;
      const browsing = isBrowseTool(tool);
      if (browsing) browse += 1;
      // 枝は何も変わらない（数えるだけ）。幹だけが促される
      if (!isTrunk) return undefined;
      if (isDelegateTool(tool)) {
        if (delegateNudged) return undefined;
        delegateNudged = true;
        return delegateNudgeMessage(tool);
      }
      if (browsing && browseLimit > 0 && browse >= browseLimit && browseNudgeAt === undefined) {
        browseNudgeAt = browse;
        return browseNudgeMessage(browse);
      }
      return undefined;
    },
    counts(): TurnToolCounts {
      const nudges: TurnNudgeKind[] = [];
      if (delegateNudged) nudges.push("delegate");
      if (browseNudgeAt !== undefined) nudges.push("browse");
      return {
        total,
        browse,
        ...(nudges.length > 0 ? { nudges } : {}),
        ...(browseNudgeAt !== undefined ? { browseNudgeAt } : {}),
      };
    },
    reset(): void {
      total = 0;
      browse = 0;
      delegateNudged = false;
      browseNudgeAt = undefined;
    },
  };
}

/** 幹で委譲したときの促し。**断らない**——委譲そのものは通っている。 */
export function delegateNudgeMessage(tool: string): string {
  return (
    `［幹は待ち状態に保つ］**幹から直に \`${tool}\` を呼びました。** ` +
    "起こした仕事の面倒（進捗の確認・報告の読み込み・手戻りの指示）は、これから何ターンも" +
    "この会話へ返ってきます。**それを幹で受けると、幹は塞がって PO の次の用件を受けられません。**\n\n" +
    "**いまやること：`thread.open` で枝を開き、この仕事の続きはそこで進めてください。** " +
    "`returnCondition` は「この委譲の結果が出て、結論を1行で言えるまで」のように、" +
    "**何が起きたら幹へ戻るか**が読める形で書くこと。幹へは結論だけ1行返してください。\n\n" +
    "（この呼び出しは通っています。結果は上のとおりです。）"
  );
}

/** 幹で調べ物が続いたときの促し。**断らない**——その呼び出しは通っている。 */
export function browseNudgeMessage(calls: number): string {
  return (
    `［幹は待ち状態に保つ］**このターンの幹で、ファイル・git を ${calls} 回触りました。** ` +
    "調べ物が幹で始まっています。**幹が調査で塞がると、PO は次の用件を出せません**" +
    "——幹は常に入力を受けられる待ち状態でいてほしい場所です。\n\n" +
    "**いまやること：`thread.open` で枝を開き、調べ物はその枝で続けてください。** " +
    "`returnCondition` は「原因が特定できて、直し方を1行で言えるまで」のように、" +
    "**何が分かったら幹へ戻るか**が読める形で書くこと。自分で読み続けずに済むなら " +
    "`worker.delegate` で職人へ渡すほうが速い（D10：番頭は細かい仕事をしない）。" +
    "幹へは分かったことを1行返してください。\n\n" +
    "（この呼び出しは通っています。結果は上のとおりです。）"
  );
}

/**
 * 道具に促しを掛ける。**選ばない**——番頭に渡す口は全部通す。
 *
 * 掛ける場所はターン予算と同じ（`assembleStewardContext`）。呼び出し側で選んで掛けると
 * **足し忘れた道具が抜け道になる**（ターン予算がその失敗を一度している）。
 *
 * 添え方は `guardTurn` に倣う——`content` に1行足すだけで、`details`（GUI 向け）には
 * 触らない。番頭には届き、画面は今までどおり。**促しは結果の後ろに置く**：先に置くと
 * 番頭が本文より先に読んで「この道具は失敗した」と受け取る。
 */
export function nudgeTrunkWork(
  tool: NamespacedToolDefinition,
  nudge: TrunkWorkNudge
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args, ctx) {
      const message = nudge.check(tool.name);
      const result = await tool.execute(args, ctx);
      if (message === undefined) return result;
      return {
        ...result,
        content: [...result.content, { type: "text" as const, text: message }],
      };
    },
  };
}

/**
 * imp-0036(c): **未処理を抱えた枝の件数を、幹の文脈に1行**（番頭裁定 2026-08-15）。
 *
 * ## 保険であって、知らせではない
 *
 * 本筋は (d)（所在の無い残作業では畳ませない）。それでも所在が「幹で委譲予定」のまま
 * 誰も動かないことは起こるので、**幹が既に起こしたターンの文脈に1行だけ足す**。
 *
 * **ターンは起こさない。** 札も立てず、取次にも積まず、`prompt` も呼ばない
 * ——ADR-0025 決定120「知らせは幹のターンを起こさない」。ここがやるのは、
 * **もう始まっているターンの入力に文字を足すこと**だけである。
 *
 * ## 出さない場合を先に決める
 *
 * - **0件では出さない。** 毎ターン「0件」と出る行は読み飛ばされ、非0のときも読まれなくなる
 * - **枝には出さない。** 未処理を降ろせるのはその枝を持つ幹の番頭だけ（`settle` と同じ線）
 *
 * ## 画面の記録は汚さない
 *
 * PO の発話は `thread.record({role:"po"})` で**別に**残っている。ここで足すのは
 * ハーネスへ渡す本文だけなので、会話の帯には出ない（＝読み返したとき、言っていない
 * ことを PO が言ったように見えない）。
 */
export interface UnsettledBranchSummary {
  id: string;
  title: string;
  remainingCount: number;
}

/** 1行に名前を挙げる枝の数。多いときは先頭これだけ＋残り件数にする。 */
export const UNSETTLED_BRANCHES_NAMED = 3;

/**
 * 幹の文脈へ足す1行。0件なら `undefined`（＝何も足さない）。
 *
 * 件数と枝の id まで出す——読んだ番頭が `thread.read` / `thread.settle` を
 * そのまま引ける形にする（D8: 気づかせるだけでなく、次の一手を打てるようにする）。
 */
export function unsettledRemainingLine(
  branches: readonly UnsettledBranchSummary[]
): string | undefined {
  if (branches.length === 0) return undefined;
  const named = branches
    .slice(0, UNSETTLED_BRANCHES_NAMED)
    .map((b) => `${b.id}「${b.title}」（未処理${b.remainingCount}件）`)
    .join("・");
  const rest = branches.length - Math.min(branches.length, UNSETTLED_BRANCHES_NAMED);
  return (
    `［覚え書き・この件で返事は要りません］**未処理を抱えたまま畳んだ枝が ${branches.length}件** あります：` +
    `${named}${rest > 0 ? `・ほか${rest}件` : ""}。` +
    "中身は `thread.read`、全部の一覧は `thread.list`。行き先が決まったものから " +
    '`thread.settle({threadId: "…", where: "…"})` で降ろしてください（`where` は所在＝どこへ行ったか）。'
  );
}

export interface UnsettledRemainingNoticeOptions {
  /** その会話が幹か枝か。**`"trunk"` 以外では出さない**（分からないときも出さない）。 */
  kind?: "trunk" | "branch" | undefined;
  /** いま未処理を抱えている枝。**呼ぶたびに数え直す**（降ろした直後から消える）。 */
  branches: () => readonly UnsettledBranchSummary[];
}

/**
 * ハーネスの `prompt` に、上の1行を**後ろから**足す皮。
 *
 * **足す場所はハーネスの継ぎ目**（`withTurnBudgetReset` と同じ）——番頭のターンを回す
 * 入力は出所（PO の発話・知らせ・言伝）に依らず全部ここを通るので、バックエンドを
 * 増やしても片方だけ抜けることがない。
 *
 * **後ろに置く**のは、先頭に置くと PO の言葉より先に読まれ、用件そのものが機構の
 * 覚え書きに見えるため（道具の促しを結果の後ろに置くのと同じ理由）。
 */
export function withUnsettledRemainingNotice(
  harness: BantoHarness,
  options: UnsettledRemainingNoticeOptions
): BantoHarness {
  const isTrunk = options.kind === "trunk";
  return new Proxy(harness, {
    get(target, prop) {
      if (prop === "prompt") {
        return (text: string, promptOptions?: HarnessPromptOptions): Promise<void> => {
          const line = isTrunk ? unsettledRemainingLine(options.branches()) : undefined;
          return target.prompt(line ? `${text}\n\n${line}` : text, promptOptions);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      // getter（`isStreaming` 等）は Reflect.get が解決済み。関数だけ this を束ね直す
      return typeof value === "function"
        ? (value as (...args: never[]) => unknown).bind(target)
        : value;
    },
  });
}
