/**
 * `thread.*` Tool — 番頭が自分で分身する口（ADR-0010 決定2・task-0035）。
 *
 * **「いつ分身するか」の判断はここに無い**（epic-0006 のスコープ外）。機構だけ用意し、
 * プロンプトでも促さない——まず手動で複数スレッドを持てる状態を作り、自動化はその後。
 *
 * 番頭が分身できることが要件なのは、「番頭は分身する」（vision）の主語が番頭だから。
 * PO しか新しい会話を作れないなら、それは分身ではなく画面の操作でしかない。
 *
 * D5: 判断は無い。スレッドを起こして名前を返すだけ。
 */

import { Type } from "typebox";
import { defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { ThreadRegistry } from "./threads.js";

export interface ThreadToolsOptions {
  threads: ThreadRegistry;
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
      "新しい会話スレッド（分身）を開く。関心事が別なら会話を分けると、割り込みで元の話が" +
      "壊れない。**既に開いている会話とキャンバスには何も起きない**。" +
      "message を渡すと、その分身が最初の一言を受け取って動き出す。",
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({ description: "会話の名前。何の話かが一目で分かる短い語にする" })
      ),
      message: Type.Optional(
        Type.String({
          description:
            "新しい分身へ渡す最初の一言。分身は記憶を共有するが**この会話の文脈は持たない**ため、" +
            "何をしてほしいかを書き切ること",
        })
      ),
    }),
    async execute(params) {
      const thread = await options.threads.open(params.title);
      if (params.message && options.seed) {
        // 種を蒔くのは開いたあと。失敗しても開いたことは取り消さない
        // ——スレッドは既にあるので、握りつぶすと「開いたのに誰も知らない」になる（I2）
        await options.seed(thread.id, params.message);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `新しい会話を開きました: ${thread.title} (threadId: ${thread.id})`,
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
      "開いている会話（分身）の一覧を返す。いま何本の話が並行しているかを確かめたいときに使う。",
    parameters: Type.Object({}),
    async execute() {
      const threads = options.threads.list();
      const text =
        threads.length === 0
          ? "開いている会話はありません"
          : threads
              .map((t) => `${t.isDefault ? "◎" : "○"} ${t.title} (threadId: ${t.id})`)
              .join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { threads: threads.map((t) => t.view()) },
      };
    },
  });

  return [open, list];
}
