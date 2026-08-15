/**
 * 取次の札で PO が出した答えを、**PO の権限のまま工場へ届ける橋**（ADR-0023 決定113）。
 *
 * **困っていたこと**（imp-0034・dentaku task-0007 で実地に踏んだ）。`review: po` のタスクは
 * 決定57 により番頭が通せない。番頭は `inbox.post`（`canvasKind: "kobo.review"`）で PO に
 * 判断を仰ぎ、PO は札の選択肢を押して答える——**ところがその答えは工場へ一切流れなかった**。
 *
 *   - PO は札に「通す（マージへ）」と答えた
 *   - 工場の状態は `review-ready` のまま。イベントが1本も増えない
 *   - 番頭が `kobo.approve` を呼ぶと 500（「番頭は通せません」）
 *
 * **三すくみ**で、そのタスクは永久に動かない。
 *
 * **直し方は口を増やすことではない。** PO 専用の口は工場の HTTP 面に既にある
 * （`POST {koboUrl}/projects/:proj/tasks/:id/po-decision`）。足りなかったのは
 * **札の回答からそこへ至る結線**だけで、ここがそれ。
 *
 * **承認専用にしない**（PO要望 2026-08-15）。橋が運ぶのは「PO がどう答えたか」であって
 * 承認ではない——差し戻しも同じ橋を渡る。`kobo.amend` のように `by: "banto"` を直書き
 * している道具も、`decision` を1つ足せば同じ橋に乗せられる。
 *
 * **決定57 はどこで守られるか**：
 *
 *   - この Tool は `internalTools` に入る。`ModuleRegistry.tools()` は `module.tools` しか
 *     返さないので、**番頭（LLM）の在庫にも提示にも載らない**——モデルからは呼べない
 *   - 番頭に渡っている `kobo.approve` は今までどおり `by: "banto"` しか渡さず、
 *     `po` 段のタスクを断り続ける（`Daemon.approveTask`）
 *   - 押すのは PO。ホストは `InboxEffect` として**押されたときにだけ**呼ぶ
 *   - 誰の・どの札のどの回答で動いたかは `via` として工場の帳簿に残る
 *
 * D5: 判断は無い。通せるか・戻せるかを決めるのは工場（レビュー段の判定を持つ）。
 * D6: node の fetch のみ。
 */

import { Type } from "typebox";
import { StringEnum, defineNamespacedTool, type NamespacedToolDefinition } from "@banto/core";
import type { InboxEffect } from "./inbox.js";

/** 工場が出しているレビュー面の kind。この札だけが工場の判断へ結ばれる。 */
export const KOBO_REVIEW_CANVAS_KIND = "kobo.review";

/** PO の判断を届ける口の論理名（番頭には渡さない）。 */
export const KOBO_PO_DECIDE_TOOL = "kobo.po_decide";

/** `originArg` に使う名前。工場の帳簿へ `via` として残る。 */
const VIA_ARG = "via";

/** 橋が運べる判断。増やすときは工場の口（`po-decision`）と対で足す。 */
export type KoboPoDecision = "approve" | "send_back";

/**
 * 札に添えられた面の指定から、判断を届ける先のタスクを読む。
 *
 * `canvasParams` は `kobo.review` の面がそのまま受け取るもの（`projectTag` / `taskId`）。
 * **D3: 別に持たない**——札に既に載っている値を使い、番頭に同じことを二度書かせない。
 */
export function koboReviewTarget(
  canvasKind: string | undefined,
  canvasParams: Record<string, unknown> | undefined
): { projectTag: string; taskId: string } | undefined {
  if (canvasKind !== KOBO_REVIEW_CANVAS_KIND) return undefined;
  const projectTag = canvasParams?.["projectTag"];
  const taskId = canvasParams?.["taskId"];
  if (typeof projectTag !== "string" || !projectTag) return undefined;
  if (typeof taskId !== "string" || !taskId) return undefined;
  return { projectTag, taskId };
}

/**
 * 「この選択肢が押されたら、工場へこう答える」を表す効果を作る。
 *
 * 番頭が書けるのは**どの選択肢がどの判断に当たるか**だけで、呼ぶ先はここが決める
 * ——`InboxEffect` をそのまま番頭に書かせると、札を経由して任意の内部の口を
 * 叩けることになる（決定73 が `inbox.post` に `effect` を出していない理由）。
 */
export function koboPoDecisionEffect(
  target: { projectTag: string; taskId: string },
  decision: KoboPoDecision,
  detail?: string
): InboxEffect {
  return {
    module: "kobo",
    tool: KOBO_PO_DECIDE_TOOL,
    args: {
      projectTag: target.projectTag,
      taskId: target.taskId,
      decision,
      // 差し戻しの理由は職人にそのまま渡る。承認の note も同じ場所に入る
      ...(detail ? { detail } : {}),
    },
    // 出どころ（`in-xxxxxxxx#approve`）は押された時にホストが埋める
    originArg: VIA_ARG,
  };
}

/**
 * 工場の PO 専用の口を叩くだけの口（番頭には渡さない）。
 *
 * `{koboUrl}` は `http://127.0.0.1:4500/api/kobo` の形。Tool の名前空間（`/tools/*`）の
 * **外**にある面なので、番頭ホストの中継（`createRemoteRelay`）はここを通す一方、
 * 写しの `execute` が呼ぶ `/tools/*` とは経路が分かれている。
 *
 * I2: 届かない・断られたことを「効いた」で包まない。理由をそのまま投げ、
 *     取次は札を畳まない（PO はもう一度押せる）。
 */
export function createKoboPoDecisionTool(
  koboUrl: string,
  fetchImpl: typeof fetch = fetch
): NamespacedToolDefinition {
  return defineNamespacedTool({
    name: KOBO_PO_DECIDE_TOOL,
    label: "Kobo: PO の判断を届ける",
    description:
      "PO が画面で押した判断（通す／差し戻す）を工場の帳簿へ書く（`by: \"po\"`）。" +
      "**番頭には渡さない**——決定57 により、PO 必須のタスクを通せるのは PO 本人の操作だけ。",
    parameters: Type.Object({
      projectTag: Type.String(),
      taskId: Type.String(),
      decision: StringEnum(["approve", "send_back"] as const),
      [VIA_ARG]: Type.String({ description: "どの札のどの回答から来た判断か" }),
      detail: Type.Optional(
        Type.String({
          description: "通すなら何を見て良しとしたか、戻すなら何が駄目でどう直すのか",
        })
      ),
    }),
    async execute(params) {
      const url =
        `${koboUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(params.projectTag)}` +
        `/tasks/${encodeURIComponent(params.taskId)}/po-decision`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: params.decision,
          via: params[VIA_ARG],
          // 通すときは判断の記録（note）、戻すときは職人へ渡す指摘（reason）
          ...(params.detail
            ? params.decision === "approve"
              ? { note: params.detail }
              : { reason: params.detail }
            : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        state?: string;
      };
      if (!res.ok) {
        throw new Error(
          `工場が ${params.taskId} の判断を受け付けませんでした: ` +
            `${body.message ?? body.error ?? res.statusText}`
        );
      }
      const state = body.state ?? (params.decision === "approve" ? "approved" : "implementing");
      return {
        content: [
          {
            type: "text" as const,
            text:
              params.decision === "approve"
                ? `${params.projectTag}/${params.taskId} を PO として通しました` +
                  `（いまの状態: ${state}）。この後マージ前ゲートが回ります。`
                : `${params.projectTag}/${params.taskId} を PO として差し戻しました` +
                  `（いまの状態: ${state}）。指摘は職人へ渡してあります。`,
          },
        ],
        details: { taskId: params.taskId, decision: params.decision, state },
      };
    },
  }) as NamespacedToolDefinition;
}
