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
import type { ThreadRegistry } from "./threads.js";

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
   */
  seed?: (threadId: string, message: string) => Promise<void>;
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
      "**枝**を開く（ADR-0017 決定77）。継続的な議論・調査になると見たときに自分で開いてよく、" +
      "POが明示したときも開く。開いた瞬間に**幹へ札が1行**立つので、埋没しない。" +
      "**既に開いている幹・枝とそのキャンバスには何も起きない**。" +
      "message を渡すと、その枝が最初の一言を受け取って動き出す。\n" +
      "**還す条件を書けないものは枝にしない**（幹で話す）。枝の中に枝は開けない" +
      "——枝が別の枝を要するなら、いまの枝を畳んで幹へ還してから開き直す。",
    parameters: Type.Object({
      title: Type.String({
        description: "枝の名前。何の話かが一目で分かる短い語にする",
      }),
      returnCondition: Type.String({
        description:
          "**還す条件**。何が決まれば幹に還るかを1行で書く（例：「再現条件が特定できたら」）。" +
          "書けないなら枝にせず、幹で話すこと",
      }),
      reason: Type.String({
        description:
          "**開いた理由**。なぜ幹ではなくここで話すのかを1行で。札に出るのでPOが読む",
      }),
      message: Type.Optional(
        Type.String({
          description:
            "新しい枝へ渡す最初の一言。枝は記憶を共有するが**この会話の文脈は持たない**ため、" +
            "何をしてほしいかを書き切ること",
        })
      ),
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
        // 種を蒔くのは開いたあと。失敗しても開いたことは取り消さない
        // ——スレッドは既にあるので、握りつぶすと「開いたのに誰も知らない」になる（I2）
        await options.seed(thread.id, params.message);
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `枝「${thread.title}」を開きました (threadId: ${thread.id})。` +
              `還す条件：${params.returnCondition}。幹に札を立てました`,
          },
        ],
        details: thread.view(),
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
   * 宛先は**自分の枝に固定**する（決定35a と同じ理由）。
   */
  const merge = defineNamespacedTool({
    name: "thread.merge",
    label: "Thread: Merge",
    description:
      "**いまのこの枝**を畳んで幹へ還す。幹の末尾に結論が1行積まれ、この枝は履歴へ移る" +
      "（中身は消えず、開き直せる）。還す条件を満たしたら畳むこと。" +
      "**出口は結論であって実装ではない**——incident を起票し task を積んだ時点で畳む。" +
      "決めきれないものは「保留：理由」で畳んでよい。幹は畳めない。",
    parameters: Type.Object({
      conclusion: Type.String({
        description:
          "**結論の1行**。幹に残るのはこれだけなので、何が決まったかを言い切る" +
          "（例：「inc-0048 を起票し task-0091 を積んだ」「保留：計測が足りない」）",
      }),
    }),
    async execute(params) {
      const thread = options.threads.merge(options.threadId, params.conclusion);
      return {
        content: [
          {
            type: "text" as const,
            text: `枝「${thread.title}」を畳んで幹へ還しました。結論：${thread.conclusion}`,
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

  const list = defineNamespacedTool({
    name: "thread.list",
    label: "Thread: List",
    description:
      "幹と、開いている枝の一覧を返す。いま何本の話が並行しているかと、それぞれの" +
      "**還す条件**を確かめたいときに使う。「＊」が付いているのが**いまのこの会話**。",
    parameters: Type.Object({}),
    async execute() {
      const threads = options.threads.list({ state: "open" });
      const text =
        threads.length === 0
          ? "開いている会話はありません"
          : threads
              .map(
                (t) =>
                  `${t.kind === "trunk" ? "幹" : "枝"} ${t.title} (threadId: ${t.id})` +
                  `${t.returnCondition ? ` — 還す条件：${t.returnCondition}` : ""}` +
                  `${t.id === options.threadId ? " ＊いまのこの会話" : ""}`
              )
              .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { threads: threads.map((t) => t.view()) },
      };
    },
  });

  return [open, merge, rename, list];
}
