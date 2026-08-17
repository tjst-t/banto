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
import type { TaskContractAmendment } from "@banto/daemon";
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
   * 「この選択肢が押されたら、こう答えたことにする」を、実際に効く処理へ翻訳する口（決定113）。
   *
   * **番頭に `effect` そのものは書かせない**（決定73 が `inbox.post` に出していない理由）
   * ——書かせれば札を経由して任意の内部の口を叩けることになる。番頭が書けるのは
   * 「どの面の・どの選択肢がどの判断に当たるか」までで、呼ぶ先を決めるのはホスト。
   *
   * **承認専用にしない**（PO要望 2026-08-15）。運ぶのは「PO がどう答えたか」で、
   * 通す／戻すはその値でしかない。ここに Kobo の知識は無い（D5）
   * ——渡す側（`bin.ts`）が結線を持つ。
   *
   * @returns 結べないなら `undefined`（呼び出し側が理由を添えて断る）
   */
  resolvePoDecisionEffect?(input: {
    canvasKind?: string;
    canvasParams?: Record<string, unknown>;
    /** `approve`（通す）／`send_back`（差し戻す）／`amend`（改訂を適用する）。 */
    decision: string;
    /** 通すなら何を見て良しとしたか、戻すなら何が駄目でどう直すのか。 */
    detail?: string;
    /** `amend` のときに適用する契約の改訂（task-0273）。 */
    changes?: TaskContractAmendment;
  }): InboxEffect | undefined;
}

/**
 * 判断の届け先を読むのに足る面の kinds（`kobo.review` は通す／戻す、`kobo.amend` は改訂）。
 * どちらも `canvasParams` に `projectTag` / `taskId` を添えて初めて結べる。
 */
const PO_DECISION_CANVAS_KINDS = new Set(["kobo.review", "kobo.amend"]);
const PO_DECISION_PARAM_KEYS = ["projectTag", "taskId"] as const;

/**
 * 「結べない」を**名指しで**返す（task-0169）。
 *
 * 前の断り文は、`canvasKind` が無いのか・別の値なのか・`canvasParams` が無いのか・
 * `taskId` だけ欠けているのかを区別せず**全部同じ**だった。だから
 * 「添えているのに添えろと言われる」を3人が別々に踏んで、誰も原因に辿り着けなかった
 * （実際には引数が空になって届いていた）。**受け取った値をそのまま文言に出す**
 * ——次に踏んだ人がその場で「送ったはずのものが空で着いている」と気づける。
 */
function whyUnbindable(canvasKind: unknown, canvasParams: unknown): string {
  const forWhat = "——どのタスクの判断かが分からないと、POが押しても工場へ届きません。";
  if (canvasKind === undefined) {
    return `canvasKind を添えていません（"${[...PO_DECISION_CANVAS_KINDS].join('" か "')}" が要ります）${forWhat}`;
  }
  if (typeof canvasKind !== "string" || !PO_DECISION_CANVAS_KINDS.has(canvasKind)) {
    return (
      `canvasKind が "${[...PO_DECISION_CANVAS_KINDS].join('" か "')}" ではありません` +
      `（受け取った値: ${JSON.stringify(canvasKind)}）${forWhat}`
    );
  }
  if (canvasParams === undefined) {
    return `canvasParams を添えていません（{projectTag, taskId} が要ります）${forWhat}`;
  }
  if (typeof canvasParams !== "object" || canvasParams === null || Array.isArray(canvasParams)) {
    return `canvasParams が object ではありません（受け取った値: ${JSON.stringify(canvasParams)}）${forWhat}`;
  }
  const params = canvasParams as Record<string, unknown>;
  const missing = PO_DECISION_PARAM_KEYS.filter(
    (key) => typeof params[key] !== "string" || (params[key] as string).length === 0
  );
  if (missing.length > 0) {
    return (
      `${missing.map((key) => `canvasParams.${key}`).join(" / ")} が空です` +
      `（受け取った canvasParams: ${JSON.stringify(params)}）${forWhat}`
    );
  }
  // 欄は揃っているのに結べない＝結線の側の話。番頭が書き直しても直らないので、そう言う
  return (
    `canvasKind / canvasParams は揃っています（受け取った canvasParams: ${JSON.stringify(params)}）が、` +
    "ホストが判断の届け先を決められませんでした。書き直しでは直りません。"
  );
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
      // 開いた object なので中身は数え上げない（決定84-3）。ただし approveAction を
      // 結ぶには決まった2つが要るので、そこだけ1行で言う
      canvasParams: Type.Optional(
        OpenObject({ description: 'canvasKind: "kobo.review" または "kobo.amend" なら {projectTag, taskId}' })
      ),
      approveAction: Type.Optional(
        Type.String({
          description:
            "「そのまま通してよい」に当たる選択肢の id。" +
            'canvasKind: "kobo.review" と canvasParams: {projectTag, taskId} を添えたときだけ効く。' +
            "POがこれを押すと、そのタスクが工場で PO 承認まで進む（あなたは押せません・決定57）。",
        })
      ),
      sendBackAction: Type.Optional(
        Type.String({
          description:
            "「実装へ差し戻す」に当たる選択肢の id。approveAction と対で書く" +
            "——通す側だけ結ぶと、POは「駄目だ」を押しても何も起きない。",
        })
      ),
      sendBackReason: Type.Optional(
        Type.String({
          description:
            "差し戻すときに職人へ渡す指摘（sendBackAction と対で必須）。" +
            "**何が駄目で、どう直すのか**。POが選択肢を押しただけで伝わる文にすること。",
        })
      ),
      amendAction: Type.Optional(
        Type.String({
          description:
            "「この改訂を適用してよい」に当たる選択肢の id（task-0273）。" +
            'canvasKind: "kobo.amend" と canvasParams: {projectTag, taskId} と' +
            " amendChanges を添えたときだけ効く。POがこれを押すと、緩める向きの契約改訂が" +
            " 工場で PO 承認（daemon.amendTask by: \"po\"）として適用される（あなたは押せません）。",
        })
      ),
      amendChanges: Type.Optional(
        OpenObject({
          description:
            'amendAction と対で、適用する契約の改訂（title / body / scope.paths / acceptance / environment / model_tier / review）。',
        })
      ),
      amendReason: Type.Optional(
        Type.String({
          description: "amendAction と対で、なぜ直すのか（帳簿に残る理由）。",
        })
      ),
    }),
    async execute(p) {
      // 宛先を書かなかったら**この会話**。積んだ札から話の続きへ戻れるようにするため、
      // 「どの会話でもない札」を作らない（決定73）
      const threadId = p.threadId ?? options.threadId;

      /**
       * 「押されたら、こう答えたことにする」を結ぶ（決定113）。
       *
       * I2: 結べないのに黙って積まない——PO が押しても何も起きない札が出来るのが
       *     imp-0034 そのもの。どこが足りないかを添えて、その場で断る。
       */
      let actions = p.actions as InboxAction[];
      const bind = (
        actionId: string,
        field: string,
        decision: string,
        detail?: string,
        changes?: TaskContractAmendment
      ): void => {
        const target = actions.find((a) => a.id === actionId);
        if (!target) {
          throw new Error(
            `${field} "${actionId}" は actions にありません` +
              `（${actions.map((a) => a.id).join(" / ")}）。`
          );
        }
        const effect = options.resolvePoDecisionEffect?.({
          ...(p.canvasKind !== undefined ? { canvasKind: p.canvasKind } : {}),
          ...(p.canvasParams !== undefined
            ? { canvasParams: p.canvasParams as Record<string, unknown> }
            : {}),
          decision,
          ...(detail ? { detail } : {}),
          ...(changes ? { changes } : {}),
        });
        if (!effect) {
          throw new Error(`${field} を結べません。${whyUnbindable(p.canvasKind, p.canvasParams)}`);
        }
        actions = actions.map((a) => (a.id === target.id ? { ...a, effect } : a));
      };

      if (p.approveAction !== undefined) bind(p.approveAction, "approveAction", "approve");
      if (p.sendBackAction !== undefined) {
        // I2: 理由の無い差し戻しは職人に何も伝わらない。積む時点で断る
        if (!p.sendBackReason?.trim()) {
          throw new Error(
            "sendBackAction には sendBackReason（何が駄目で、どう直すのか）が要ります" +
              "——POが押したときに職人へそのまま渡ります。"
          );
        }
        bind(p.sendBackAction, "sendBackAction", "send_back", p.sendBackReason.trim());
      }
      if (p.amendAction !== undefined) {
        // I2: 中身の無い改訂の承認は何も変えない。積む時点で断る
        if (
          !p.amendChanges ||
          typeof p.amendChanges !== "object" ||
          Array.isArray(p.amendChanges)
        ) {
          throw new Error(
            "amendAction には amendChanges（適用する契約の改訂）が要ります" +
              "——POが押しても何も変えられない札にはしない。"
          );
        }
        bind(p.amendAction, "amendAction", "amend", p.amendReason?.trim() || "PO が改訂を承認", p.amendChanges as TaskContractAmendment);
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
