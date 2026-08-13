/**
 * 取次の Tool（`inbox.*`）。
 *
 * **積むのは誰でもよい**——番頭自身も、モジュールも、職人の代理として番頭も。
 * だから公開する契約は「積む・見る・答える」の3つだけで、誰が積んだかは `source` が持つ。
 *
 * D5: 判断は無い。番頭が「これは自分では決められない」と判断した結果をここへ置くだけ。
 * D9: 何を積むかの選別は番頭の側の仕事。ここは受けた通りに積む。
 */

import { Type } from "typebox";
import { OpenObject, StringEnum } from "@banto/core";
import type { Inbox } from "./inbox.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

const Action = Type.Object({
  id: Type.String(),
  label: Type.String(),
  tone: Type.Optional(
    StringEnum(["call", "plain", "quiet"] as const, { description: "推し（call）は1つまで" })
  ),
});

export interface InboxToolOptions {
  /**
   * この Tool を渡す会話（決定73）。積まれた一通の既定の宛先になる。
   *
   * **番頭に書かせない**——自分の threadId を知らないし、書かせれば別の会話へ飛ぶ札が
   * できる（決定35a・`worker.delegate` の `origin` と同じ理由）。これがあることで、
   * 取次の札から**その話をしていた会話へ戻れる**（PO要望 2026-08-09）。
   */
  threadId?: string;
}

export function createInboxTools(
  inbox: Inbox,
  options: InboxToolOptions = {}
): NamespacedToolDefinition[] {
  const post = defineNamespacedTool({
    name: "inbox.post",
    label: "Inbox: Post",
    description:
      "POの判断を取次へ積む。**自分では決められないものだけ**（D1・D9・P3）。\n例: {sourceId: \"banto\", sourceLabel: \"番頭\", kind: \"後戻りできない\", rule: \"D1\", title: \"ログ形式を変えるか\", what: \"既存ログが読めなくなる\", ask: \"変えてよいか\", actions: [{id: \"go\", label: \"変える\", tone: \"call\"}, {id: \"stay\", label: \"いまのまま\"}]} → 積んだ旨\nsourceId と actions[].id は英語の識別子で埋める。",
    parameters: Type.Object({
      sourceId: Type.String(),
      sourceLabel: Type.String(),
      kind: Type.String(),
      rule: Type.Optional(Type.String()),
      title: Type.String(),
      why: Type.Optional(Type.String({ description: "起点のPO指示の引用と時刻" })),
      what: Type.String(),
      ask: Type.String(),
      actions: Type.Array(Action, { description: "2〜4つ" }),
      blocking: Type.Optional(Type.Number({ description: "止めている後続の数（並びに効く）" })),
      threadId: Type.Optional(Type.String()),
      canvasKind: Type.Optional(Type.String()),
      canvasParams: Type.Optional(OpenObject())
    }),
    async execute(p) {
      // 宛先を書かなかったら**この会話**。積んだ札から話の続きへ戻れるようにするため、
      // 「どの会話でもない札」を作らない（決定73）
      const threadId = p.threadId ?? options.threadId;
      const item = inbox.post({
        source: { id: p.sourceId, label: p.sourceLabel },
        kind: p.kind,
        ...(p.rule ? { rule: p.rule } : {}),
        title: p.title,
        ...(p.why ? { why: p.why } : {}),
        what: p.what,
        ask: p.ask,
        actions: p.actions,
        ...(p.blocking !== undefined ? { blocking: p.blocking } : {}),
        ...(threadId || p.canvasKind
          ? {
              opens: {
                ...(threadId ? { threadId } : {}),
                ...(p.canvasKind
                  ? { canvas: { kind: p.canvasKind, ...(p.canvasParams ? { params: p.canvasParams } : {}) } }
                  : {}),
              },
            }
          : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `取次に積みました（${item.id}）。POが答えるまで待ちます——この件は先に進めないでください。`,
          },
        ],
        details: { id: item.id },
      };
    },
  });

  const list = defineNamespacedTool({
    name: "inbox.list",
    label: "Inbox: List",
    description:
      "取次に積まれているものを見る。POが「何か待たせてる？」と訊いたときや、" +
      "自分が積んだものに答えが出たかを確かめるときに使う。",
    parameters: Type.Object({
      includeResolved: Type.Optional(Type.Boolean({ description: "答えの出たものも含める（既定は含めない）" })),
    }),
    async execute(p) {
      const items = inbox.list().filter((i) => (p.includeResolved === true ? true : !i.resolvedAt));
      const text =
        items.length === 0
          ? "取次は空です（POを待たせているものはありません）。"
          : items
              .map((i) => {
                const answered = i.resolvedAt ? `【答え: ${i.resolution}】` : "【判断待ち】";
                return `- ${answered} ${i.id} ${i.source.label} / ${i.kind}: ${i.title}\n    求める判断: ${i.ask}`;
              })
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { count: items.length } };
    },
  });

  const resolve = defineNamespacedTool({
    name: "inbox.resolve",
    label: "Inbox: Resolve",
    description:
      "取次の一通に答えを入れて畳む。**POが会話の中で答えたときにだけ**使う——" +
      "画面のボタンで答えたぶんは自動で畳まれるので、ここで二重に畳まない。",
    parameters: Type.Object({
      id: Type.String({ description: "一通の id（inbox.list で分かる）" }),
      action: Type.String({ description: "POが選んだ選択肢の id" }),
    }),
    async execute(p) {
      // I2: 知らない id・知らない選択肢は Inbox が例外にする。ここで握りつぶさない
      const item = inbox.resolve(p.id, p.action);
      return {
        content: [{ type: "text" as const, text: `「${item.title}」に「${p.action}」で答えが入りました。` }],
        details: { id: item.id },
      };
    },
  });

  return [post, list, resolve];
}
