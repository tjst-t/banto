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
import type { Inbox } from "./inbox.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "./tool-registry.js";

const Action = Type.Object({
  id: Type.String({ description: "押されたときに返る識別子（英数字）" }),
  label: Type.String({ description: "ボタンに出す言葉。POが押す前に何が起きるか分かる言い方で" }),
  tone: Type.Optional(
    Type.Union([Type.Literal("call"), Type.Literal("plain"), Type.Literal("quiet")], {
      description: "call=推し（朱で塗る）／plain=既定／quiet=控えめ。推しは1つまで",
    })
  ),
});

export function createInboxTools(inbox: Inbox): NamespacedToolDefinition[] {
  const post = defineNamespacedTool({
    name: "inbox.post",
    label: "Inbox: Post",
    description:
      "POの判断を取次（画面上段の受け口）へ積む。**自分では決められないものだけ**を積むこと——" +
      "D1（不可逆な選択）・D9（利用体験を変える本物のトレードオフ）・P3（仕様と実態の食い違い）に当たるもの。" +
      "それ以外は自分で決めて進める。" +
      "札は画面を遡らずに判断できる必要があるので、経緯・起きたこと・求める判断を必ず埋める。" +
      "会話や面を指定すると、POが押したときにそれらが同時に開く。",
    parameters: Type.Object({
      sourceId: Type.String({ description: "出所の機械名（banto / worker / kobo / env / github など）" }),
      sourceLabel: Type.String({ description: "出所の表示名（「職人 w-28」「Kobo（開発）」など）" }),
      kind: Type.String({ description: "種別の表示名（「後戻りできない」「番頭では決められない」など）" }),
      rule: Type.Optional(Type.String({ description: "よりどころの規則（D1 / D9 / P3 など）" })),
      title: Type.String({ description: "一行で言う問い。札の見出しになる" }),
      why: Type.Optional(Type.String({ description: "経緯：起点となったPOの指示の引用と時刻" })),
      what: Type.String({ description: "起きたこと：その後の経過と、判明した事実" }),
      ask: Type.String({ description: "求める判断：POに決めてほしいこと" }),
      actions: Type.Array(Action, { description: "その場で押せる答え。2〜4つ" }),
      blocking: Type.Optional(Type.Number({ description: "この判断が止めている後続の数。並び順に効く" })),
      threadId: Type.Optional(Type.String({ description: "押したときに移る会話" })),
      canvasKind: Type.Optional(Type.String({ description: "押したときにキャンバスに開く面の種別" })),
      canvasParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(p) {
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
        ...(p.threadId || p.canvasKind
          ? {
              opens: {
                ...(p.threadId ? { threadId: p.threadId } : {}),
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
