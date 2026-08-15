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
import type { Inbox, InboxAction, InboxEffect } from "./inbox.js";
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
  /**
   * 「この選択肢が押されたら通してよい」を、実際に効く処理へ翻訳する口（決定113）。
   *
   * **番頭に `effect` そのものは書かせない**（決定73 が `inbox.post` に出していない理由）
   * ——書かせれば札を経由して任意の内部の口を叩けることになる。番頭が書けるのは
   * 「どの面の・どの選択肢が承認に当たるか」までで、呼ぶ先を決めるのはホスト。
   *
   * ここに Kobo の知識は無い（D5）。渡す側（`bin.ts`）が結線を持つ。
   *
   * @returns 結べないなら `undefined`（呼び出し側が理由を添えて断る）
   */
  resolveApproveEffect?(input: {
    canvasKind?: string;
    canvasParams?: Record<string, unknown>;
  }): InboxEffect | undefined;
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
      canvasParams: Type.Optional(OpenObject()),
      approveAction: Type.Optional(
        Type.String({
          description:
            "「そのまま通してよい」に当たる選択肢の id。" +
            'canvasKind: "kobo.review" と canvasParams: {projectTag, taskId} を添えたときだけ効く。' +
            "POがこれを押すと、そのタスクが工場で PO 承認まで進む（あなたは押せません・決定57）。",
        })
      ),
    }),
    async execute(p) {
      // 宛先を書かなかったら**この会話**。積んだ札から話の続きへ戻れるようにするため、
      // 「どの会話でもない札」を作らない（決定73）
      const threadId = p.threadId ?? options.threadId;

      /**
       * 「押されたら通す」を結ぶ（決定113）。
       *
       * I2: 結べないのに黙って積まない——PO が押しても何も起きない札が出来るのが
       *     imp-0034 そのもの。どこが足りないかを添えて、その場で断る。
       */
      let actions = p.actions as InboxAction[];
      if (p.approveAction !== undefined) {
        const target = actions.find((a) => a.id === p.approveAction);
        if (!target) {
          throw new Error(
            `approveAction "${p.approveAction}" は actions にありません` +
              `（${actions.map((a) => a.id).join(" / ")}）。`
          );
        }
        const effect = options.resolveApproveEffect?.({
          ...(p.canvasKind !== undefined ? { canvasKind: p.canvasKind } : {}),
          ...(p.canvasParams !== undefined
            ? { canvasParams: p.canvasParams as Record<string, unknown> }
            : {}),
        });
        if (!effect) {
          throw new Error(
            "approveAction を結べません。" +
              'canvasKind: "kobo.review" と canvasParams: {projectTag, taskId} を添えてください' +
              "——どのタスクの承認かが札に載っていないと、POが押しても工場へ届きません。"
          );
        }
        actions = actions.map((a) => (a.id === target.id ? { ...a, effect } : a));
      }

      const item = inbox.post({
        source: { id: p.sourceId, label: p.sourceLabel },
        kind: p.kind,
        ...(p.rule ? { rule: p.rule } : {}),
        title: p.title,
        ...(p.why ? { why: p.why } : {}),
        what: p.what,
        ask: p.ask,
        actions,
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
      "画面のボタンで答えたぶんは自動で畳まれるので、ここで二重に畳まない。" +
      "処理を伴う選択肢（工場の承認など）はここでは畳めない——POが画面で押す必要がある。",
    parameters: Type.Object({
      id: Type.String({ description: "一通の id（inbox.list で分かる）" }),
      action: Type.String({ description: "POが選んだ選択肢の id" }),
    }),
    async execute(p) {
      /**
       * **処理を伴う選択肢はここでは畳めない**（決定113）。
       *
       * 効果を走らせるのは画面から押されたときだけ（`BantoHostServer.handleInbox`）で、
       * ここで畳めてしまうと2つのことが起きる——効果が走らないまま「答えが出た」札に
       * なり、POが後から押しても「既に答えが出ています」で断られる。承認のように
       * 番頭には通せないものは、**畳む口からも遠ざけておく**（決定57）。
       *
       * I2: 知らない id は `inbox.get` が undefined を返すので、そのまま
       *     `inbox.resolve` に投げさせて理由の出所を1つにする。
       */
      const pending = inbox.get(p.id);
      if (pending?.actions.find((a) => a.id === p.action)?.effect) {
        throw new Error(
          `「${pending.title}」の "${p.action}" は処理を伴う選択肢です。` +
            "あなたは畳めません——POが画面で押すまで待ってください（決定57・111）。"
        );
      }
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
