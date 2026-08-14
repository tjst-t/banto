/**
 * **ターンには予算がある**（PO報告 2026-08-11・P4／PO裁定 2026-08-13）。
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
 * ## 止め方が人の介入を殺した（PO報告 2026-08-13・修正の理由）
 *
 * 最初の実装は、ターン全体の回数が 60 に届いた瞬間から**全部の道具を例外で断って**いた。
 * 実機ではこれが二重に裏目に出た：
 *
 * 1. **数えが数え直されていなかった。** `reset()` を呼んでいたのは pi バックエンドに
 *    しか渡らない皮（`countingSession`）だけで、Agent SDK バックエンド——**本番の既定**
 *    ——はその皮を通らない。予算が実体としてセッション累積になり、PO が2回話しかけると
 *    数えは 61 → 62 と積み上がった。**新しい指示を出すほど断られる**、つまり
 *    安全装置が人の介入を殺す形（制御の反転）で、復旧は PO の手動 `kill -9` しか
 *    残らなかった。だから `reset()` は**バックエンドの継ぎ目**（`withTurnBudgetReset`）
 *    で掛ける——片方のバックエンドにだけ掛かる形は、それ自体が今回の不具合の形である。
 * 2. **60 は正当な長い仕事にも当たる。** 番頭は細かい仕事をしない（D10）が、
 *    幹と枝を渡り歩きながら段取りする回では 60 を素直に超える。そこで全部を断ると、
 *    暴走ではない仕事まで途中で殺す。
 *
 * ## だから三段にする（PO裁定 2026-08-13）
 *
 *   - **60 回（第一警告）**：結果は**そのまま返す**。返り値に「終わり方を見失っていないか」
 *     と添えるだけ。番頭は自分で終われる——止めるより気づかせるほうが安い。
 *   - **100 回（第二警告）**：まだ続いている。**次は断る**ことを明示して、もう一段強く言う。
 *   - **120 回（打ち切り）**：ここで初めて**例外で断る**。
 *
 * 回数の側を緩められるのは、**本物の暴走はほぼ「同じ問いの繰り返し」が捕まえる**から
 * （実機の検体もそうだった）。そちらは今まで通り 3 回で即座に断る。
 *
 * ## 断るときの作法
 *
 * **断る**（例外にする）。空の結果を返すと「何も無かった」と読まれ、もう一度確かめに
 * 来る——止めたい振る舞いをこちらが誘発する。断り文には**次に何をすべきか**まで書く
 * （D8）：止めるだけでは、番頭は別の道具で同じことを始める。
 *
 * D5: 判断は無い。数えて、添えるか断るかだけ。
 */

import type { BantoHarness, HarnessPromptOptions } from "@banto/core";

import type { NamespacedToolDefinition } from "./tool-registry.js";

/**
 * 同じ問いを何回まで許すか。
 *
 * 2回目までは正常（起こした直後に様子を見る、少し進んでから見る）。3回目からは
 * **待ちの代わりにしている**——実機では同じ `worker.attach` が8回呼ばれていた。
 *
 * **ここは緩めない**（PO裁定 2026-08-13）。回数の側（下の三段）を緩められるのは、
 * 本物の暴走をこちらがほぼ捕まえるという前提があるから。
 */
export const DEFAULT_REPEAT_LIMIT = 3;

/**
 * 第一警告。ここまで来たら**結果は返すが、一言添える**。
 *
 * 1つの入力に対して 60 回も手を動かしているのは、たいてい終わり方を見失っている。
 * ただし**断らない**——正当な長い段取りもこの辺りに届くので、止めると仕事を殺す。
 */
export const DEFAULT_CALL_WARN_LIMIT = 60;

/** 第二警告。まだ続いている。**次に断る回数を明示して**もう一段強く言う。 */
export const DEFAULT_CALL_WARN_AGAIN_LIMIT = 100;

/**
 * 打ち切り。**ここで初めて例外にする**。
 *
 * **1 に当たらない暴走の受け皿**（毎回少しずつ違う問いを出し続ける形）。
 * 上限に当たったら、そのターンは終える——**続きは次のターンでできる**（失われない）。
 */
export const DEFAULT_CALL_LIMIT = 120;

/**
 * 1回の呼び出しに対する判定。
 *
 * **「断る理由 or undefined」では三段を表せない**（PO裁定 2026-08-13）。警告は
 * 「結果を返しつつ言葉を添える」ので、断りとは別の語彙が要る。
 */
export type TurnBudgetVerdict =
  /** そのまま通す。 */
  | { kind: "ok" }
  /** 通すが、結果に警告を添える。 */
  | { kind: "warn"; message: string }
  /** 断る（例外にする）。 */
  | { kind: "refuse"; message: string };

/** ターン1つ分の予算。会話ごとに1つ持つ（隣の会話の数えと混ぜない）。 */
export interface TurnBudget {
  /** この呼び出しを数えて、通す・添える・断るを決める。 */
  check(tool: string, args: unknown): TurnBudgetVerdict;
  /** 数え直す（新しい入力が来た＝次のターンが始まった）。 */
  reset(): void;
}

export interface TurnBudgetOptions {
  /** 同じ問いの上限（既定 `DEFAULT_REPEAT_LIMIT`）。 */
  repeatLimit?: number;
  /** 第一警告を出す回数（既定 `DEFAULT_CALL_WARN_LIMIT`）。 */
  callWarnLimit?: number;
  /** 第二警告を出す回数（既定 `DEFAULT_CALL_WARN_AGAIN_LIMIT`）。 */
  callWarnAgainLimit?: number;
  /** ターン全体の上限＝**断る回数**（既定 `DEFAULT_CALL_LIMIT`）。 */
  callLimit?: number;
}

export function createTurnBudget(options: TurnBudgetOptions = {}): TurnBudget {
  const repeatLimit = options.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const warnLimit = options.callWarnLimit ?? DEFAULT_CALL_WARN_LIMIT;
  const warnAgainLimit = options.callWarnAgainLimit ?? DEFAULT_CALL_WARN_AGAIN_LIMIT;
  const callLimit = options.callLimit ?? DEFAULT_CALL_LIMIT;
  /** このターンで同じ問いを何回出したか。**間に何を挟んでも数える**。 */
  let asked = new Map<string, number>();
  let calls = 0;

  return {
    check(tool, args): TurnBudgetVerdict {
      calls += 1;
      if (calls > callLimit) {
        return {
          kind: "refuse",
          message:
            `**このターンで道具を ${calls - 1} 回呼びました（上限 ${callLimit}）。** ` +
            "1つの入力に対してこれだけ手を動かしているのは、たいてい終わり方を見失っています。\n\n" +
            "**いまやること：このターンを終えてください。** いま分かっていることを一言でまとめ、" +
            "次に何をするつもりかを書いて手を止めること。**続きは次のターンでできます**" +
            "——職人の知らせでも PO の言葉でも、あなたのターンはまた回ります。",
        };
      }

      const key = `${tool} ${stableKey(args)}`;
      const seen = (asked.get(key) ?? 0) + 1;
      asked.set(key, seen);
      if (seen > repeatLimit) {
        return {
          kind: "refuse",
          message:
            `**このターンで同じ確認（${tool}）を ${seen} 回出しています。** ` +
            "これは待ちの代わりになりません——ターンの中で待つことはできないので、" +
            "繰り返すほど文脈と費用が減るだけです。\n\n" +
            "**いまやること：このターンを終えてください。** 職人が喋り終わったら、報告か" +
            "「手が空きました」の知らせが**自動で届き、そこであなたのターンが回ります**。" +
            "待っている間に進められることがあるならそれを進め、無いなら PO に一言残して" +
            "手を止めること。様子が知りたいだけなら、次に起きたときに1回確かめれば足ります。",
        };
      }

      /**
       * 警告は**その回数ちょうどで1回だけ**出す。
       *
       * 60 を超えた全部の呼び出しに添えると、120 まで 60 回同じ文章が文脈に積まれる
       * ——警告そのものが文脈を食い、しかも読み流される。言うべきは「境目を越えた」
       * 一点だけで、次の一言は 100 回目まで取っておく。
       */
      if (calls === warnLimit) {
        return {
          kind: "warn",
          message:
            `［ターン予算 ${calls}/${callLimit}］**このターンで道具を ${calls} 回呼びました。** ` +
            "終わり方を見失っていませんか。**いま分かっていることをまとめて、このターンを" +
            "終えてください。続きは次のターンでできます**——職人の知らせでも PO の言葉でも、" +
            "あなたのターンはまた回ります。結果はこの上のとおりです（この呼び出しは通っています）。",
        };
      }
      if (calls === warnAgainLimit) {
        return {
          kind: "warn",
          message:
            `［ターン予算 ${calls}/${callLimit}］**まだ続いています（${calls} 回目）。** ` +
            `**${callLimit} 回で断ります**——そこまで行くと、いま手元にあるものを残す機会も` +
            "無くなります。\n\n**いまやること：新しい調べ物を始めないこと。** 分かったことと" +
            "次にやることを書いて、このターンを終えてください。**続きは次のターンでできます。**",
        };
      }
      return { kind: "ok" };
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
 *
 * 警告の添え方は退避（`withArtifactOffload`）に倣う——Tool の結果の `content` に1行
 * 足すだけで、`details`（GUI 向け）には触らない。番頭には届き、画面は今までどおり。
 */
export function guardTurn(
  tool: NamespacedToolDefinition,
  budget: TurnBudget
): NamespacedToolDefinition {
  return {
    ...tool,
    async execute(args, ctx) {
      const verdict = budget.check(tool.name, args);
      if (verdict.kind === "refuse") throw new Error(verdict.message);
      const result = await tool.execute(args, ctx);
      if (verdict.kind === "ok") return result;
      // 警告は**結果のあとに**足す。先に置くと、番頭が本文より先に警告を読んで
      // 「この道具は失敗した」と受け取る（実際には通っている）
      return {
        ...result,
        content: [...result.content, { type: "text" as const, text: verdict.message }],
      };
    },
  };
}

/**
 * **新しい入力が来たら数え直す**（PO報告 2026-08-13）。
 *
 * ## なぜハーネスに掛けるのか
 *
 * 数えは「1つのターンの中で同じことを繰り返していないか」を見るもの。PO の言葉や
 * 職人の知らせが来たなら状況は変わっているので、そこから数え直す。
 *
 * 以前これを `HostSession` の皮（`countingSession`）でやっていたが、その皮は
 * **pi バックエンドにしか渡らなかった**。Agent SDK バックエンドでは `reset()` が
 * 一度も呼ばれず、ターン予算が実体としてセッション累積になり、PO が話しかけるほど
 * 数えが積み上がって**新しい指示が断られた**（上のヘッダ参照）。
 *
 * だから掛けるのは**バックエンドの継ぎ目**（`BantoHarness`）——番頭のターンを回す
 * 入力は、出所（PO の発話・職人の知らせ・工場の知らせ・言伝・枝への steer）に依らず
 * 全部 `harness.prompt()` を通る。ここに掛けておけば、バックエンドを増やしても
 * 掛け忘れは「ハーネスを包み忘れる」という**見える形**でしか起きない。
 *
 * ## なぜ Proxy か
 *
 * `BantoHarness` には省略可能な口（`setModel` / `resumeToken` / `contextWindow` /
 * `dispose`）がある。手で組み直した object で包むと、書き写し忘れた口が**包んだ瞬間に
 * 「対応していない」ことになる**（`withEmptyResponseGuard` が同じ罠を踏んでいる）。
 * Proxy なら `prompt` 以外は素通しで、口の有無も `instanceof` も元のまま残る。
 */
export function withTurnBudgetReset(harness: BantoHarness, budget: TurnBudget): BantoHarness {
  return new Proxy(harness, {
    get(target, prop) {
      if (prop === "prompt") {
        return (text: string, options?: HarnessPromptOptions): Promise<void> => {
          budget.reset();
          return target.prompt(text, options);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      // getter（`isStreaming` 等）は Reflect.get が解決済み。関数だけ this を束ね直す
      // ——素の参照を返すと、呼び出し側で this が Proxy になり private 参照が壊れる
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  });
}
