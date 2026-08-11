/**
 * **ターンには予算がある**（PO報告 2026-08-11・P4）。
 *
 * ## 何が起きたか（実機・thread-69「banto類似品の調査」）
 *
 * 番頭が職人に調査を任せたあと、完了を待つために道具を呼び続けて止まらなくなった。
 * 番頭自身の発話がその構造を書いている：
 *
 * > 職人は私に自動的に報告が届く仕組みなので、完了したら知らせが来ます。
 * > **少し待って、もう一度進捗を確認してみます。**
 *
 * 分かっているのに待てない。**エージェントのループに「待つ」という手が無い**からで、
 * 待つ唯一のやり方は「ターンを終える」こと——だがそれが正解だと誰も言っていない。
 * 結果、ターンの中で打てる唯一の手（道具をもう1回呼ぶ）を繰り返す。
 *
 * ## なぜ道具の名前を数えないか
 *
 * 最初は「様子を見る道具（`worker.attach` 等）を並べて、連続した同じ呼び出しを数える」
 * ものを書いた。**それでは実際の暴走は止まらなかった**——実機の並びはこうだった：
 *
 * ```
 * attach, attach, events, attach, attach, attach, attach, find, find,
 * attach, events, attach, find, find, attach, events, events, find, events, …
 * ```
 *
 * 道具が入れ替わるので「連続」では数えられず、`file.find` のように一覧に無い道具も
 * 混ざる。**症状（どの道具か）を数えていた**のが誤りで、暴走の本体は「1つのターンが
 * 終わらないこと」そのもの。だからここでは**道具を選ばず、ターンを測る**：
 *
 *   1. **同じ問いの繰り返し**（間に何を挟んでも数える）——待ちの代わりを早く止める
 *   2. **ターン全体の回数**——1 に当たらない形（毎回少しずつ違う）も必ず止まる
 *
 * どちらも道具の名前に依らないので、道具が増えても穴が開かない。
 *
 * ## 止め方
 *
 * **断る**（例外にする）。空の結果を返すと「何も無かった」と読まれ、もう一度確かめに
 * 来る——止めたい振る舞いをこちらが誘発する。断り文には**次に何をすべきか**まで書く
 * （D8）：止めるだけでは、番頭は別の道具で同じことを始める。
 *
 * D5: 判断は無い。数えて断るだけ。
 */

import type { NamespacedToolDefinition } from "./tool-registry.js";

/**
 * 同じ問いを何回まで許すか。
 *
 * 2回目までは正常（起こした直後に様子を見る、少し進んでから見る）。3回目からは
 * **待ちの代わりにしている**——実機では同じ `worker.attach` が8回呼ばれていた。
 */
export const DEFAULT_REPEAT_LIMIT = 3;

/**
 * 1つのターンで道具を何回まで呼べるか。
 *
 * **1 に当たらない暴走の受け皿**（毎回少しずつ違う問いを出し続ける形）。番頭は細かい
 * 仕事をしない（D10）ので、1つの入力に対して数十回も道具を呼ぶこと自体が既に異常。
 * 上限に当たったら、そのターンは終える——**続きは次のターンでできる**（失われない）。
 */
export const DEFAULT_CALL_LIMIT = 60;

/** ターン1つ分の予算。会話ごとに1つ持つ（隣の会話の数えと混ぜない）。 */
export interface TurnBudget {
  /** この呼び出しを数える。断るなら理由を返す。 */
  check(tool: string, args: unknown): string | undefined;
  /** 数え直す（新しい入力が来た＝次のターンが始まった）。 */
  reset(): void;
}

export interface TurnBudgetOptions {
  /** 同じ問いの上限（既定 `DEFAULT_REPEAT_LIMIT`）。 */
  repeatLimit?: number;
  /** ターン全体の上限（既定 `DEFAULT_CALL_LIMIT`）。 */
  callLimit?: number;
}

export function createTurnBudget(options: TurnBudgetOptions = {}): TurnBudget {
  const repeatLimit = options.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const callLimit = options.callLimit ?? DEFAULT_CALL_LIMIT;
  /** このターンで同じ問いを何回出したか。**間に何を挟んでも数える**。 */
  let asked = new Map<string, number>();
  let calls = 0;

  return {
    check(tool, args): string | undefined {
      calls += 1;
      if (calls > callLimit) {
        return (
          `**このターンで道具を ${calls - 1} 回呼びました（上限 ${callLimit}）。** ` +
          "1つの入力に対してこれだけ手を動かしているのは、たいてい終わり方を見失っています。\n\n" +
          "**いまやること：このターンを終えてください。** いま分かっていることを一言でまとめ、" +
          "次に何をするつもりかを書いて手を止めること。**続きは次のターンでできます**" +
          "——職人の知らせでも PO の言葉でも、あなたのターンはまた回ります。"
        );
      }

      const key = `${tool} ${stableKey(args)}`;
      const seen = (asked.get(key) ?? 0) + 1;
      asked.set(key, seen);
      if (seen <= repeatLimit) return undefined;
      return (
        `**このターンで同じ確認（${tool}）を ${seen} 回出しています。** ` +
        "これは待ちの代わりになりません——ターンの中で待つことはできないので、" +
        "繰り返すほど文脈と費用が減るだけです。\n\n" +
        "**いまやること：このターンを終えてください。** 職人が喋り終わったら、報告か" +
        "「手が空きました」の知らせが**自動で届き、そこであなたのターンが回ります**。" +
        "待っている間に進められることがあるならそれを進め、無いなら PO に一言残して" +
        "手を止めること。様子が知りたいだけなら、次に起きたときに1回確かめれば足ります。"
      );
    },
    reset(): void {
      asked = new Map();
      calls = 0;
    },
  };
}

/**
 * 引数を数えるための鍵。**キーの順で変わらない**ようにする——同じ問いを書き方だけ
 * 変えて続けられると数えが外れる。
 */
function stableKey(args: unknown): string {
  if (args === null || typeof args !== "object") return JSON.stringify(args) ?? "";
  const record = args as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]])
  );
}

/**
 * 道具に予算を掛ける。**選ばない**——番頭に渡す口は全部通す。
 *
 * 掛けるのは**番頭に渡す口だけ**。モジュールの HTTP 面（GUI が引く側）は素通しにする
 * ——画面の定期更新まで断ると、見ているものが止まる。
 */
export function guardTurn(
  tool: NamespacedToolDefinition,
  budget: TurnBudget
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args, ctx) {
      const refusal = budget.check(tool.name, args);
      if (refusal) throw new Error(refusal);
      return tool.execute(args, ctx);
    },
  };
}
